import { expect, it } from "vitest";
import { RunOrbActivity, orbStateRuns } from "../src/sidepanel/run-orb.js";

it("tracks thinking, execution, waiting and completion from actual tool lifetimes", () => {
  const a = new RunOrbActivity();
  expect(a.state()).toBe("thinking");
  a.observe({ kind: "tool_start", toolCallId: "wait", name: "await_message", params: {} });
  expect(a.state()).toBe("waiting");
  a.observe({ kind: "tool_start", toolCallId: "read", name: "read_element", params: {} }, "kim");
  expect(a.state()).toBe("executing");
  a.observe({ kind: "thinking_delta", delta: "reason" });
  expect(a.state()).toBe("executing");
  a.observe({ kind: "agent_end" }, "kim");
  expect(a.state()).toBe("waiting");
  a.observe({ kind: "tool_end", toolCallId: "wait", name: "await_message", isError: false, resultText: "ok" });
  expect(a.state()).toBe("thinking");
  a.finish();
  expect(a.state()).toBe("completed");
});

it("pause resumes the same pending state, stop wins over late events", () => {
  const a = new RunOrbActivity();
  a.observe({ kind: "tool_start", toolCallId: "read", name: "read_element", params: {} });
  expect(a.state(true)).toBe("user");
  expect(a.state(false)).toBe("executing");
  a.stop(); a.finish();
  a.observe({ kind: "tool_end", toolCallId: "read", name: "read_element", isError: false, resultText: "ok" });
  expect(a.state()).toBe("stopped");
});

it("failure is distinct, recovery may proceed, and old completed events do not animate", () => {
  const a = new RunOrbActivity();
  a.observe({ kind: "error", message: "failed" });
  expect(a.state()).toBe("failed");
  a.observe({ kind: "tool_start", toolCallId: "retry", name: "read_element", params: {} });
  expect(a.state()).toBe("executing");
  a.finish();
  a.observe({ kind: "tool_start", toolCallId: "late", name: "read_element", params: {} });
  expect(a.state()).toBe("completed");
  for (const state of ["completed", "failed", "stopped", "user"] as const) expect(orbStateRuns(state)).toBe(false);
});


it("a recorded stop remains stopped when history reaches idle", () => {
  const a = new RunOrbActivity();
  a.observe({ kind: "run_stopped" });
  a.finish();
  a.observe({ kind: "agent_end" });
  expect(a.state()).toBe("stopped");
});
