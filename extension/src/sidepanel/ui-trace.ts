import { TraceRecorder } from "../../../shared/run-trace-core.js";
import { createTraceSink } from "../shared/trace-store.js";

type UiEventData = Record<string, string | number | boolean | null | undefined>;

let recorder: TraceRecorder | null = null;
let currentRunId: () => string | null = () => null;

export function setUiRunSource(source: () => string | null): void {
  currentRunId = source;
}

export function uiEvent(type: `ui_${string}`, data: UiEventData = {}, runId: string | null = currentRunId()): void {
  try {
    recorder ??= new TraceRecorder(createTraceSink);
    recorder.setRun(runId);
    recorder.record(type, data);
  } catch {  }
}
