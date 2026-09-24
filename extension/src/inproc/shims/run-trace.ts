/** 扩展内构建替换 agent/src/run-trace.ts：诊断记录写本机文件，扩展里不记（脱敏函数已拆到 trace-sanitize.ts，不受影响）。 */
interface TraceStage { end: () => void }

export class RunTrace {
  begin(): void {}

  correlate(): void {}

  stage(): TraceStage {
    return { end: () => {} };
  }

  event(): void {}

  record(): void {}

  flush(): Promise<void> {
    return Promise.resolve();
  }
}
