// IndexWalker.cs — indexWindow 核心遍历：把一棵窗口子树展平成「可交互或有名」的元素索引。
// 复杂度与耗时预算（目标：典型 Office 窗口单次 <300ms）：
//   · 每个访问节点：1 次 Current（Name/Class/AutomationId/BoundingRectangle/Focus 等打包内嵌读）
//     + 1 次 FindAll(Children)（整层子节点批量拉取，非逐节点往返）。
//   · 每个保留节点：1 次 GetSupportedPatterns 拿全 pattern（替代 7 次 TryGetCurrentPattern），
//     仅对实际支持的 pattern 再各取一次当前值（toggleState/value/selected/expanded/rangeValue）。
//   · 访问预算 visitBudget = maxNodes*6（结构:保留 ≈ 5:1 的经验值），到线即停并置 truncated，
//     跨进程往返数有硬上界（默认 800 → ≤4800 次），不会因畸形大树卡死侧车。
using System;
using System.Collections.Generic;
using System.Text;
using System.Windows;
using System.Windows.Automation;

namespace UiaSidecar
{
    /// <summary>单个元素的全部索引字段（ID 寻址的完整性是"精准"的前提，见 IndexWindowActions 响应注释）。</summary>
    public sealed class ElementRecord
    {
        public string RuntimeId = "";
        public string Name = "";
        public string ControlType = "";
        public string ClassName = "";
        public string AutomationId = "";
        public string Path = "";
        public bool HasRect;
        public double X, Y, W, H;
        public bool Enabled = true, Offscreen, Focused, Focusable;
        public bool IsWindow;
        // patterns：bool 恒输出；可选项用 <0/空串表示"不适用"
        public bool Invoke, Toggle, Scroll, SelectionItem, ExpandCollapse, HasRangeValue, HasValue;
        public bool IsPasswordControl;         // cur.IsPassword：密码框不读取/输出 Value
        public int ToggleState = -1;      // 0 Off / 1 On / 2 Indeterminate
        public string Value = "";
        public bool Selected;
        public int Expanded = -1;         // 0 Collapsed / 1 Expanded / 2 部分展开等
        public double RvMin, RvMax, RvValue;
        public bool Interactive;          // 修剪优先保留依据（有名纯展示节点=false）
        public int Ref;
    }

    public sealed class IndexWalker
    {
        private readonly HashSet<int> _exclude;
        private readonly int _maxNodes;
        private readonly int _maxDepth;
        private readonly int _visitBudget;
        private readonly IntPtr _hostHwnd; // 记入 RuntimeIdCache：resolveRefs 缺省 hwnd 时的重扫作用域
        private int _visited;
        public bool Truncated;
        public readonly List<ElementRecord> Kept = new List<ElementRecord>();

        /// 与 Collector.ShouldKeep 同源的可交互 controlType 口径（短名）。
        private static readonly HashSet<string> InteractiveTypes = new HashSet<string>(StringComparer.Ordinal)
        {
            "Button", "Edit", "ComboBox", "ListItem", "MenuItem", "CheckBox", "RadioButton",
            "TabItem", "Hyperlink", "TreeItem", "DataItem", "Custom", "Window", "Document",
            "Spinner", "SplitButton", "HeaderItem", "List", "Tree", "DataGrid",
        };

        /// 纯结构容器（占树大头）：不查 pattern，省一次跨进程往返；其有名子节点仍按名字保留。
        private static readonly HashSet<string> SkipPatternTypes = new HashSet<string>(StringComparer.Ordinal)
        {
            "Pane", "Group", "Text", "Image", "Separator", "Header",
        };

        public IndexWalker(HashSet<int> exclude, int maxNodes, int maxDepth, IntPtr hostHwnd)
        {
            _exclude = exclude;
            _maxNodes = maxNodes;
            _maxDepth = maxDepth;
            _visitBudget = maxNodes * 6;
            _hostHwnd = hostHwnd;
        }

