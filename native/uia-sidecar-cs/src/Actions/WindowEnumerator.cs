// WindowEnumerator.cs — indexWindow 的目标窗口定位：pid 全可见顶层窗口 / 单 hwnd / 前台窗口 三模式。
// 只用 Win32 枚举现成句柄（不创建句柄，无泄漏），再 FromHandle 转托管 UIA 包装
// （托管 AutomationElement 是 COM RCW 包装，由 GC 终结器释放，无法也不需要 Marshal.ReleaseComObject）。
// excludePids 是"自我污染"硬防线：灵动岛/aura 常驻顶层窗口一旦进树，模型会去点我们自己的界面。
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Windows.Automation;

namespace UiaSidecar
{
    public sealed class WindowTarget
    {
        public IntPtr Hwnd;
        public int Pid;
        public AutomationElement Element;
    }

    public static class WindowEnumerator
    {
        private const uint GA_ROOT = 2;
        private const int DWMWA_CLOAKED = 14;
        private const int MAX_WINDOWS_PER_PID = 32; // Office/浏览器多窗口已足够；防异常进程刷屏

        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
        [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);
        [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out int pvAttribute, int cbAttribute);

        [StructLayout(LayoutKind.Sequential)]
        private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

        // 委托必须驻留在静态字段：P/Invoke 期间若被 GC 回收会产生回调崩溃（经典坑）
        private static readonly EnumWindowsProc EnumProc = OnEnumWindow;

        private static bool OnEnumWindow(IntPtr hWnd, IntPtr lParam)
        {
            var g = GCHandle.FromIntPtr(lParam);
            var visit = (Func<IntPtr, bool>)g.Target;
            return visit(hWnd);
        }

        private static void Enumerate(Func<IntPtr, bool> visit)
        {
            var handle = GCHandle.Alloc(visit);
            try
            {
                EnumWindows(EnumProc, GCHandle.ToIntPtr(handle));
            }
            finally
            {
                if (handle.IsAllocated) handle.Free();
            }
        }

        /// <summary>
        /// hwnd>0 → 仅该窗口；pid>0 → 该进程全部可见顶层窗口（不只前台）；都缺省 → 前台窗口。
        /// 命中的 pid 在 exclude 中一律跳过。返回值已过滤 FromHandle 失败的僵尸目标。
        /// </summary>
        public static List<WindowTarget> Collect(int pid, long hwnd, HashSet<int> exclude)
        {
            var list = new List<WindowTarget>();
            if (hwnd > 0)
            {
                AddIfAllowed(list, new IntPtr(hwnd), exclude);
                return Finish(list);
            }
            if (pid > 0)
            {
                Enumerate(delegate(IntPtr h)
                {
                    if (list.Count >= MAX_WINDOWS_PER_PID) return false;
                    uint wpid;
                    if (!IsInterestingTopLevel(h, out wpid)) return true;
                    if ((int)wpid != pid) return true;
                    if (exclude != null && exclude.Contains((int)wpid)) return true;
                    list.Add(MakeTarget(h, (int)wpid));
                    return true;
                });
                return Finish(list);
            }
            var fg = GetForegroundWindow();
            if (fg != IntPtr.Zero) AddIfAllowed(list, fg, exclude);
            return Finish(list);
        }

        private static void AddIfAllowed(List<WindowTarget> list, IntPtr h, HashSet<int> exclude)
        {
            uint upid;
            GetWindowThreadProcessId(h, out upid);
            if (exclude != null && exclude.Contains((int)upid)) return;
            list.Add(MakeTarget(h, (int)upid));
        }

        private static List<WindowTarget> Finish(List<WindowTarget> list)
        {
            var ok = new List<WindowTarget>(list.Count);
            for (int i = 0; i < list.Count; i++)
                if (list[i].Element != null) ok.Add(list[i]);
            return ok;
        }

        private static WindowTarget MakeTarget(IntPtr h, int pid)
        {
            var t = new WindowTarget();
            t.Hwnd = h;
            t.Pid = pid;
            try { t.Element = AutomationElement.FromHandle(h); }
            catch { t.Element = null; } // 窗口销毁/无 UIA 提供方的僵尸句柄：跳过该目标而非整个请求
            return t;
        }

        /// <summary>可见 + 真顶层（GA_ROOT 自引用）+ 非空矩形 + 未被 DWM cloak（UWP/Office 幽灵窗口）。</summary>
        private static bool IsInterestingTopLevel(IntPtr h, out uint pid)
        {
            pid = 0;
            if (!IsWindowVisible(h)) return false;
            if (GetAncestor(h, GA_ROOT) != h) return false;
            RECT r;
            if (!GetWindowRect(h, out r)) return false;
            if (r.Right - r.Left < 2 || r.Bottom - r.Top < 2) return false;
            int cloaked;
            try
            {
                if (DwmGetWindowAttribute(h, DWMWA_CLOAKED, out cloaked, sizeof(int)) == 0 && cloaked != 0) return false;
            }
            catch { /* 老系统无 dwmapi：按未遮蔽处理 */ }
            GetWindowThreadProcessId(h, out pid);
            return true;
        }
    }
}
