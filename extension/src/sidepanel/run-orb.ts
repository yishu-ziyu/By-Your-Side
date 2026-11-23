import type { AgentUiEvent } from "../../../shared/protocol.js";

export type RunOrbState = "thinking" | "executing" | "waiting" | "user" | "completed" | "failed" | "stopped";

export class RunOrbActivity {
  private tools = new Map<string, { sessionId: string; waiting: boolean }>();
  private failure: "none" | "step" | "run" = "none";
  private phase: "running" | "stopped" | "finished" = "running";

  observe(event: AgentUiEvent, sessionId = "main"): void {
    if (event.kind === "run_stopped") {
      this.stop();
    } else if (event.kind === "tool_start") {
      this.tools.set(event.toolCallId, { sessionId, waiting: event.name === "await_message" });
      if (this.failure === "step") this.failure = "none";
    } else if (event.kind === "tool_end") {
      this.tools.delete(event.toolCallId);

      if (this.failure !== "run") this.failure = event.isError && !event.repeatRefused && !event.heldReason ? "step" : "none";
    } else if (event.kind === "error") {
      this.failure = "run";
    } else if (event.kind === "agent_end") {
      for (const [id, tool] of this.tools) if (tool.sessionId === sessionId) this.tools.delete(id);
    }
  }

  onlyStepFailed(): boolean { return this.failure === "step" && this.phase !== "stopped"; }

  stop(): void { this.phase = "stopped"; }
  finish(): void { if (this.phase !== "stopped") this.phase = "finished"; this.tools.clear(); }

  state(userHasPage = false): RunOrbState {
    if (this.phase === "stopped") return "stopped";

    if (this.phase === "finished") return this.failure !== "none" ? "failed" : "completed";

    if (userHasPage) return "user";

    if ([...this.tools.values()].some((tool) => !tool.waiting)) return "executing";

    if (this.tools.size) return "waiting";

    if (this.failure === "run") return "failed";

    return "thinking";
  }
}

export function orbStateRuns(state: RunOrbState): boolean {
  return state === "thinking" || state === "executing" || state === "waiting";
}
