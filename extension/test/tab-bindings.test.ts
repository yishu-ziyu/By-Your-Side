import { describe, expect, it } from "vitest";
import { applyTabBinding, boundTabIds, sessionForTab } from "../src/background/tab-bindings.js";
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
});
