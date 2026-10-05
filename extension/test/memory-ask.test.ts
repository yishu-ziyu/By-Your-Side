import { describe, expect, it } from "vitest";
import type { MemoryEntry, MemoryScope } from "../../shared/memory.js";
import { createAskCard, stepAsk, type AskInput, type MemoryAskCard, type MemoryAskEvent } from "../src/sidepanel/memory-ask.js";

/*
 * 询问卡片可能出错的方式（先列出，再写实现）：
 * 1. 连点「记住」（或记住后连点范围 / 撤销）发出两次请求。
 * 2. 回答失败后按钮一直禁用，用户没法再点。
 * 3. 结果被判作过期或不属于这次请求（被忽略）时，卡片永远停在「等待中」。
 * 4. 后台说成功但没带新条目，卡片却显示「记住了」。
 * 5. 结果晚到时卡片已不在等待，被覆盖。
 * 6. 同样的做法早已存在（alreadySaved）时仍给撤销或范围切换，撤销会删掉用户早先记的那条。
 * 7. 替换过旧做法时，撤销把新条目忘掉，而不是把旧的恢复回来。
 * 8. 改范围后丢了新版本号，撤销撞版本冲突。
 * 9. 范围切回「这个网站」用了用户此刻所在的标签页，而不是纠正发生的网站；没有网站时造出空域名。
 * 10. 后台已作废的询问（askClosed）还留着按钮，或被当成可重试的错误。
 * 11. 撤销之后、或选了「这次就行」之后还能发请求。
 * 12. 回放出来的结局事件（记下了 / 早已记着 / 这次就行 / 已作废）没有让卡片停在结局，仍给按钮；
 *     或回放的「记下了」给出撤销（之后可能改过，撤销会弄错）。
 * 13. 结局事件盖掉了活卡片：已记住并带撤销的卡片被降成无按钮；等结果时先到的结局让随后的结果被丢掉、撤销没了。
 * 14. 等结果时结局已到、结果却丢了（被忽略或失败），卡片退回可点，再点会重复保存。
 * 15. 没有结局的询问（侧栏重开后也一样）不可点。
 * 16. 「改一下」后点「记住」，发出去的仍是原来的规则文字；改的文字被拒（空白、像密码）后草稿丢了，或询问不能再点。
 * 17. 已有结果或等待中的卡片还能进入修改。
 */

const site = (hostname: string): MemoryScope => ({ kind: "site", hostname });

function method(id: string, version: number, scope: MemoryScope, status: MemoryEntry["status"] = "active"): MemoryEntry {
  return {
    id,
    factId: `fact-${id}`,
    version,
    text: `rule-${id}`,
    scope,
    sourceConversationId: "c1",
    createdAt: 1,
    updatedAt: 1,
    kind: "method",
    useCount: 0,
    status,
    formatVersion: 3,
  };
}

function ask(extra: Partial<Pick<MemoryAskEvent, "scope" | "replaces" | "hostname">> = {}): MemoryAskCard {
  const event: MemoryAskEvent = { kind: "memory_ask", askId: "ask-1", rule: "以后在这个网站导出，我都先选全部再核对条数。", scope: extra.scope ?? site("crm.test") };

  if (extra.replaces) event.replaces = extra.replaces;

  if (extra.hostname) event.hostname = extra.hostname;

  return createAskCard(event);
}

/** 按顺序喂输入，返回最后的卡片和每一步发出的请求。 */
function run(card: MemoryAskCard, ...inputs: AskInput[]) {
  const requests = [];

  for (const input of inputs) {
    const step = stepAsk(card, input);
    card = step.card;
    requests.push(step.request ?? null);
  }

  return { card, requests };
}

const ok = (entry?: MemoryEntry, entries?: MemoryEntry[], alreadySaved?: true): AskInput => ({ kind: "result", ok: true, entry, entries, alreadySaved });

const fail = (error: string): AskInput => ({ kind: "result", ok: false, error });

