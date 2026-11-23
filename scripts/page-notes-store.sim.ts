import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizePageNoteUrl,
  parsePageNotesStore,
  pickBestQuoteMatch,
  removePersistedNote,
  setPersistedNoteFolded,
  upsertPersistedNote,
  type PageNotesStore,
  type PersistedPageNote,
} from "../extension/src/shared/page-notes-store.js";

const sampleNote = (overrides: Partial<PersistedPageNote> = {}): PersistedPageNote => ({
  threadId: "t-1",
  quote: "关键结论",
  prefix: "前文提到的",
  suffix: "非常重要",
  question: "解释这段话",
  answer: "意思是把重点先说清楚。",
  folded: true,
  updatedAt: 1000,
  ...overrides,
});

describe("page notes persistence store and quote anchor matching", () => {
  it("normalizes http(s) URLs by stripping hashes and tracking params", () => {
    assert.equal(
      normalizePageNoteUrl("https://example.com/post?b=2&utm_source=x&a=1&fbclid=abc#section"),
      "https://example.com/post?a=1&b=2",
    );
    assert.equal(normalizePageNoteUrl("chrome://extensions"), null);
    assert.equal(normalizePageNoteUrl("not-a-url"), null);
  });

  it("upserts, updates fold state, deletes, and prunes pages by LRU", () => {
    const key = normalizePageNoteUrl("https://example.com/doc")!;
    let store: PageNotesStore = {};
    store = upsertPersistedNote(store, key, sampleNote({ threadId: "t-1", updatedAt: 100 }));
    store = upsertPersistedNote(store, key, sampleNote({ threadId: "t-1", answer: "更新后的批注", updatedAt: 200 }));
    assert.equal(store[key]?.length, 1);
    assert.equal(store[key]?.[0]?.answer, "更新后的批注");

    store = setPersistedNoteFolded(store, key, "t-1", false);
    assert.equal(store[key]?.[0]?.folded, false);

    store = removePersistedNote(store, key, "t-1");
    assert.equal(store[key], undefined);

    for (let i = 0; i < 45; i++) {
      store = upsertPersistedNote(store, `https://example.com/p/${i}`, sampleNote({ threadId: `t-${i}`, updatedAt: i + 1 }));
    }
    assert.equal(Object.keys(store).length, 40);
    assert.equal(store["https://example.com/p/0"], undefined);
    assert.ok(store["https://example.com/p/44"]);
  });

  it("validates untrusted storage payloads cleanly", () => {
    const parsed = parsePageNotesStore({
      "https://example.com/a?utm_campaign=1": [
        { threadId: "ok", quote: "原文", answer: "批注", updatedAt: 10 },
        { threadId: "", quote: "坏条目", answer: "忽略" },
      ],
      "javascript:alert(1)": [{ threadId: "bad", quote: "x", answer: "y" }],
    });
    assert.deepEqual(Object.keys(parsed), ["https://example.com/a"]);
    assert.equal(parsed["https://example.com/a"]?.length, 1);
    assert.equal(parsed["https://example.com/a"]?.[0]?.folded, true);
  });

  it("disambiguates repeated quotes using surrounding prefix and suffix", () => {
    const text = "第一段说核心指标增长显著，第二段说核心指标下降明显，第三段再提核心指标。";
    const idx = pickBestQuoteMatch(text, "核心指标", "第二段说", "下降明显");
    assert.equal(idx, text.indexOf("核心指标下降"));
    assert.equal(pickBestQuoteMatch(text, "不存在的片段", "", ""), -1);
  });
});
