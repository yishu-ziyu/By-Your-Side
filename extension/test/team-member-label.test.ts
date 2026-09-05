import { describe, expect, it } from "vitest";
import { TEAM_SNAPSHOT_FAILED, TEAM_TAB_CLOSED, memberStatusLabel } from "../../shared/control.js";

describe("成员名册状态文案：暂停态有 reason 时说真话", () => {
  it("paused_snapshot_failed 带超时 reason 时显示超时，而非「没读到新状态」", () => {
    const label = memberStatusLabel({ phase: "paused_snapshot_failed", reason: "恢复超时，原会话仍归你。" });
    expect(label).toMatch(/超时/);
    expect(label).not.toBe(TEAM_SNAPSHOT_FAILED);
  });

  it("snapshot 失败与 prompt/超时失败在用户可见文案上可区分", () => {
    expect(memberStatusLabel({ phase: "paused_snapshot_failed", reason: undefined })).toBe(TEAM_SNAPSHOT_FAILED);
    expect(memberStatusLabel({ phase: "paused_snapshot_failed", reason: "恢复失败，原会话仍归你。" })).toBe(
      "恢复失败，原会话仍归你。",
    );
    expect(memberStatusLabel({ phase: "paused_snapshot_failed", reason: "恢复超时，原会话仍归你。" })).toMatch(/超时/);
  });

  it("paused_tab_closed 带 reason 显示 reason，空白 reason 回退 phase 文案", () => {
    expect(memberStatusLabel({ phase: "paused_tab_closed", reason: "绑定页已关闭，未续跑" })).toBe("绑定页已关闭，未续跑");
    expect(memberStatusLabel({ phase: "paused_tab_closed", reason: undefined })).toBe(TEAM_TAB_CLOSED);
    expect(memberStatusLabel({ phase: "paused_tab_closed", reason: "  " })).toBe(TEAM_TAB_CLOSED);
  });

  it("非暂停态即使带 reason 也仍用 phase 文案", () => {
    expect(memberStatusLabel({ phase: "restoring", reason: "恢复超时，原会话仍归你。" })).toBe("恢复中");
    expect(memberStatusLabel({ phase: "user", reason: "恢复超时，原会话仍归你。" })).toBe("已暂停");
    expect(memberStatusLabel({ phase: "restored" })).toBe("已恢复");
  });
});
