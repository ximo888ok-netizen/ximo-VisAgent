// 主进程兜底：worker 线程/异步链路的未捕获异常不再走默认弹窗闪退
// （长期驻留的 Agent 应用必须存活）；E1：错误全文留痕到日志而非静默吞掉。
export function installProcessGuards(): void {
  process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
  });
}
