/** 扩展内构建替换 agent/src/run-trace.ts：行格式与本机相同（shared/run-trace-core.ts），写进扩展的 IndexedDB。 */
import { TraceRecorder } from "../../../../shared/run-trace-core.js";
import { createTraceSink } from "../../shared/trace-store.js";

export { sanitizeTrace } from "../../../../shared/trace-sanitize.js";

export class RunTrace extends TraceRecorder {
  constructor() {
    super(createTraceSink);
  }
}
