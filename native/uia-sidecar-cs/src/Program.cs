// uia-sidecar: Windows UIA 元素树 JSON-RPC 服务（stdin/stdout NDJSON）
// 编译: build.js 调用 .NET Framework 4.8 csc.exe，引用 GAC UIAutomationClient
using System;
using System.Windows.Automation;
using System.Collections.Generic;
using System.Text;
using System.Globalization;

namespace UiaSidecar
{
    public static class Json
    {
        public static string Escape(string s)
        {
            if (s == null) return "";
            var sb = new StringBuilder(s.Length + 16);
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            return sb.ToString();
        }
        public static string Num(double v) { return v.ToString("0.####", CultureInfo.InvariantCulture); }
    }

    public class Collector
    {
        private readonly Dictionary<long, AutomationElement> _cache = new Dictionary<long, AutomationElement>();
        public Dictionary<long, AutomationElement> Cache { get { return _cache; } }
        private readonly int _maxNodes;
        private readonly int _maxDepth;
        public int Total = 0;

        public Collector(int maxNodes, int maxDepth)
        {
            _maxNodes = maxNodes;
            _maxDepth = maxDepth;
        }

        public static long ElementId(AutomationElement el)
        {
            try
            {
                var id = el.GetRuntimeId();
                if (id == null || id.Length == 0) return 0;
                // 32 位哈希：保证落在 JS Number 安全整数范围（< 2^53），避免传输精度丢失
                unchecked
                {
                    uint h = 2166136261u; // FNV-1a 32
                    foreach (int v in id)
                    {
                        h ^= (uint)v;
                        h *= 16777619u;
                    }
                    if (h == 0) h = 1;
                    return h & 0x7fffffffL; // 正数，保持 < 2^31
                }
            }
            catch { return 0; }
        }

        private static bool IsWindow(AutomationElement el)
        {
            var c = el.Current.ControlType;
            return c == ControlType.Window || (c == ControlType.Pane && el.Current.ClassName == "#32769");
        }

        private static string TypeName(AutomationElement el)
        {
            try { return el.Current.ControlType.ProgrammaticName ?? el.Current.ControlType.ToString(); }
            catch { return "Unknown"; }
        }

        private static bool ShouldKeep(AutomationElement el, out string typeName)
        {
            var ct = el.Current.ControlType;
            typeName = ct.ProgrammaticName ?? ct.ToString();
            var interactive = ct == ControlType.Button || ct == ControlType.Edit || ct == ControlType.ComboBox ||
                ct == ControlType.ListItem || ct == ControlType.MenuItem || ct == ControlType.CheckBox ||
                ct == ControlType.RadioButton || ct == ControlType.TabItem || ct == ControlType.Hyperlink ||
                ct == ControlType.TreeItem || ct == ControlType.DataItem || ct == ControlType.Custom ||
                ct == ControlType.Window || ct == ControlType.Document || ct == ControlType.Spinner ||
                ct == ControlType.SplitButton || ct == ControlType.HeaderItem ||
                ct == ControlType.List || ct == ControlType.Tree || ct == ControlType.DataGrid;
            var hasName = !string.IsNullOrEmpty(el.Current.Name);
            var hasAuto = !string.IsNullOrEmpty(el.Current.AutomationId);
            return interactive || hasName || hasAuto;
        }

        // 返回 JSON 或 null（节点被裁剪）
        public string Build(AutomationElement el, int depth, bool isRoot)
        {
            Total++;
            bool isWin = isRoot || IsWindow(el);
            if (!isWin && (depth > _maxDepth || Total > _maxNodes))
                return null;
            string typeName = "Unknown";
            bool keep = isWin || ShouldKeep(el, out typeName);
            if (!keep) return null;

            long id = ElementId(el);
            var r = el.Current.BoundingRectangle;
            bool hasRect = !r.IsEmpty;

            var sb = new StringBuilder();
            sb.Append("{\"id\":").Append(id);
            sb.Append(",\"type\":\"").Append(Json.Escape(typeName)).Append("\"");
            var name = el.Current.Name ?? "";
            if (name.Length > 0) sb.Append(",\"name\":\"").Append(Json.Escape(name)).Append("\"");
            var autoId = el.Current.AutomationId ?? "";
            if (autoId.Length > 0) sb.Append(",\"automationId\":\"").Append(Json.Escape(autoId)).Append("\"");
            if (hasRect)
            {
                TryCache(id, el);
                sb.Append(",\"x\":").Append(Json.Num(r.X)).Append(",\"y\":").Append(Json.Num(r.Y))
                  .Append(",\"w\":").Append(Json.Num(r.Width)).Append(",\"h\":").Append(Json.Num(r.Height));
            }
            if (!el.Current.IsEnabled) sb.Append(",\"enabled\":false");
            if (el.Current.IsOffscreen) sb.Append(",\"offscreen\":true");
            if (isWin) sb.Append(",\"isWindow\":true");

            // 子节点（跳过纯结构容器层级，但保留窗口标题等）
            int childCount = 0;
            StringBuilder childrenSb = new StringBuilder();
            try
            {
                var children = el.FindAll(TreeScope.Children, Condition.TrueCondition);
                if (children.Count <= 400)
                {
                    foreach (AutomationElement child in children)
                    {
                        if (Total > _maxNodes) break;
                        var json = Build(child, depth + 1, false);
                        if (json != null)
                        {
                            if (childCount > 0) childrenSb.Append(",");
                            childrenSb.Append(json);
                            childCount++;
                        }
                    }
                }
            }
            catch { }

            if (childCount > 0) sb.Append(",\"children\":[").Append(childrenSb).Append("]");
            sb.Append("}");
            return sb.ToString();
        }