        /// <summary>索引一个窗口子树（root 自身恒保留——它是 path 的第一段与窗口元数据来源）。</summary>
        public void WalkWindow(AutomationElement window)
        {
            Kept.Clear();
            Truncated = false;
            var ancestors = new List<string>();
            Visit(window, 0, ancestors, true);
            Prune();
        }

        private void Visit(AutomationElement el, int depth, List<string> ancestors, bool isRoot)
        {
            if (_visited >= _visitBudget) { Truncated = true; return; }
            _visited++;
            AutomationElement.AutomationElementInformation cur;
            try { cur = el.Current; } catch { return; }
            if (_exclude != null && _exclude.Contains(cur.ProcessId)) return; // 自我污染/指定进程整枝剪掉

            string ct = ShortType(cur.ControlType);
            bool keep = isRoot || InteractiveTypes.Contains(ct)
                || !string.IsNullOrEmpty(cur.Name) || !string.IsNullOrEmpty(cur.AutomationId);
            ElementRecord rec = null;
            if (keep)
            {
                rec = BuildRecord(el, cur, ct, ancestors);
                if (Kept.Count < _maxNodes * 2) Kept.Add(rec);
                else Truncated = true;
            }
            if (depth >= _maxDepth) return;

            ancestors.Add(LabelFor(rec, cur, ct));
            try
            {
                var children = el.FindAll(TreeScope.Children, Condition.TrueCondition);
                if (children.Count <= 400)
                {
                    foreach (AutomationElement child in children)
                    {
                        if (_visited >= _visitBudget) { Truncated = true; break; }
                        Visit(child, depth + 1, ancestors, false);
                    }
                }
            }
            catch { /* 子树 provider 挂死：该分支终止，其余窗口/节点不受影响 */ }
            ancestors.RemoveAt(ancestors.Count - 1);
        }

        /// <summary>path 段标签：优先可读 Name，无名退化为短类型；单段截 24 字防长标题撑爆 token。</summary>
        private static string LabelFor(ElementRecord rec, AutomationElement.AutomationElementInformation cur, string ct)
        {
            string s = rec != null && rec.Name.Length > 0 ? rec.Name : (cur.Name ?? "");
            if (s.Length == 0) s = ct;
            return s.Length > 24 ? s.Substring(0, 24) : s;
        }

        private ElementRecord BuildRecord(AutomationElement el, AutomationElement.AutomationElementInformation cur, string ct, List<string> ancestors)
        {
            var r = new ElementRecord();
            r.RuntimeId = RuntimeIdCache.KeyOf(el);
            r.Name = cur.Name ?? "";
            r.ClassName = cur.ClassName ?? "";
            r.AutomationId = cur.AutomationId ?? "";
            r.ControlType = ct;
            r.IsWindow = cur.ControlType == ControlType.Window;
            r.IsPasswordControl = cur.IsPassword;
            r.Enabled = cur.IsEnabled;
            r.Offscreen = cur.IsOffscreen;
            r.Focused = cur.HasKeyboardFocus;
            r.Focusable = cur.IsKeyboardFocusable;
            var rect = cur.BoundingRectangle;
            if (!rect.IsEmpty && !double.IsNaN(rect.Width) && !double.IsNaN(rect.Height))
            {
                r.HasRect = true;
                r.X = rect.X; r.Y = rect.Y; r.W = rect.Width; r.H = rect.Height;
            }
            r.Path = BuildPath(ancestors, r.Name, ct);
            ExtractPatterns(el, r);
            r.Interactive = r.Invoke || r.Toggle || r.SelectionItem || r.ExpandCollapse || r.Scroll
                || InteractiveTypes.Contains(ct);
            RuntimeIdCache.Remember(el, _hostHwnd); // resolveRefs 快速路径 + 来源窗口记录的喂料
            return r;
        }

