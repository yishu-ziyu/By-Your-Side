import { describe, expect, it } from "vitest";
import { panelLive, shouldShowTeamCard } from "../../shared/control.js";
import { LEAD_SESSION_ID } from "../../shared/protocol.js";
import {
  acceptTeamStatus,
  emptyTeamRun,
  observeRunStarted,
  staleTeamForRun,
  type TeamRunState,
} from "../src/shared/team-run.js";
import type { TeamView } from "../../shared/protocol.js";

function team(phase: TeamView["phase"], capturedAt = 1): TeamView {
  return {
    groupId: "team-1",
    generation: 1,
    phase,
    capturedAt,
    members: [{ sessionId: LEAD_SESSION_ID, role: "lead", phase: phase === "aborted" ? "aborted" : "user" }],
  };
}

/**
 * 面板接收路径的最小复现：agent_start 携带 runId，team_status 携带 runId。
 * 与 sidepanel/main.ts 使用同一套 helper，行为失败时说明隔离规则坏了。
 */
function panelReceive(state: TeamRunState, msg: { kind: "run_started"; runId?: string } | { kind: "team_status"; team: TeamView; runId?: string }): TeamRunState {
  if (msg.kind === "run_started") return observeRunStarted(state, msg.runId);
  const decision = acceptTeamStatus(state, msg.team, msg.runId);

  return decision.accept ? decision.state : state;
}

describe("team/run 身份隔离", () => {
  it("A 中止后 B 开始：清掉旧 team，B 运行期重新显示接管/中止", () => {
    let state = emptyTeamRun();
    state = panelReceive(state, { kind: "run_started", runId: "run-a" });
    state = panelReceive(state, { kind: "team_status", team: team("aborted"), runId: "run-a" });
    // 复现旧行为：A 中止时确实没有接管/中止按钮，卡片显示"已中止"。
    const aborted = panelLive(["idle"], state.team);
    expect(aborted.running).toBe(false);
    expect(aborted.abortVisible).toBe(false);
    expect(aborted.takeoverVisible).toBe(false);
    expect(shouldShowTeamCard(state.team?.phase)).toBe(true);

    state = panelReceive(state, { kind: "run_started", runId: "run-b" });
    expect(state.team).toBeNull();
    const running = panelLive(["running"], state.team);
    expect(running.running).toBe(true);
    expect(running.abortVisible).toBe(true);
    expect(running.takeoverVisible).toBe(true);
    expect(shouldShowTeamCard(state.team?.phase)).toBe(false);
  });

  it("B 完成后不显示旧的已中止", () => {
    let state = panelReceive(emptyTeamRun(), { kind: "run_started", runId: "run-a" });
    state = panelReceive(state, { kind: "team_status", team: team("aborted"), runId: "run-a" });
    state = panelReceive(state, { kind: "run_started", runId: "run-b" });
    // B 结束：没有 team，会话收尾，不再有"已中止/详情"卡片。
    const done = panelLive(["idle"], state.team);
    expect(done.finishRun).toBe(true);
    expect(shouldShowTeamCard(state.team?.phase)).toBe(false);
  });

  it("旧 run 的 team_status 晚到不覆盖 B", () => {
    let state = panelReceive(emptyTeamRun(), { kind: "run_started", runId: "run-a" });
    state = panelReceive(state, { kind: "team_status", team: team("aborted"), runId: "run-a" });
    state = panelReceive(state, { kind: "run_started", runId: "run-b" });
    const before = state;
    state = panelReceive(state, { kind: "team_status", team: team("aborted"), runId: "run-a" });
    expect(state).toBe(before);
    expect(state.team).toBeNull();
    expect(state.runId).toBe("run-b");
  });

  it("重开面板不回放旧 run 的缓存 team", () => {
    const cached: TeamRunState = { team: team("aborted"), runId: "run-a" };
    expect(staleTeamForRun(cached, "run-b")).toBe(true);
    // 当前 run 未知（尚未拿到 summary）时不误判，旧路径仍能显示。
    expect(staleTeamForRun(cached, null)).toBe(false);
  });

  it("没有 runId 的 team_status 仍被接受，并沿用已有绑定（兼容旧路径）", () => {
    const bound = panelReceive(emptyTeamRun(), { kind: "run_started", runId: "run-b" });
    const decision = acceptTeamStatus(bound, team("user"), undefined);
    expect(decision.accept).toBe(true);
    expect(decision.state.runId).toBe("run-b");
    expect(decision.state.team?.phase).toBe("user");
    // 无身份的状态不能凭空清掉已绑定的 team。
    expect(observeRunStarted(bound, undefined)).toBe(bound);
  });

  it("同一个 run 交还触发的 agent_start 保留 team", () => {
    let state = panelReceive(emptyTeamRun(), { kind: "run_started", runId: "run-a" });
    state = panelReceive(state, { kind: "team_status", team: team("restored"), runId: "run-a" });
    const restored = state.team;
    state = panelReceive(state, { kind: "run_started", runId: "run-a" });
    expect(state.team).toBe(restored);
    expect(state.team?.phase).toBe("restored");
  });

  it("身份未知时新 run 到达只采用身份，不清掉无法证明属于旧 run 的 team", () => {
    const legacy: TeamRunState = { team: team("user"), runId: null };
    const next = observeRunStarted(legacy, "run-b");
    expect(next.team).toBe(legacy.team);
    expect(next.runId).toBe("run-b");
  });
});

it("无身份历史不重新施加到当前任务，实时兼容消息仍可接收",()=>{
  const current={team:null,runId:"new-run"};
  expect(acceptTeamStatus(current,team("aborted"),undefined,true).accept).toBe(false);
  expect(acceptTeamStatus(current,team("user"),undefined,false).accept).toBe(true);
});
