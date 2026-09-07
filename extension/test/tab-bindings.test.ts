import { describe, expect, it } from "vitest";
import {
  applyTabBinding,
  bindExclusiveResource,
  boundTabIds,
  executionKey,
  mayAccessResource,
  mayClaimReplacementTab,
  parseExecutionKey,
  sessionForTab,
  sessionsForTab,
  shareResource,
} from "../src/background/tab-bindings.js";
import { LEAD_SESSION_ID } from "../../shared/protocol.js";

describe("tab bindings", () => {
  it("set / clear per session 互不覆盖", () => {
    let map = applyTabBinding({}, LEAD_SESSION_ID, 1);
    map = applyTabBinding(map, "wiki", 2);
    expect(map).toEqual({ [LEAD_SESSION_ID]: 1, wiki: 2 });
    map = applyTabBinding(map, "wiki", null);
    expect(map).toEqual({ [LEAD_SESSION_ID]: 1 });
    expect(sessionForTab(map, 1)).toBe(LEAD_SESSION_ID);
    expect(sessionForTab(map, 2)).toBeUndefined();
  });

  it("sessionForTab 与 boundTabIds", () => {
    const map = applyTabBinding(applyTabBinding({}, "wiki", 10), "feishu", 20);
    expect(sessionForTab(map, 20)).toBe("feishu");
    expect([...boundTabIds(map)].sort()).toEqual([10, 20]);
  });

  it("复合执行 key 可逆，default 仍兼容旧键", () => {
    expect(executionKey("default", "main")).toBe("main");
    expect(parseExecutionKey(executionKey("conversation::A", "worker::1"))).toEqual({
      conversationId: "conversation::A",
      sessionId: "worker::1",
    });
  });

  it("共享页返回全部成员且拒绝跨会话成员", () => {
    const lead = executionKey("A", "main");
    const worker = executionKey("A", "writer");
    let bindings = applyTabBinding({}, lead, 8);
    bindings = applyTabBinding(bindings, worker, 8);
    expect(sessionsForTab(bindings, 8)).toEqual([lead, worker]);

    const exclusive = bindExclusiveResource({}, 8, lead);
    const shared = shareResource(exclusive, 8, lead, [worker]);
    expect(mayAccessResource(shared["8"], worker)).toBe(true);
    expect(() => shareResource(shared, 8, lead, [executionKey("B", "writer")])).toThrow(/同一会话/);
  });

  it("paused session 丢绑定页时不得认领别页", () => {
    expect(mayClaimReplacementTab({ blocked: true, boundMissing: true })).toBe(false);
    expect(mayClaimReplacementTab({ blocked: true, boundMissing: false })).toBe(false);
    expect(mayClaimReplacementTab({ blocked: false, boundMissing: true })).toBe(true);
  });
});