        private void TryCache(long id, AutomationElement el)
        {
            if (!_cache.ContainsKey(id))
            {
                try { _cache[id] = el; } catch { }
            }
        }
    }

    public class Program
    {
        public static void Main(string[] args)
        {
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                line = line.Trim();
                if (line.Length == 0) continue;
                string id = "0";
                string method = "";
                string payload = "";
                try
                {
                    id = ExtractParam(line, "id", "0");
                    method = ExtractMethod(line);
                    payload = line;
                    string result;
                    switch (method)
                    {
                        case "getUiTree": result = BuildTree(payload); break;
                        case "elementRect": result = ElementRect(payload); break;
                        case "focusedElement": result = Focused(); break;
                        case "health": result = "{\"ok\":true,\"version\":\"1.0.0\"}"; break;
                        default: result = "{\"ok\":false,\"error\":\"unknown method: " + Json.Escape(method) + "\"}"; break;
                    }
                    Console.WriteLine("{\"id\":" + id + ",\"result\":" + result + "}");
                }
                catch (Exception ex)
                {
                    Console.WriteLine("{\"id\":" + id + ",\"result\":{\"ok\":false,\"error\":\"" + Json.Escape(ex.ToString()) + "\"}}");
                }
            }
        }

        private static string BuildTree(string payload)
        {
            int maxDepth = SafeInt(ExtractParam(payload, "maxDepth", "6"), 1, 12, 6);
            int maxNodes = SafeInt(ExtractParam(payload, "maxNodes", "800"), 50, 2000, 800);
            var c = new Collector(maxNodes, maxDepth);
            string body;
            try
            {
                var desktop = AutomationElement.RootElement;
                var desktopJson = c.Build(desktop, 0, true);
                body = desktopJson != null ? desktopJson : "null";
            }
            catch (Exception ex)
            {
                return "{\"ok\":false,\"error\":\"" + Json.Escape(ex.Message) + "\"}";
            }
            return "{\"ok\":true,\"total\":" + c.Total + ",\"tree\":" + body + ",\"cache\":" + c.Cache.Count + "}";
        }

        private static string ElementRect(string payload)
        {
            long targetId;
            if (!long.TryParse(ExtractParam(payload, "elementId", "0"), out targetId) || targetId == 0)
                return "{\"ok\":false,\"error\":\"bad elementId\"}";
            // 每次重新遍历（树会变化），用前一次缓存快速路径失败后再全量
            var c = new Collector(800, 6);
            try
            {
                var desktop = AutomationElement.RootElement;
                c.Build(desktop, 0, true);
                AutomationElement el2;
                if (c.Cache.TryGetValue(targetId, out el2))
                {
                    var r = el2.Current.BoundingRectangle;
                    if (r.IsEmpty) return "{\"ok\":false,\"error\":\"no rect\"}";
                    return "{\"ok\":true,\"x\":" + Json.Num(r.X) + ",\"y\":" + Json.Num(r.Y)
                        + ",\"w\":" + Json.Num(r.Width) + ",\"h\":" + Json.Num(r.Height) + "}";
                }
                return "{\"ok\":false,\"error\":\"element not found\"}";
            }
            catch (Exception ex)
            {
                return "{\"ok\":false,\"error\":\"" + Json.Escape(ex.Message) + "\"}";
            }
        }

        private static string Focused()
        {
            try
            {
                var f = AutomationElement.FocusedElement;
                if (f == null) return "{\"ok\":false,\"error\":\"no focus\"}";
                var sb = new StringBuilder();
                sb.Append("{\"ok\":true");
                sb.Append(",\"id\":").Append(Collector.ElementId(f));
                var name = f.Current.Name ?? "";
                if (name.Length > 0) sb.Append(",\"name\":\"").Append(Json.Escape(name)).Append("\"");
                var r = f.Current.BoundingRectangle;
                if (!r.IsEmpty)
                    sb.Append(",\"x\":").Append(Json.Num(r.X)).Append(",\"y\":").Append(Json.Num(r.Y))
                      .Append(",\"w\":").Append(Json.Num(r.Width)).Append(",\"h\":").Append(Json.Num(r.Height));
                sb.Append("}");
                return sb.ToString();
            }
            catch (Exception ex)
            {
                return "{\"ok\":false,\"error\":\"" + Json.Escape(ex.Message) + "\"}";
            }
        }

        private static int SafeInt(string s, int min, int max, int dflt)
        {
            int v;
            if (!int.TryParse(s, out v)) return dflt;
            return Math.Max(min, Math.Min(max, v));
        }

        private static string ExtractMethod(string line)
        {
            int i = line.IndexOf("\"method\"", StringComparison.Ordinal);
            if (i < 0) return "";
            int q = line.IndexOf('"', i + 9);
            if (q < 0) return "";
            int e = line.IndexOf('"', q + 1);
            if (e < 0) return "";
            return line.Substring(q + 1, e - q - 1);
        }

        private static string ExtractParam(string line, string key, string dflt)
        {
            // 匹配 "key": value 或 "key":"value"
            int i = line.IndexOf("\"" + key + "\"", StringComparison.Ordinal);
            if (i < 0) return dflt;
            int colon = line.IndexOf(':', i + key.Length + 2);
            if (colon < 0) return dflt;
            int p = colon + 1;
            while (p < line.Length && (line[p] == ' ' || line[p] == '\t')) p++;
            if (p >= line.Length) return dflt;
            if (line[p] == '"')
            {
                int e = line.IndexOf('"', p + 1);
                if (e < 0) return dflt;
                return line.Substring(p + 1, e - p - 1);
            }
            int end = p;
            while (end < line.Length && (char.IsDigit(line[end]) || line[end] == '-' || line[end] == '.')) end++;
            if (end == p) return dflt;
            return line.Substring(p, end - p);
        }
    }
}