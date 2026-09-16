// IndexWindowActions.cs — 两个新动作的 RPC 入口（NDJSON 单行协议，与现有动作同错误帧模式）。
//
// indexWindow  {pid?, hwnd?, maxNodes?, excludePids?}
//   → {ok, signature, ms, truncated, windows:[{hwnd,title,className,pid,elements:[Element]}]}
//   Element = {ref, runtimeId, name, controlType, className, automationId, rect{x,y,w,h}, center{x,y},
//              enabled, offscreen, focused, focusable, patterns{invoke,toggle,scroll,selectionItem,
//              expandCollapse,toggleState?,value?,selected?,expanded?,rangeValue?}, path}
//   · pid → 该进程全部可见顶层窗口（不只前台）；hwnd → 仅该窗口；都缺省 → 前台窗口。
//   · excludePids → 遍历整枝剪掉这些 pid 的窗口与子树；侧车自身 pid 恒内置排除（自我污染防线）。
//   · signature = SHA1(ref 序列的 runtimeId|name|controlType|rect 量化(4px))，上层据此判断增量刷新。
//   · ref 为响应内全局稳定序号（1 起，跨窗口连续），模型用 #ref 寻址。
//
// resolveRefs  {items:[{hwnd?, runtimeId}]}
//   → {ok, resolved:[{runtimeId, ok, rect?, center?, enabled?, offscreen?}]}
//   · 执行前用 runtimeId 重新解析"当前"矩形（缓存不能骗人）：先查进程级 RuntimeIdCache
//     （命中即读活 Current，元素移动后矩形自动更新），失效/未命中按作用域窗口有界重扫：
//     作用域 = 请求里的 hwnd，缺省用索引时记录的来源窗口；两者都拿不到 → ok:false（禁止全桌面扫）。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Windows.Automation;

namespace UiaSidecar
{
    public static class IndexWindowActions
    {
        /// <summary>侧车自身 pid：任何树遍历都必须排除（getUiTree / indexWindow 共用）。</summary>
        public static readonly int OwnPid = Process.GetCurrentProcess().Id;

        private const int DEFAULT_MAX_NODES = 800;
        private const int MAX_DEPTH = 12;       // 与 getUiTree 钳制口径一致
        private const int RESOLVE_VISIT_CAP = 4000;
        private const int MAX_RESOLVE_ITEMS = 100;

        /// <summary>excludePids 参数 + 内置侧车 pid。</summary>
        public static HashSet<int> ParseExcludePids(string payload)
        {
            var set = new HashSet<int>(JsonExtract.IntArray(payload, "excludePids"));
            set.Add(OwnPid);
            return set;
        }

        // ---------- indexWindow ----------

        public static string IndexWindow(string payload)
        {
            try
            {
                var started = DateTime.UtcNow;
                int pid = JsonExtract.IntParam(payload, "pid", 0);
                long hwnd = JsonExtract.LongParam(payload, "hwnd", 0);
                int maxNodes = Math.Max(50, Math.Min(2000, JsonExtract.IntParam(payload, "maxNodes", DEFAULT_MAX_NODES)));
                var exclude = ParseExcludePids(payload);
                var targets = WindowEnumerator.Collect(pid, hwnd, exclude);
                if (targets.Count == 0)
                    return "{\"ok\":false,\"error\":\"no visible window (pid/hwnd not found or in excludePids)\"}";

                var perWindow = new List<List<ElementRecord>>(targets.Count);
                var all = new List<ElementRecord>();
                bool truncated = false;
                foreach (var t in targets)
                {
                    int remaining = maxNodes - all.Count;
                    if (remaining < 20) { truncated = true; break; } // 多窗口共享响应预算，剩余不足即截断
                    var walker = new IndexWalker(exclude, remaining, MAX_DEPTH, t.Hwnd);
                    walker.WalkWindow(t.Element);
                    if (walker.Truncated) truncated = true;
                    foreach (var rec in walker.Kept) rec.Ref = all.Count + 1; // ref 跨窗口连续、响应内稳定
                    all.AddRange(walker.Kept);
                    perWindow.Add(walker.Kept);
                }

                var sb = new StringBuilder(all.Count * 220 + 256);
                sb.Append("{\"ok\":true,\"signature\":\"").Append(Signature(all)).Append('"');
                sb.Append(",\"ms\":").Append((long)(DateTime.UtcNow - started).TotalMilliseconds);
                sb.Append(",\"truncated\":").Append(truncated ? "true" : "false");
                sb.Append(",\"windows\":[");
                for (int w = 0; w < targets.Count && w < perWindow.Count; w++)
                {
                    if (w > 0) sb.Append(',');
                    AppendWindowJson(sb, targets[w], perWindow[w]);
                }
                sb.Append("]}");
                return sb.ToString();
            }
            catch (Exception ex)
            {
                return "{\"ok\":false,\"error\":\"" + Json.Escape(ex.Message) + "\"}";
            }
        }

