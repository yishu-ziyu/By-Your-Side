/**
 * 侧栏里用户对产品的反应（点了什么、什么没回应就消失了），写进与任务记录同一个诊断库，复盘时和任务时间线对得上。
 * 只记动作、id、计数和时长：不记网页内容、记忆原文和用户原话，导出的诊断里因此不会多出隐私内容。
 */
import { TraceRecorder } from "../../../shared/run-trace-core.js";
import { createTraceSink } from "../shared/trace-store.js";

type UiEventData = Record<string, string | number | boolean | null | undefined>;

let recorder: TraceRecorder | null = null;
let currentRunId: () => string | null = () => null;

/** 当前选中对话正在跑或刚跑完的那次运行：事件挂到它上面，`npm run logs -- --run` 里才能看到。 */
export function setUiRunSource(source: () => string | null): void {
  currentRunId = source;
}

export function uiEvent(type: `ui_${string}`, data: UiEventData = {}, runId: string | null = currentRunId()): void {
  try {
    recorder ??= new TraceRecorder(createTraceSink);
    recorder.setRun(runId);
    recorder.record(type, data);
  } catch { /* 诊断永远不打断界面。 */ }
}
