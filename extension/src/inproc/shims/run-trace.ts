import { TraceRecorder } from "../../../../shared/run-trace-core.js";
import { createTraceSink } from "../../shared/trace-store.js";
import { pushedSelfUse } from "../../shared/core-settings.js";

export { sanitizeTrace } from "../../../../shared/trace-sanitize.js";

export class RunTrace extends TraceRecorder {
  constructor() {
    super(createTraceSink);
  }

  override record(type: string, data: Record<string, unknown> = {}): void {
    super.record(type, type === "run_start" && pushedSelfUse() ? { ...data, selfUse: true } : data);
  }
}