        /// <summary>祖先链可读路径，深度截断：最多 6 段（保留尾部，root 段在截断后仍常见）。</summary>
        private static string BuildPath(List<string> ancestors, string name, string ct)
        {
            const int MaxSegs = 6;
            int skip = ancestors.Count + 1 - MaxSegs;
            if (skip < 0) skip = 0;
            var sb = new StringBuilder();
            for (int i = skip; i < ancestors.Count; i++)
            {
                if (sb.Length > 0) sb.Append('/');
                sb.Append(ancestors[i]);
            }
            if (sb.Length > 0) sb.Append('/');
            string self = name.Length == 0 ? ct : (name.Length > 24 ? name.Substring(0, 24) : name);
            sb.Append(self);
            return sb.ToString();
        }

        /// <summary>一次 GetSupportedPatterns 定 bool；仅对支持的 pattern 追问当前值（跨进程往返按量付费）。</summary>
        private static void ExtractPatterns(AutomationElement el, ElementRecord r)
        {
            if (!r.IsWindow && SkipPatternTypes.Contains(r.ControlType)) return;
            AutomationPattern[] pats;
            try { pats = el.GetSupportedPatterns(); }
            catch { return; }
            foreach (AutomationPattern p in pats)
            {
                if (p.Id == InvokePattern.Pattern.Id) { r.Invoke = true; continue; }
                if (p.Id == TogglePattern.Pattern.Id)
                {
                    r.Toggle = true;
                    try { r.ToggleState = (int)((TogglePattern)el.GetCurrentPattern(p)).Current.ToggleState; } catch { }
                    continue;
                }
                if (p.Id == ValuePattern.Pattern.Id)
                {
                    r.HasValue = true;
                    // 密码框（cur.IsPassword）不读取值：防凭据进模型上下文（ValuePatternInformation 无 IsPassword，判据在元素层）
                    if (!r.IsPasswordControl)
                    {
                        try
                        {
                            var vp = (ValuePattern)el.GetCurrentPattern(p);
                            r.Value = Trunc(vp.Current.Value ?? "", 120); // 截断防文档全文爆包
                        }
                        catch { }
                    }
                    continue;
                }
                if (p.Id == ScrollPattern.Pattern.Id) { r.Scroll = true; continue; }
                if (p.Id == SelectionItemPattern.Pattern.Id)
                {
                    r.SelectionItem = true;
                    try { r.Selected = ((SelectionItemPattern)el.GetCurrentPattern(p)).Current.IsSelected; } catch { }
                    continue;
                }
                if (p.Id == ExpandCollapsePattern.Pattern.Id)
                {
                    r.ExpandCollapse = true;
                    try
                    {
                        var st = (int)((ExpandCollapsePattern)el.GetCurrentPattern(p)).Current.ExpandCollapseState;
                        r.Expanded = st == (int)ExpandCollapseState.Collapsed ? 0 : st == (int)ExpandCollapseState.Expanded ? 1 : 2;
                    }
                    catch { }
                    continue;
                }
                if (p.Id == RangeValuePattern.Pattern.Id)
                {
                    r.HasRangeValue = true;
                    try
                    {
                        var rv = ((RangeValuePattern)el.GetCurrentPattern(p)).Current;
                        r.RvMin = rv.Minimum; r.RvMax = rv.Maximum; r.RvValue = rv.Value;
                    }
                    catch { }
                }
            }
        }

        /// <summary>超限修剪（"优先保留可交互项"）：交互节点按文档序先入选，剩余名额给有名展示节点。</summary>
        private void Prune()
        {
            if (Kept.Count <= _maxNodes) return;
            Truncated = true;
            var ordered = new List<ElementRecord>(_maxNodes);
            for (int i = 0; i < Kept.Count && ordered.Count < _maxNodes; i++)
                if (Kept[i].Interactive) ordered.Add(Kept[i]);
            for (int i = 0; i < Kept.Count && ordered.Count < _maxNodes; i++)
                if (!Kept[i].Interactive) ordered.Add(Kept[i]);
            Kept.Clear();
            Kept.AddRange(ordered);
        }

