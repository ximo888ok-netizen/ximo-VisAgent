// 感知提供方：截图 + 前台窗口
// 注意：host 的初始化由 orchestrator.ts 的 launch() 负责，
// 此处只负责创建 perception 实例，不重复 setHost
import { HostPerception } from '@ximo-visagent/control-kit';

let perception: HostPerception | null = null;

export function initPerception(): HostPerception {
  if (!perception) {
    perception = new HostPerception();
  }
  return perception;
}
