// RuntimeIdCache.cs — runtimeId(归一化字符串) → AutomationElement 的进程级缓存 + 兜底子树重扫。
// resolveRefs「执行前重解析」依赖它：缓存命中时 UIA 元素是实时代理，直接读 Current 即当前值
// （元素移动后矩形自动更新；提供方失效则 Current 抛 ElementNotAvailable → 落入重扫/ok:false）。
// COM/句柄说明：托管 AutomationElement 是原生 UIA COM 的 RCW 包装，公开 API 不暴露底层接口，
// 无法（也无需）Marshal.ReleaseComObject；这里用 WeakReference 只加速不延命，
// 过期条目可被 GC 正常回收，超上限整体清空重来，杜绝长时间运行的内存泄漏。
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Windows.Automation;

namespace UiaSidecar
{
    public static class RuntimeIdCache
    {
        private const int MAX_ENTRIES = 6000; // 每次 indexWindow 都会刷新，超界=旧会话残留，清空最稳妥

        private sealed class Entry
        {
            public WeakReference<AutomationElement> Ref;
            public IntPtr HostHwnd; // 索引时所在顶层窗口：resolveRefs 缺省 hwnd 参数时的重扫作用域
        }

        private static readonly Dictionary<string, Entry> Map =
            new Dictionary<string, Entry>(StringComparer.Ordinal);

        /// <summary>RuntimeId 归一化：int[] 逗号连接（UIA 保证同一桌面会话内全局唯一，可跨调用重解析）。</summary>
        public static string Key(int[] id)
        {
            if (id == null || id.Length < 2) return "";
            var sb = new StringBuilder();
            for (int i = 0; i < id.Length; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append(id[i].ToString(CultureInfo.InvariantCulture));
            }
            return sb.ToString();
        }

        public static string KeyOf(AutomationElement el)
        {
            try { return Key(el.GetRuntimeId()); }
            catch { return ""; }
        }

        public static void Remember(AutomationElement el, IntPtr hostHwnd)
        {
            var k = KeyOf(el);
            if (k.Length == 0) return;
            if (Map.Count >= MAX_ENTRIES) Map.Clear();
            Entry e;
            if (!Map.TryGetValue(k, out e) || e == null) e = new Entry();
            e.Ref = new WeakReference<AutomationElement>(el);
            if (hostHwnd != IntPtr.Zero) e.HostHwnd = hostHwnd;
            Map[k] = e;
        }

        /// <summary>缓存命中不代表可用——调用方读 Current 失败时必须回落到 FindInSubtree 重扫。</summary>
        public static bool TryGet(string key, out AutomationElement el)
        {
            el = null;
            if (key == null) return false;
            Entry e;
            if (!Map.TryGetValue(key, out e) || e == null) return false;
            AutomationElement target;
            if (e.Ref == null || !e.Ref.TryGetTarget(out target) || target == null)
            {
                Map.Remove(key);
                return false;
            }
            el = target;
            return true;
        }

        /// <summary>索引时记录过的来源窗口（false = 从未索引过，调用方应放弃重扫而非扫全桌面）。</summary>
        public static bool TryGetOrigin(string key, out IntPtr hwnd)
        {
            hwnd = IntPtr.Zero;
            if (key == null) return false;
            Entry e;
            if (!Map.TryGetValue(key, out e) || e == null || e.HostHwnd == IntPtr.Zero) return false;
            hwnd = e.HostHwnd;
            return true;
        }

        /// <summary>
        /// 子树重扫：在 root 的后代里找 keys 里的 runtimeId（DFS，每层一次 FindAll(Children) 批量拉取，
        /// visitCap 约束跨进程往返数；命中即从 keys 摘除，找齐提前收敛）。返回 key→element。
        /// </summary>
        public static Dictionary<string, AutomationElement> FindInSubtree(HashSet<string> keys, AutomationElement root, int visitCap, IntPtr hostHwnd)
        {
            var found = new Dictionary<string, AutomationElement>(StringComparer.Ordinal);
            if (root == null || keys == null || keys.Count == 0) return found;
            var budget = new int[] { visitCap };
            Visit(root, keys, found, budget, hostHwnd);
            return found;
        }

        private static void Visit(AutomationElement el, HashSet<string> keys, Dictionary<string, AutomationElement> found, int[] budget, IntPtr hostHwnd)
        {
            if (budget[0]-- <= 0 || keys.Count == 0) return;
            var k = KeyOf(el);
            if (k.Length > 0 && keys.Contains(k))
            {
                found[k] = el;
                keys.Remove(k);
                Remember(el, hostHwnd);
            }
            try
            {
                var children = el.FindAll(TreeScope.Children, Condition.TrueCondition);
                if (children.Count > 400) return; // 与 Collector 同口径的畸形结构止损
                foreach (AutomationElement child in children)
                {
                    if (keys.Count == 0 || budget[0] <= 0) return;
                    Visit(child, keys, found, budget, hostHwnd);
                }
            }
            catch { /* 子树读取失败（provider 挂）：该分支终止，不影响其余目标 */ }
        }
    }
}
