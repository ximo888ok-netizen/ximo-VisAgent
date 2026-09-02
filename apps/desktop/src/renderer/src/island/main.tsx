/**
 * island 渲染入口（独立于主窗口 renderer，随 island.html 打包）
 * 样式注意：透明窗口无需 body 背景；尺寸由 IslandShell 通过 islandAPI.resize() 自适应。
 */
import { createRoot } from "react-dom/client";
import { IslandShell } from "./components/Island/IslandShell";
import "./styles/tailwind.css";
import "./styles/island.css";

createRoot(document.getElementById("root")!).render(
  <div className="dark:bg-transparent" style={{ width: 900, height: 280, position: "absolute", inset: 0 }}>
    <IslandShell />
  </div>,
);