        private static string ShortType(ControlType t)
        {
            try
            {
                var s = t.ProgrammaticName ?? t.ToString();
                int dot = s.LastIndexOf('.');
                return dot >= 0 ? s.Substring(dot + 1) : s;
            }
            catch { return "Unknown"; }
        }

        private static string Trunc(string s, int max)
        {
            return s.Length > max ? s.Substring(0, max) : s;
        }

        /// <summary>Element → NDJSON（字段口径见交付注释；缺矩形的离屏/0 尺寸节点省略 rect/center）。</summary>
        public static void AppendElementJson(StringBuilder sb, ElementRecord r)
        {
            sb.Append("{\"ref\":").Append(r.Ref.ToString(System.Globalization.CultureInfo.InvariantCulture));
            sb.Append(",\"runtimeId\":\"").Append(Json.Escape(r.RuntimeId)).Append('"');
            sb.Append(",\"name\":\"").Append(Json.Escape(r.Name)).Append('"');
            sb.Append(",\"controlType\":\"").Append(Json.Escape(r.ControlType)).Append('"');
            sb.Append(",\"className\":\"").Append(Json.Escape(r.ClassName)).Append('"');
            sb.Append(",\"automationId\":\"").Append(Json.Escape(r.AutomationId)).Append('"');
            if (r.HasRect)
            {
                sb.Append(",\"rect\":{\"x\":").Append(Json.Num(r.X)).Append(",\"y\":").Append(Json.Num(r.Y))
                  .Append(",\"w\":").Append(Json.Num(r.W)).Append(",\"h\":").Append(Json.Num(r.H)).Append('}');
                sb.Append(",\"center\":{\"x\":").Append(Json.Num(r.X + r.W / 2.0))
                  .Append(",\"y\":").Append(Json.Num(r.Y + r.H / 2.0)).Append('}');
            }
            sb.Append(",\"enabled\":").Append(r.Enabled ? "true" : "false");
            sb.Append(",\"offscreen\":").Append(r.Offscreen ? "true" : "false");
            sb.Append(",\"focused\":").Append(r.Focused ? "true" : "false");
            sb.Append(",\"focusable\":").Append(r.Focusable ? "true" : "false");
            sb.Append(",\"patterns\":{\"invoke\":").Append(r.Invoke ? "true" : "false");
            sb.Append(",\"toggle\":").Append(r.Toggle ? "true" : "false");
            sb.Append(",\"scroll\":").Append(r.Scroll ? "true" : "false");
            sb.Append(",\"selectionItem\":").Append(r.SelectionItem ? "true" : "false");
            sb.Append(",\"expandCollapse\":").Append(r.ExpandCollapse ? "true" : "false");
            if (r.Toggle && r.ToggleState >= 0) sb.Append(",\"toggleState\":").Append(r.ToggleState);
            if (r.Value.Length > 0) sb.Append(",\"value\":\"").Append(Json.Escape(r.Value)).Append('"');
            if (r.SelectionItem) sb.Append(",\"selected\":").Append(r.Selected ? "true" : "false");
            if (r.Expanded == 0 || r.Expanded == 1) sb.Append(",\"expanded\":").Append(r.Expanded == 1 ? "true" : "false");
            if (r.HasRangeValue)
            {
                sb.Append(",\"rangeValue\":{\"min\":").Append(Json.Num(r.RvMin))
                  .Append(",\"max\":").Append(Json.Num(r.RvMax))
                  .Append(",\"value\":").Append(Json.Num(r.RvValue)).Append('}');
            }
            sb.Append('}');
            sb.Append(",\"path\":\"").Append(Json.Escape(r.Path)).Append("\"}");
        }
    }
}
