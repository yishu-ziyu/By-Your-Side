/** 扩展内构建替换 agent/src/run-trace.ts：行格式与本机相同（shared/run-trace-core.ts），写进扩展的 IndexedDB。 */
import { TraceRecorder } from "../../../../shared/run-trace-core.js";
import { createTraceSink } from "../../shared/trace-store.js";
import { pushedSelfUse } from "../../shared/self-use.js";

export { sanitizeTrace } from "../../../../shared/trace-sanitize.js";

export class RunTrace extends TraceRecorder {
  constructor() {
    super(createTraceSink);
  }

  /** 模拟用户的运行在开头标出来：复盘和周报据此和用户自己的使用分开。 */
  override record(type: string, data: Record<string, unknown> = {}): void {
    super.record(type, type === "run_start" && pushedSelfUse() ? { ...data, selfUse: true } : data);
  }
}
