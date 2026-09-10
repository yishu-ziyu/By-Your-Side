import { describe, expect, it } from "vitest";
import { createBrowserTools } from "../src/tools.js";

function clickTool(data: unknown) {
  const rpc: any = { call: async () => data };
  const tools = createBrowserTools(rpc, undefined, undefined, undefined, {
    epoch: () => 0,
    canWrite: () => true,
    assertCall: () => {},
  });
  return tools.find((tool) => tool.name === "click")!;
}

const text = async (data: unknown, params: Record<string, unknown> = { target: "#x", label: "关注" }) => {
  const result: any = await (clickTool(data).execute as any)("call-1", params);
  return result.content.map((part: any) => part.text).join("\n");
};

describe("click 回执带效果证据", () => {
  it("有反应时给变化清单，不再要求先 snapshot 才能确认", async () => {
    const out = await text({ clicked: true, effect: { changed: true, evidence: ["expanded false → true"], weak: [], volatile: false, alerts: [] } });
    expect(out).toContain("Clicked 关注.");
    expect(out).toContain("Page reacted: expanded false → true");
    expect(out).not.toContain("observe the page to verify");
  });

  it("无反应时明说归因失败，并阻止盲目重试", async () => {
    const out = await text({ clicked: true, effect: { changed: false, evidence: [], weak: ["DOM +7 node(s)"], volatile: false, alerts: [] } });
    expect(out).toContain("Nothing on the page changed");
    expect(out).toContain("Do not blindly click the same target again");
  });

  it("页面自己在动时按 volatile 措辞读", async () => {
    const out = await text({ clicked: true, effect: { changed: false, evidence: [], weak: [], volatile: true, alerts: [] } });
    expect(out).toContain("page itself keeps changing");
  });

  it("拿不到效果读数时退回原回执，不假装知道页面反应", async () => {
    const out = await text({ clicked: true });
    expect(out).toContain("This confirms event dispatch only");
  });

  it("被拦下的点击不声称任何页面反应", async () => {
    const out = await text({ clicked: false, held: true });
    expect(out).toContain("Held click");
    expect(out).not.toContain("Page reacted");
    expect(out).not.toContain("Nothing on the page changed");
  });
});
