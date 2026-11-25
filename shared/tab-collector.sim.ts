import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TabCollectorController, type CollectorSession } from "./tab-collector.js";

describe("TabCollectorController", () => {
  it("collects unique visited HTTP(S) tabs and jumps to cell source quotes", async () => {
    const snapshots: CollectorSession[] = [];
    const jumps: Array<{ tabId: number; quote: string }> = [];

    const controller = new TabCollectorController(
      async (tabId, fields) => ({
        tabId,
        url: `https://hotel.example.com/${tabId}`,
        title: `Hotel ${tabId}`,
        cells: Object.fromEntries(fields.map((f) => [f, { value: `${f}-${tabId}`, quote: `原文-${f}-${tabId}` }])),
      }),
      async (tabId, quote) => {
        jumps.push({ tabId, quote });
      },
      (session) => snapshots.push(session),
    );

    controller.start(["价格", "评分"]);
    assert.equal(await controller.onTabVisited(10, "https://hotel.example.com/10"), true);
    assert.equal(await controller.onTabVisited(10, "https://hotel.example.com/10"), false);
    assert.equal(await controller.onTabVisited(11, "chrome://settings"), false);
    assert.equal(await controller.onTabVisited(12, "https://hotel.example.com/12"), true);
    assert.equal(controller.snapshot.rows.length, 2);

    assert.equal(await controller.inspectCell(controller.snapshot.rows[1]!, "价格"), true);
    assert.deepEqual(jumps, [{ tabId: 12, quote: "原文-价格-12" }]);
  });
});
