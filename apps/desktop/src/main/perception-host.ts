// 感知提供方：截图 + UIA 树 + 前台窗口（用 control-kit 的 HostPerception + Electron host）
import { HostPerception, setHost } from '@desktop-agi/control-kit';
import { createHostCapabilities } from './host-capabilities';
import { getMonitorsPhysical } from './foreground';

let perception: HostPerception | null = null;
let hostInitialized = false;

export function initPerception(): HostPerception {
  if (!perception) {
    if (!hostInitialized) {
      setHost(createHostCapabilities());
      hostInitialized = true;
    }
    perception = new HostPerception(true);
  }
  return perception;
}

export function getMonitors() {
  return getMonitorsPhysical();
}