describe("memory ask card", () => {
  it("sends one answer even when clicked twice", () => {
    const { card, requests } = run(ask(), { kind: "remember" }, { kind: "remember" }, { kind: "once" });
    expect(requests).toEqual([{ type: "answer", answer: "remember" }, null, null]);
    expect(card.pending).toBe("remember");
  });

  it("re-enables the buttons with the backend's words when the answer fails", () => {
    const { card, requests } = run(ask(), { kind: "remember" }, fail("这条询问已失效，请再说一次"), { kind: "remember" });
    expect(card.error).toBe("");
    expect(requests[2]).toEqual({ type: "answer", answer: "remember" });
    expect(run(ask(), { kind: "remember" }, fail("这条询问已失效，请再说一次")).card).toMatchObject({ phase: "open", pending: null, error: "这条询问已失效，请再说一次" });
  });

  it("never stays waiting when the result is ignored", () => {
    const answered = run(ask(), { kind: "once" }, { kind: "ignored" }).card;
    expect(answered).toMatchObject({ phase: "open", pending: null });
    expect(answered.error).not.toBe("");

    const remembered = run(ask(), { kind: "remember" }, ok(method("new", 1, site("crm.test")), [method("new", 1, site("crm.test"))])).card;

    for (const action of [{ kind: "scope" }, { kind: "undo" }] as const) {
      const after = run(remembered, action, { kind: "ignored" }).card;
      expect(after).toMatchObject({ phase: "remembered", pending: null });
      expect(after.error).not.toBe("");
      expect(stepAsk(after, action).request).toBeDefined();
    }
  });

  it("does not claim success when the result carries no new rule", () => {
    const { card } = run(ask(), { kind: "remember" }, ok());
    expect(card.phase).toBe("open");
    expect(card.error).not.toBe("");
  });

  it("ignores a result that arrives when nothing is waiting", () => {
    const card = ask();
    expect(stepAsk(card, fail("x")).card).toBe(card);
  });

  it("an already-saved rule offers neither undo nor scope switching", () => {
    const old = method("old", 4, site("crm.test"));
    const { card, requests } = run(ask({ hostname: "crm.test" }), { kind: "remember" }, ok(old, [old], true), { kind: "undo" }, { kind: "scope" });
    expect(card.phase).toBe("already");
    expect(card.entry?.id).toBe("old");
    expect(requests.slice(2)).toEqual([null, null]);
  });

  it("undo after a replacement restores the old rule instead of forgetting the new one", () => {
    const { requests } = run(ask({ replaces: { id: "old", text: "导出只导当前页" } }),
      { kind: "remember" },
      ok(method("new", 1, site("crm.test")), [method("new", 1, site("crm.test")), method("old", 3, site("crm.test"), "replaced")]),
      { kind: "undo" });

    expect(requests[2]).toEqual({ type: "restore", entry: { id: "old", version: 3 } });
  });

  it("undo without a replacement forgets the new rule at its latest version", () => {
    const { card, requests } = run(ask({ hostname: "crm.test" }),
      { kind: "remember" },
      ok(method("new", 1, site("crm.test")), [method("new", 1, site("crm.test"))]),
      { kind: "scope" },
      { kind: "scope" },
      ok(method("new", 2, { kind: "all" })),
      { kind: "undo" },
      { kind: "undo" },
      { kind: "result", ok: true });

    expect(requests[2]).toEqual({ type: "update", entry: { id: "new", version: 1 }, text: "rule-new", scope: { kind: "all" } });
    expect(requests[3]).toBeNull();
    expect(requests[5]).toEqual({ type: "forget", entry: { id: "new", version: 2 } });
    expect(requests[6]).toBeNull();
    expect(card.phase).toBe("undone");
  });

  it("switches back to the site where the correction happened, never to some other tab", () => {
    const remembered = (event: MemoryAskCard, scope: MemoryScope) => run(event, { kind: "remember" }, ok(method("new", 1, scope), [method("new", 1, scope)])).card;

    expect(stepAsk(remembered(ask({ scope: { kind: "all" }, hostname: "shop.test" }), { kind: "all" }), { kind: "scope" }).request)
      .toEqual({ type: "update", entry: { id: "new", version: 1 }, text: "rule-new", scope: site("shop.test") });
    expect(stepAsk(remembered(ask({ scope: { kind: "all" } }), { kind: "all" }), { kind: "scope" }).request).toBeUndefined();
  });

  it("keeps the old version and says so when the scope change fails", () => {
    const { card, requests } = run(ask({ hostname: "crm.test" }),
      { kind: "remember" },
      ok(method("new", 1, site("crm.test")), [method("new", 1, site("crm.test"))]),
      { kind: "scope" },
      fail("版本冲突"),
      { kind: "undo" });

    expect(card.error).toBe("");
    expect(requests[4]).toEqual({ type: "forget", entry: { id: "new", version: 1 } });
    expect(run(ask(), { kind: "remember" }, ok(method("new", 1, site("crm.test"))), { kind: "scope" }, fail("版本冲突")).card.error).toContain("版本冲突");
  });

  it("an ask without an outcome stays answerable", () => {
    expect(stepAsk(ask(), { kind: "remember" }).request).toEqual({ type: "answer", answer: "remember" });
  });

  it("outcome events put a card with no local state into its end state, with nothing to click", () => {
    const ends = [["remembered", "noted"], ["already", "already"], ["once", "once"], ["closed", "closed"]] as const;

    for (const [outcome, phase] of ends) {
      const { card, requests } = run(ask(), { kind: "outcome", outcome }, { kind: "remember" }, { kind: "once" }, { kind: "undo" }, { kind: "scope" });
      expect(card.phase).toBe(phase);
      expect(requests.slice(1)).toEqual([null, null, null, null]);
    }
  });

  it("a later outcome leaves a live remembered card (with its undo) as it is", () => {
    const live = run(ask(), { kind: "remember" }, ok(method("new", 1, site("crm.test")))).card;
    const after = stepAsk(live, { kind: "outcome", outcome: "remembered" }).card;
    expect(after).toBe(live);
    expect(stepAsk(after, { kind: "undo" }).request).toEqual({ type: "forget", entry: { id: "new", version: 1 } });
  });

  it("an outcome that beats the result does not lose the result", () => {
    const { card } = run(ask(), { kind: "remember" }, { kind: "outcome", outcome: "remembered" }, ok(method("new", 1, site("crm.test"))));
    expect(card.phase).toBe("remembered");
    expect(stepAsk(card, { kind: "undo" }).request).toBeDefined();
  });

  it("if the outcome arrived but the result is lost, the card ends instead of offering a second save", () => {
    expect(run(ask(), { kind: "remember" }, { kind: "outcome", outcome: "remembered" }, { kind: "ignored" }).card.phase).toBe("noted");
    expect(run(ask(), { kind: "once" }, { kind: "outcome", outcome: "once" }, fail("连接不可用")).card.phase).toBe("once");
  });

  it("a closed ask from the backend ends the card with the backend's words; other errors stay retryable", () => {
    const closed = run(ask(), { kind: "remember" }, { kind: "result", ok: false, error: "这条询问已失效，请再说一次", askClosed: true }, { kind: "remember" });
    expect(closed.card).toMatchObject({ phase: "closed", pending: null, error: "这条询问已失效，请再说一次" });
    expect(closed.requests[2]).toBeNull();

    expect(run(ask(), { kind: "remember" }, fail("连接不可用")).card.phase).toBe("open");
  });

  it("a closing outcome while waiting ends the card", () => {
    const { card, requests } = run(ask(), { kind: "remember" }, { kind: "outcome", outcome: "closed" }, ok(method("new", 1, site("crm.test"))), { kind: "remember" });
    expect(card.phase).toBe("closed");
    expect(requests[3]).toBeNull();
  });

  it("after 这次就行 or a finished undo nothing more can be sent; a failed undo can be retried", () => {
    const once = run(ask(), { kind: "once" }, { kind: "result", ok: true }, { kind: "undo" }, { kind: "scope" }, { kind: "remember" });
    expect(once.card.phase).toBe("once");
    expect(once.requests.slice(2)).toEqual([null, null, null]);

    const base = run(ask(), { kind: "remember" }, ok(method("new", 1, site("crm.test")))).card;
    const failed = run(base, { kind: "undo" }, fail("连接不可用，请重试"));
    expect(failed.card).toMatchObject({ phase: "remembered", pending: null });
    expect(failed.card.error).toContain("连接不可用");
    expect(stepAsk(failed.card, { kind: "undo" }).request).toEqual({ type: "forget", entry: { id: "new", version: 1 } });
  });

  it("「改一下」 starts from the asked rule and 「记住」 sends the edited words; a refusal keeps the draft and stays answerable (16)", () => {
    const editing = run(ask(), { kind: "edit" });
    expect(editing.requests).toEqual([null]);
    expect(editing.card).toMatchObject({ phase: "open", draft: "以后在这个网站导出，我都先选全部再核对条数。" });

    const refused = run(editing.card, { kind: "remember", text: "   " }, fail("改后的内容是空的，没有记下"));
    expect(refused.requests[0]).toEqual({ type: "answer", answer: "remember", text: "   " });
    expect(refused.card).toMatchObject({ phase: "open", pending: null, draft: "   ", error: "改后的内容是空的，没有记下" });

    const saved = run(refused.card, { kind: "remember", text: "导出时选全部并勾选附件" }, ok(method("new", 1, site("crm.test"))));
    expect(saved.requests[0]).toEqual({ type: "answer", answer: "remember", text: "导出时选全部并勾选附件" });
    expect(saved.card.phase).toBe("remembered");
  });

  it("cannot start editing while waiting or after the ask is answered (17)", () => {
    expect(run(ask(), { kind: "remember" }, { kind: "edit" }).card.draft).toBeUndefined();
    expect(run(ask(), { kind: "once" }, { kind: "result", ok: true }, { kind: "edit" }).card.draft).toBeUndefined();
  });
});
