import type { AgentUiEvent } from "../../../shared/protocol.js";

export type RunOrbState = "thinking" | "executing" | "waiting" | "user" | "completed" | "failed" | "stopped";

/** 同一执行块的真实在途工具；并行工具未结束时，不被其他成员的思考帧盖掉。 */
export class RunOrbActivity {
  private tools = new Map<string, { sessionId: string; waiting: boolean }>();
  /** 最近一步没做成：下一步开始就清掉；整轮结束时还在，结论才是出错。 */
  private failed = false;
  /** 整轮出错（模型或连接）：马上就是出错。 */
  private errored = false;
  private stopped = false;
  private finished = false;

  observe(event: AgentUiEvent, sessionId = "main"): void {
    if (event.kind === "run_stopped") {
      this.stop();
    } else if (event.kind === "tool_start") {
      this.tools.set(event.toolCallId, { sessionId, waiting: event.name === "await_message" });
      this.failed = false;
    } else if (event.kind === "tool_end") {
      this.tools.delete(event.toolCallId);

      // 用户没让发送不是失败（docs/evals/20261009-send-confirm.md R2）。
      if (event.isError && !event.repeatRefused && !event.heldReason) this.failed = true;
    } else if (event.kind === "error") {
      this.errored = true;
    } else if (event.kind === "agent_end") {
      for (const [id, tool] of this.tools) if (tool.sessionId === sessionId) this.tools.delete(id);
    }
  }

  /** 收尾时只是最后一步没做成（模型和连接没出错）：这一轮已经交了回答时，结论按做完算，那一步在过程里标没做成。 */
  onlyStepFailed(): boolean { return this.failed && !this.errored && !this.stopped; }

  stop(): void { this.stopped = true; }
  finish(): void { this.finished = true; this.tools.clear(); }

  state(userHasPage = false): RunOrbState {
    if (this.stopped) return "stopped";

    if (this.finished) return this.failed || this.errored ? "failed" : "completed";

    if (userHasPage) return "user";

    if ([...this.tools.values()].some((tool) => !tool.waiting)) return "executing";

    if (this.tools.size) return "waiting";

    // 一步没做成、模型还在想下一步：仍是在想，不是出错（#263：换了做法的那段思考要照常计时）。
    if (this.errored) return "failed";

    return "thinking";
  }
}

export function orbStateRuns(state: RunOrbState): boolean {
  return state === "thinking" || state === "executing" || state === "waiting";
}
