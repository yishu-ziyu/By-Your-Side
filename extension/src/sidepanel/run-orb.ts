import type { AgentUiEvent } from "../../../shared/protocol.js";

export type RunOrbState = "thinking" | "executing" | "waiting" | "user" | "completed" | "failed" | "stopped";

export class RunOrbActivity {
  private tools = new Map<string, { sessionId: string; waiting: boolean }>();
  private failed = false;
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

      this.failed = event.isError && !event.repeatRefused && !event.heldReason;
    } else if (event.kind === "error") {
      this.errored = true;
    } else if (event.kind === "agent_end") {
      for (const [id, tool] of this.tools) if (tool.sessionId === sessionId) this.tools.delete(id);
    }
  }

  onlyStepFailed(): boolean { return this.failed && !this.errored && !this.stopped; }

  stop(): void { this.stopped = true; }
  finish(): void { this.finished = true; this.tools.clear(); }

  state(userHasPage = false): RunOrbState {
    if (this.stopped) return "stopped";

    if (this.finished) return this.failed || this.errored ? "failed" : "completed";

    if (userHasPage) return "user";

    if ([...this.tools.values()].some((tool) => !tool.waiting)) return "executing";

    if (this.tools.size) return "waiting";

    if (this.errored) return "failed";

    return "thinking";
  }
}

export function orbStateRuns(state: RunOrbState): boolean {
  return state === "thinking" || state === "executing" || state === "waiting";
}
