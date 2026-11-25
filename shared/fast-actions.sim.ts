import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rankFastActionsForSite, recordFastActionUse, type LocalFastAction } from "./fast-actions.js";

describe("fast-actions ranking and usage", () => {
  it("ranks actions for the same site by runCount then lastUsedAt", () => {
    const initial: LocalFastAction[] = [
      { id: "a1", site: "example.com", name: "隐藏侧栏", payload: { kind: "page_transform", actions: [{ type: "hide_elements", selector: "aside" }] }, runCount: 1, lastUsedAt: 500 },
      { id: "a2", site: "example.com", name: "表格排序", payload: { kind: "page_transform", actions: [{ type: "enhance_table", selector: "table" }] }, runCount: 3, lastUsedAt: 200 },
      { id: "a3", site: "other.com", name: "别站动作", payload: { kind: "page_transform", actions: [{ type: "hide_elements", selector: ".ad" }] }, runCount: 10, lastUsedAt: 900 },
    ];

    assert.deepEqual(rankFastActionsForSite(initial, "example.com").map((a) => a.id), ["a2", "a1"]);

    const updated = recordFastActionUse(recordFastActionUse(recordFastActionUse(initial, "a1", 600), "a1", 700), "a1", 800);
    assert.deepEqual(rankFastActionsForSite(updated, "example.com").map((a) => a.id), ["a1", "a2"]);
  });
});