        private static void AppendWindowJson(StringBuilder sb, WindowTarget t, List<ElementRecord> elems)
        {
            string title = "";
            string className = "";
            try
            {
                var cur = t.Element.Current;
                title = cur.Name ?? "";
                className = cur.ClassName ?? "";
            }
            catch { /* 枚举后窗口销毁：元数据留空，元素仍按已索引结果输出 */ }
            sb.Append("{\"hwnd\":").Append(t.Hwnd.ToInt64().ToString(CultureInfo.InvariantCulture))
              .Append(",\"title\":\"").Append(Json.Escape(title)).Append('"')
              .Append(",\"className\":\"").Append(Json.Escape(className)).Append('"')
              .Append(",\"pid\":").Append(t.Pid.ToString(CultureInfo.InvariantCulture))
              .Append(",\"elements\":[");
            for (int i = 0; i < elems.Count; i++)
            {
                if (i > 0) sb.Append(',');
                IndexWalker.AppendElementJson(sb, elems[i]);
            }
            sb.Append("]}");
        }

        /// <summary>结构指纹：ref 序列的 runtimeId|name|controlType|rect(量化 4px)。4px 容差吸收 1px 布局抖动。</summary>
        private static string Signature(List<ElementRecord> elems)
        {
            var sb = new StringBuilder(elems.Count * 48);
            foreach (var e in elems)
            {
                sb.Append(e.RuntimeId).Append('|').Append(e.Name).Append('|').Append(e.ControlType).Append('|');
                if (e.HasRect) sb.Append(Quant(e.X)).Append(',').Append(Quant(e.Y)).Append(',').Append(Quant(e.W)).Append(',').Append(Quant(e.H));
                sb.Append(';');
            }
            using (var sha = SHA1.Create())
            {
                byte[] hash = sha.ComputeHash(Encoding.UTF8.GetBytes(sb.ToString()));
                var hex = new StringBuilder(40);
                foreach (byte b in hash) hex.Append(b.ToString("x2", CultureInfo.InvariantCulture));
                return hex.ToString();
            }
        }

        private static long Quant(double v) { return (long)Math.Round(v / 4.0); }

        // ---------- resolveRefs ----------

        private sealed class RefItem { public long Hwnd; public string Rid = ""; }

        private sealed class ResolvedSlot
        {
            public string Rid = "";
            public bool Ok;
            public bool HasRect;
            public double X, Y, W, H;
            public bool Enabled, Offscreen;
        }

        public static string ResolveRefs(string payload)
        {
            try
            {
                var items = ParseItems(payload);
                if (items.Count == 0) return "{\"ok\":false,\"error\":\"bad items (expect [{runtimeId,...}])\"}";

                var slots = new List<ResolvedSlot>(items.Count);
                // 按作用域窗口分组的待重扫项（同窗口元素共享一次子树遍历）。
                // 作用域 = 请求里的 hwnd，缺省回落到索引时记录的来源窗口（RuntimeIdCache origin）。
                // 两者都没有 → 直接 ok:false：全桌面重扫实测会被任一僵死 provider 无限阻塞，禁止。
                var missGroups = new Dictionary<long, List<ResolvedSlot>>();
                foreach (var it in items)
                {
                    var slot = new ResolvedSlot();
                    slot.Rid = it.Rid;
                    slots.Add(slot);
                    AutomationElement el;
                    if (RuntimeIdCache.TryGet(it.Rid, out el) && TrySnapshot(el, slot)) continue;
                    long scope = it.Hwnd;
                    if (scope == 0)
                    {
                        IntPtr origin;
                        if (!RuntimeIdCache.TryGetOrigin(it.Rid, out origin))
                        {
                            slot.Ok = false; // 未知窗口且从未索引过：降级信号，不做无界扫描
                            continue;
                        }
                        scope = origin.ToInt64();
                    }
                    List<ResolvedSlot> bucket;
                    if (!missGroups.TryGetValue(scope, out bucket))
                    {
                        bucket = new List<ResolvedSlot>();
                        missGroups[scope] = bucket;
                    }
                    bucket.Add(slot);
                }

                foreach (var kv in missGroups)
                {
                    var keys = new HashSet<string>(StringComparer.Ordinal);
                    var byKey = new Dictionary<string, ResolvedSlot>(StringComparer.Ordinal);
                    foreach (var s in kv.Value) { keys.Add(s.Rid); byKey[s.Rid] = s; }
                    var root = ScopeRoot(kv.Key);
                    if (root == null) continue; // 目标窗口已销毁：整组保持 ok:false
                    var found = RuntimeIdCache.FindInSubtree(keys, root, RESOLVE_VISIT_CAP, new IntPtr(kv.Key));
                    foreach (var f in found)
                    {
                        ResolvedSlot s;
                        if (byKey.TryGetValue(f.Key, out s)) TrySnapshot(f.Value, s);
                    }
                }

                var sb = new StringBuilder(items.Count * 160 + 64);
                sb.Append("{\"ok\":true,\"resolved\":[");
                for (int i = 0; i < slots.Count; i++)
                {
                    if (i > 0) sb.Append(',');
                    AppendResolvedJson(sb, slots[i]);
                }
                sb.Append("]}");
                return sb.ToString();
            }
            catch (Exception ex)
            {
                return "{\"ok\":false,\"error\":\"" + Json.Escape(ex.Message) + "\"}";
            }
        }

