// ScrollActions.cs — scrollIntoView 动作：按 elementId 定位元素并调用 UIA ScrollItemPattern
// 协议（NDJSON 单行）: {"id":n,"method":"scrollIntoView","elementId":123}
//   成功 → {"ok":true,"x":..,"y":..,"w":..,"h":..}（物理像素，Per-Monitor V2 已与截图坐标系对齐）
//   失败 → {"ok":false,"error":"..."}（TS 侧按 error 形态给模型下一步建议）
// 定位策略与 ElementRect 相同：全量重建带缓存的遍历（id 是 RuntimeId FNV 哈希，元素存活即稳定），
// 树上限放宽到 2000/12 层——滚动容器里的列表项常比默认树更深。
using System;
using System.Threading;
using System.Windows.Automation;

namespace UiaSidecar
{
    public static class ScrollActions
    {
        // ScrollIntoView 后布局有动画/重排，短暂等待再读矩形，避免回报滚动前的旧位置
        private const int SETTLE_MS = 150;

        public static string ScrollIntoView(string payload)
        {
            int targetId = JsonExtract.IntParam(payload, "elementId", 0);
            if (targetId == 0) return "{\"ok\":false,\"error\":\"bad elementId\"}";
            var c = new Collector(2000, 12);
            try
            {
                var desktop = AutomationElement.RootElement;
                c.Build(desktop, 0, true);
                AutomationElement el;
                if (!c.Cache.TryGetValue(targetId, out el))
                    return "{\"ok\":false,\"error\":\"element not found\"}";
                object pattern;
                if (!el.TryGetCurrentPattern(ScrollItemPattern.Pattern, out pattern))
                    return "{\"ok\":false,\"error\":\"no ScrollItem pattern\"}";
                try
                {
                    ((ScrollItemPattern)pattern).ScrollIntoView();
                }
                catch (Exception ex)
                {
                    // 模式存在但提供方实现抛错（虚拟化的自绘容器）：与「不支持」同等处置
                    return "{\"ok\":false,\"error\":\"ScrollIntoView failed: " + Json.Escape(ex.Message) + "\"}";
                }
                Thread.Sleep(SETTLE_MS);
                var r = el.Current.BoundingRectangle;
                if (r.IsEmpty) return "{\"ok\":false,\"error\":\"no rect after scroll\"}";
                return "{\"ok\":true,\"x\":" + Json.Num(r.X) + ",\"y\":" + Json.Num(r.Y)
                    + ",\"w\":" + Json.Num(r.Width) + ",\"h\":" + Json.Num(r.Height) + "}";
            }
            catch (Exception ex)
            {
                return "{\"ok\":false,\"error\":\"" + Json.Escape(ex.Message) + "\"}";
            }
        }
    }
}
