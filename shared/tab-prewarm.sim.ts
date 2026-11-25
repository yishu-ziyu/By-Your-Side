import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TabSkeletonCache } from "./tab-prewarm.js";

describe("TabSkeletonCache", () => {
  it("prewarms most recently accessed HTTP(S) tabs up to the limit and serves cache hits", async () => {
    let clock = 1_000;
    const calls: number[] = [];
    const cache = new TabSkeletonCache(
      async (tabId) => {
        calls.push(tabId);
        return { url: `https://example.com/${tabId}`, title: `Page ${tabId}`, text: `Body ${tabId}`, totalChars: 100 };
      },
      { ttlMs: 10_000, maxPrewarmTabs: 2, now: () => clock },
    );

    const warmed = await cache.prewarmWindow([
      { id: 1, url: "chrome://extensions", lastAccessed: 900 },
      { id: 2, url: "https://example.com/2", lastAccessed: 100 },
      { id: 3, url: "https://example.com/3", lastAccessed: 500 },
      { id: 4, url: "https://example.com/4", lastAccessed: 300 },
    ]);

    assert.equal(warmed, 2);
    assert.deepEqual(calls.sort((a, b) => a - b), [3, 4]);
    assert.equal(cache.get(3, "https://example.com/3")?.text, "Body 3");
    assert.equal(cache.get(2), null);

    await cache.warmOne(3, "https://example.com/3");
    assert.equal(calls.length, 2);
  });

  it("invalidates entries after TTL expiration or URL change", async () => {
    let clock = 1_000;
    const cache = new TabSkeletonCache(
      async (tabId) => ({ url: `https://example.com/${tabId}`, title: "T", text: "Hello", totalChars: 5 }),
      { ttlMs: 5_000, now: () => clock },
    );

    await cache.warmOne(7, "https://example.com/7");
    assert.ok(cache.get(7, "https://example.com/7"));
    assert.equal(cache.get(7, "https://example.com/other"), null);

    await cache.warmOne(7, "https://example.com/7");
    clock += 6_000;
    assert.equal(cache.get(7, "https://example.com/7"), null);
  });

  it("deduplicates concurrent warmOne calls for the same tab", async () => {
    let calls = 0;
    const cache = new TabSkeletonCache(async (tabId) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { url: `https://example.com/${tabId}`, title: "T", text: "Content", totalChars: 7 };
    });

    const [a, b] = await Promise.all([cache.warmOne(9), cache.warmOne(9)]);
    assert.equal(calls, 1);
    assert.equal(a?.text, "Content");
    assert.equal(b?.text, "Content");
  });
});