        /// <summary>缓存路径与重扫路径共用的存活读取：Current 抛错或矩形为空 = 元素已死/不可点。</summary>
        private static bool TrySnapshot(AutomationElement el, ResolvedSlot slot)
        {
            try
            {
                var cur = el.Current;
                var r = cur.BoundingRectangle;
                if (r.IsEmpty || double.IsNaN(r.Width)) return false;
                slot.Ok = true;
                slot.HasRect = true;
                slot.X = r.X; slot.Y = r.Y; slot.W = r.Width; slot.H = r.Height;
                slot.Enabled = cur.IsEnabled;
                slot.Offscreen = cur.IsOffscreen;
                return true;
            }
            catch { return false; }
        }

        /// <summary>重扫作用域根：仅目标窗口本身；句柄失效返回 null（绝不回落全桌面）。</summary>
        private static AutomationElement ScopeRoot(long hwnd)
        {
            if (hwnd <= 0) return null;
            try { return AutomationElement.FromHandle(new IntPtr(hwnd)); }
            catch { return null; } // 窗口已销毁：该组全部 ok:false，上层降级
        }

        private static void AppendResolvedJson(StringBuilder sb, ResolvedSlot s)
        {
            sb.Append("{\"runtimeId\":\"").Append(Json.Escape(s.Rid)).Append("\",\"ok\":").Append(s.Ok ? "true" : "false");
            if (s.Ok && s.HasRect)
            {
                sb.Append(",\"rect\":{\"x\":").Append(Json.Num(s.X)).Append(",\"y\":").Append(Json.Num(s.Y))
                  .Append(",\"w\":").Append(Json.Num(s.W)).Append(",\"h\":").Append(Json.Num(s.H)).Append('}');
                sb.Append(",\"center\":{\"x\":").Append(Json.Num(s.X + s.W / 2.0))
                  .Append(",\"y\":").Append(Json.Num(s.Y + s.H / 2.0)).Append('}');
                sb.Append(",\"enabled\":").Append(s.Enabled ? "true" : "false");
                sb.Append(",\"offscreen\":").Append(s.Offscreen ? "true" : "false");
            }
            if (!s.Ok) sb.Append(",\"error\":\"unresolvable\"");
            sb.Append('}');
        }

        /// <summary>扫描 "items":[{...},{...}]（字符串感知的花括号配对；runtimeId 为纯数字逗号，无内嵌大括号）。</summary>
        private static List<RefItem> ParseItems(string line)
        {
            var list = new List<RefItem>();
            int i = line.IndexOf("\"items\"", StringComparison.Ordinal);
            if (i < 0) return list;
            int open = line.IndexOf('[', i);
            if (open < 0) return list;
            int p = open + 1;
            while (list.Count < MAX_RESOLVE_ITEMS)
            {
                int brace = line.IndexOf('{', p);
                if (brace < 0) break;
                int q = brace + 1;
                bool inStr = false, esc = false;
                while (q < line.Length)
                {
                    char c = line[q];
                    if (esc) esc = false;
                    else if (c == '\\') esc = true;
                    else if (c == '"') inStr = !inStr;
                    else if (c == '}' && !inStr) break;
                    q++;
                }
                if (q >= line.Length) break;
                string obj = line.Substring(brace, q - brace + 1);
                string rid = JsonExtract.StringParam(obj, "runtimeId", "");
                if (rid.Length > 0)
                {
                    var it = new RefItem();
                    it.Rid = rid;
                    it.Hwnd = JsonExtract.LongParam(obj, "hwnd", 0);
                    list.Add(it);
                }
                p = q + 1;
            }
            return list;
        }
    }
}
