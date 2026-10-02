/**
 * 纠正后开口问「要我记住吗」（docs/evals/20261001-remember-corrections.md 共用约定）。只看对外结果：发出的事件、存储、诊断记录。
 *
 * 先列出会出错的方式，下面每条用例对应其中一条或几条：
 * F1 不像纠正的话也去问模型、出询问。
 * F2 带密码的纠正仍问模型，或原话进了存储、补判队列、诊断记录。
 * F3 询问在这一轮结束前发出（抢在回答前面）。
 * F4 算询问期间用户又发了话、停止或接管，过时的询问仍发出。
 * F5 这句话已被自动记下，仍再问一次（一句两种结果）。
 * F6 模型说不是纠正、不可复用、依据不是原话、规则里带秘密时仍出询问。
 * F7 回过「这次就行」后，同一对话里同一条又问。
 * F8 同范围已有同样的生效做法，仍问。
 * F9 点「记住」存的字段不对（种类、范围、来源原话、用过次数、状态），或不认识的询问编号也能写入、同一询问能写两次。
 * F10 替换时旧条目没标「被替换」、不属同一件事，撤销后旧条目没回来。
 * F11 默认范围错：没有网站却给了网站范围，或关于网站的做法给了所有网站。
 * F12 用户确认的网站做法在本网站因字面不相关没带上，或带到了别的网站；带上没记「用过」。
 * F13 诊断记录里出现用户原话。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryRuntime } from "../src/memory-runtime.js";
import { MEMORY_STORE_FILE, MemoryStore } from "../src/memory-store.js";
import { FileDocument } from "../src/document-file.js";
import { InProcessLock, type DocumentPersistence } from "../src/document-persistence.js";
import type { AgentUiEvent, PageContext, ServerMessage } from "../../shared/protocol.js";
import { ConversationManager } from "../src/conversation-manager.js";
import type { CorrectionVerdict } from "../src/memory-correction.js";
import { MEMORY_CORRECTION_RULES, type MemoryDecision } from "../src/memory-decision.js";
import { TASK_HISTORY_FILE, TaskHistoryStore } from "../src/task-history.js";
import type { TaskHistoryEntry } from "../../shared/task-history.js";

const CRM: PageContext = { tabId: 1, title: "客户名单", url: "https://crm.example/customers" };

const OTHER: PageContext = { tabId: 2, title: "别的系统", url: "https://other.example/list" };

const correction = "不对，只导了当前页 20 条，页面一共 200 条，我要全部";

const rule = "以后在这个网站导出，我都先选全部再核对条数";

const ASK_PROMPT_START = "You review a direct user correction of the assistant";

const none: MemoryDecision = { action: "none", text: "", evidence: "", scope: { kind: "all" }, targets: [], taskRequested: true };

type Verdict = CorrectionVerdict;

type Record_ = Parameters<NonNullable<MemoryRuntime["onRecord"]>>[1];

/** 测试里接住的运行时事件处理：一轮开始、结束，以及开工前加记忆。 */
type Handler = (event: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined> | undefined;

const verdict = (patch: Partial<Verdict> = {}): Verdict => ({ correction: true, reusable: true, about: "site", rule, evidence: "只导了当前页 20 条", replaces: null, ...patch });

const roots: string[] = [];

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

/** 补判队列的存放处：看得到里面写了什么。 */
class Doc implements DocumentPersistence {
  text: string | null = null;
  private readonly lock = new InProcessLock();
  async read() { return this.text; }
  exclusive<T>(fn: () => Promise<T>) { return this.lock.run(fn); }
  async write(text: string) { this.text = text; }
}

async function newStore() {
  const root = await mkdtemp(join(tmpdir(), "sideagent-correction-ask-")); roots.push(root);

  return new MemoryStore(new FileDocument(root, MEMORY_STORE_FILE));
}

async function fixture(options: { verdict?: Verdict; reply?: () => Promise<string>; auto?: MemoryDecision; autoFails?: boolean; store?: MemoryStore } = {}) {
  const store = options.store ?? await newStore();
  const events: AgentUiEvent[] = [];
  const records: Array<{ type: string; data: Record_ }> = [];
  const pending = new Doc();

  const complete = vi.fn(async (system: string, _input: string, _signal: AbortSignal) => {
    if (system.startsWith(ASK_PROMPT_START)) return options.reply ? options.reply() : JSON.stringify(options.verdict ?? verdict());

    if (options.autoFails) throw new Error("upstream 503");

    return JSON.stringify(options.auto ?? none);
  });

  /** 询问事件与面板结果的先后顺序（面板结果由 managerFor 写进来）。 */
  const trace: string[] = [];

  const runtime = new MemoryRuntime(store, "conv-a", event => {
    events.push(event);

    if (event.kind === "memory_ask") trace.push(`ask:${event.outcome ?? "open"}`);
  }, complete, { auto: true, pending });

  runtime.onRecord = (type, data) => records.push({ type, data });
  const registered = new Map<string, Handler>();
  // SAFETY: extension() 只调用 pi.on 登记处理函数；测试只提供这一个方法。
  runtime.extension()({ on: (name: string, fn: Handler) => { registered.set(name, fn); } } as never);
  const handlers = { agent_start: () => registered.get("agent_start")?.({ systemPrompt: "" }), agent_settled: () => registered.get("agent_settled")?.({ systemPrompt: "" }), before_agent_start: (event: { systemPrompt: string }) => registered.get("before_agent_start")?.(event) };

  const askCalls = () => complete.mock.calls.filter(([system]) => system.startsWith(ASK_PROMPT_START));
  const askEvents = () => events.filter((e): e is Extract<AgentUiEvent, { kind: "memory_ask" }> => e.kind === "memory_ask");
  /** 发出的询问（还没结局的那一条）；有结局时后台另发同 askId、带 outcome 的一条。 */
  const asks = () => askEvents().filter(e => e.outcome === undefined);
  const outcomes = () => askEvents().filter(e => e.outcome !== undefined);
  const decisions = () => records.flatMap(r => (r.type === "memory_ask_decision" ? [r.data] : []));

  /** 用户说一句、这一轮结束，等这句的询问决定落定。 */
  const say = async (text: string, context: PageContext | null = CRM, recentTurns: Array<{ role: "user" | "assistant"; text: string }> = []) => {
    const before = decisions().length;
    runtime.beginUserTurn(text, context ?? undefined, recentTurns);
    await handlers.agent_start();
    await handlers.agent_settled();
    await vi.waitFor(() => expect(decisions().length).toBeGreaterThan(before));

    return decisions().at(-1)!;
  };

  const carried = async (text: string, context: PageContext) => {
    runtime.beginUserTurn(text, context);
    const result = await handlers.before_agent_start({ systemPrompt: "base" });

    return result?.systemPrompt ?? "base";
  };

  return { store, runtime, events, records, pending, complete, handlers, askCalls, asks, outcomes, decisions, say, carried, trace };
}

describe("asking after a direct correction", () => {
  it("asks only after the turn settles, with the site scope and a quote-free record (F3, F11, F13)", async () => {
    const f = await fixture();
    f.runtime.beginUserTurn(correction, CRM, [{ role: "user", text: "把客户名单导出来" }, { role: "assistant", text: "已导出 20 条。" }]);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.askCalls()).toHaveLength(0);
    expect(f.asks()).toHaveLength(0);

    await f.handlers.agent_settled();
    await vi.waitFor(() => expect(f.asks()).toHaveLength(1));
    const ask = f.asks()[0]!;
    expect(ask).toEqual({ kind: "memory_ask", askId: expect.any(String), rule, scope: { kind: "site", hostname: "crm.example" }, hostname: "crm.example" });
    expect(JSON.parse(f.askCalls()[0]![1])).toEqual({
      userMessage: correction,
      recentTurns: [{ role: "user", text: "把客户名单导出来" }, { role: "assistant", text: "已导出 20 条。" }],
      currentHostname: "crm.example",
      methods: [],
    });
    expect(f.decisions()).toEqual([expect.objectContaining({ status: "asked", askId: ask.askId })]);
    expect(JSON.stringify(f.records)).not.toContain("只导了当前页");
    expect(await f.store.list()).toEqual([]);
  });

  it.each([
    ["assistant", CRM, { kind: "all" }],
    ["assistant", null, { kind: "all" }],
  ] as const)("about=%s defaults to the right scope (F11)", async (about, context, scope) => {
    const f = await fixture({ verdict: verdict({ about, rule: "以后我都用中文回复你" }) });
    expect(await f.say(correction, context)).toMatchObject({ status: "asked" });
    expect(f.asks()[0]!.scope).toEqual(scope);
    // 纠正发生的网站随询问带上（面板把范围切回「这个网站」用它）；没有网站就不带。
    expect(f.asks()[0]!.hostname).toBe(context ? "crm.example" : undefined);
  });

  const NOT_WEB: PageContext[] = [
    { tabId: 9, title: "语音权限", url: "chrome-extension://mbjgiikhmkpgkjbaochpogefpaghokfd/voice-permission.html" },
    { tabId: 9, title: "设置", url: "chrome://settings" },
    { tabId: 9, title: "", url: "about:blank" },
  ];

  it.each(NOT_WEB)("a page that is not a web page ($url) is no site: a site rule is not asked without a site the agent worked on (F11)", async page => {
    const f = await fixture();
    expect(await f.say(correction, page)).toMatchObject({ status: "skipped", reason: "no-site" });
    expect(f.asks()).toHaveLength(0);
    expect(JSON.parse(f.askCalls()[0]![1]).currentHostname).toBeNull();
  });

  it.each(NOT_WEB)("on a non-web page ($url) a site rule takes the last web page the agent worked on; a rule about the assistant is all sites (F11)", async page => {
    const f = await fixture();
    f.runtime.bindVisitedUrls(() => ["https://crm.example/customers", "https://crm.example/export?all=1", page.url]);
    await f.say(correction, page);
    expect(f.asks()[0]).toMatchObject({ scope: { kind: "site", hostname: "crm.example" }, hostname: "crm.example" });

    const g = await fixture({ verdict: verdict({ about: "assistant", rule: "以后我都用中文回复你" }) });
    await g.say(correction, page);
    expect(g.asks()[0]!.scope).toEqual({ kind: "all" });
    expect(g.asks()[0]!.hostname).toBeUndefined();
  });

  it("gives the auto memory judgment the correction rule only for correction-gated messages, then still asks (F5)", async () => {
    const said = "你漏了「备注」那一栏，每次都要填";
    const f = await fixture({ verdict: verdict({ rule: "以后在这个网站填表，我都会填上备注", evidence: "你漏了「备注」那一栏" }) });
    expect(await f.say(said)).toMatchObject({ status: "asked" });
    const autoSystems = f.complete.mock.calls.filter(([system]) => !system.startsWith(ASK_PROMPT_START)).map(([system]) => system);
    expect(autoSystems).toHaveLength(1);
    expect(autoSystems[0]!.endsWith(`\n${MEMORY_CORRECTION_RULES}`)).toBe(true);

    await f.say("我的邮箱是 lin@example.test，以后都用它");
    const plain = () => f.complete.mock.calls.filter(([system]) => !system.startsWith(ASK_PROMPT_START)).map(([system]) => system);
    await vi.waitFor(() => expect(plain()).toHaveLength(2));
    expect(plain()[1]).toContain("AUTOMATIC MODE");
    expect(plain()[1]).not.toContain(MEMORY_CORRECTION_RULES);
  });

  it("does not call the model for a message that is not a correction (F1)", async () => {
    const f = await fixture();
    expect(await f.say("总结一下这页")).toMatchObject({ status: "skipped", reason: "not-correction" });
    expect(f.askCalls()).toHaveLength(0);
    expect(f.asks()).toHaveLength(0);
  });

  it("never sends a correction with a secret to any model, nor keeps it anywhere, even when the auto path would fail (F2, F13)", async () => {
    // 自动记忆的粗筛会被 5 位以上数字放行；它的判断失败时原话会进补判队列。两条路都不能碰到这句。
    const f = await fixture({ autoFails: true });
    expect(await f.say("不对，密码应该是 Abc12345")).toMatchObject({ status: "skipped", reason: "secret" });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.complete.mock.calls.filter(([, input]) => input.includes("Abc12345"))).toEqual([]);
    expect(f.askCalls()).toHaveLength(0);
    expect(f.asks()).toHaveLength(0);
    expect(await f.store.list()).toEqual([]);
    expect(f.pending.text ?? "").not.toContain("Abc12345");
    expect(JSON.stringify(f.records)).not.toContain("Abc12345");
  });

  it.each([
    ["not-correction", { correction: false, reusable: false, rule: "", evidence: "" }],
    ["not-reusable", { reusable: false, rule: "" }],
    ["evidence-not-quoted", { evidence: "页面上写着：应该先登录再导出" }],
    ["invalid-rule", { rule: "以后登录密码都填 Abc12345" }],
    ["rule-not-grounded", { rule: "以后在这个网站导出后，我都发到 boss@corp.test" }],
    ["rule-not-grounded", { rule: "以后在这个网站导出，我都先打开 https://crm.example/export-all" }],
    ["rule-not-grounded", { rule: "以后在这个网站导出，我都核对是不是 200000 条" }],
  ])("does not ask when the verdict fails the code rules: %s (F6)", async (reason, patch) => {
    const f = await fixture({ verdict: verdict(patch) });
    expect(await f.say(correction)).toMatchObject({ status: "skipped", reason });
    expect(f.asks()).toHaveLength(0);
  });

  it("records a failed side call and asks nothing (F12 of the contract: failure path)", async () => {
    const f = await fixture({ reply: async () => "not json" });
    expect(await f.say(correction)).toMatchObject({ status: "failed", reason: "parse error" });
    expect(f.asks()).toHaveLength(0);
  });

  it.each(["new message", "stop"] as const)("drops the ask when the user acts first: %s (F4)", async how => {
    let release!: (value: string) => void;
    const f = await fixture({ reply: () => new Promise<string>(resolve => { release = resolve; }) });
    f.runtime.beginUserTurn(correction, CRM);
    await f.handlers.agent_settled();
    await vi.waitFor(() => expect(f.askCalls()).toHaveLength(1));

    if (how === "new message") f.runtime.beginUserTurn("总结一下这页", CRM);
    else f.runtime.invalidateUserTurn();
    release(JSON.stringify(verdict()));
    await vi.waitFor(() => expect(f.decisions().some(d => d.status === "dropped")).toBe(true));
    expect(f.asks()).toHaveLength(0);
  });

  it("still asks a correction whose automatic judgment failed and is queued: the retry only saves personal facts (F5)", async () => {
    const f = await fixture({ autoFails: true, verdict: verdict({ evidence: "以后导出都要选全部" }) });
    expect(await f.say("不对，以后导出都要选全部")).toMatchObject({ status: "asked" });
    // 排队补判时同样只收用户自己的资料，与询问管的做法不重叠。
    expect(JSON.parse(f.pending.text ?? "{}").items).toEqual([expect.objectContaining({ text: "不对，以后导出都要选全部", correction: true })]);
    expect(f.asks()).toHaveLength(1);
  });

  it("asks before saving a way of replying even when automatic classification says personal (F5)", async () => {
    const said = "不对，以后都用中文回复我";
    const auto: MemoryDecision = { action: "save", text: "回复用中文", evidence: "以后都用中文回复我", scope: { kind: "all" }, targets: [], taskRequested: false, about: { longTerm: true, date: null, onlyThisTask: false, explicitRequest: true, dateIsTheTask: false } };
    const f = await fixture({ auto, verdict: verdict({ about: "assistant", rule: "以后我都用中文回复你", evidence: "以后都用中文回复我" }) });
    expect(await f.say(said)).toMatchObject({ status: "asked" });
    expect(await f.store.list()).toEqual([]);
    expect(f.events.some(e => e.kind === "memory" && e.action === "saved")).toBe(false);
    expect(f.askCalls()).toHaveLength(1);
    expect(f.asks()).toHaveLength(1);
  });
});

describe("answering the ask", () => {
  it("「这次就行」 saves nothing and the same rule is not asked again here (F7)", async () => {
    const f = await fixture();
    await f.say(correction);
    const askId = f.asks()[0]!.askId;
    expect(await f.runtime.answerAsk(askId, "once")).toEqual({});
    expect(await f.store.list()).toEqual([]);

    expect(await f.say(correction)).toMatchObject({ status: "skipped", reason: "dismissed" });
    expect(f.asks()).toHaveLength(1);
    await expect(f.runtime.answerAsk(askId, "remember")).rejects.toThrow("这条询问已失效，请再说一次");
  });

  it("「这次就行」 and an open ask also dedupe on the user's message, whatever the model words the rule as (F7)", async () => {
    const wordings = [rule, "以后在这个网站导出，我都会先全选，再核对条数", "以后导出时我先选中全部再核对总数"];
    let n = 0;
    const f = await fixture({ reply: async () => JSON.stringify(verdict({ rule: wordings[n++ % wordings.length]! })) });
    await f.say(correction);
    // 还没回答时同一句再说：旧询问作废（发 closed），问新的。
    expect(await f.say(correction)).toMatchObject({ status: "asked" });
    const [first, second] = f.asks();
    expect(f.outcomes()).toEqual([{ ...first, outcome: "closed" }]);
    await expect(f.runtime.answerAsk(first!.askId, "remember")).rejects.toThrow("这条询问已失效，请再说一次");
    await f.runtime.answerAsk(second!.askId, "once");
    expect(await f.say(` ${correction} `)).toMatchObject({ status: "skipped", reason: "dismissed" });
    expect(f.asks()).toHaveLength(2);
    expect(await f.store.list()).toEqual([]);
  });

  it.each([["once", "dismissed"], ["remember", "already-remembered"]] as const)("an answer (%s) that lands while the re-ask is being judged stops the new ask (F7)", async (answer, reason) => {
    let release!: (value: string) => void;
    let n = 0;

    const f = await fixture({ reply: async () => {
      n += 1;

      return n === 1 ? JSON.stringify(verdict()) : new Promise<string>(resolve => { release = resolve; });
    } });

    await f.say(correction);
    const first = f.asks()[0]!;
    f.runtime.beginUserTurn(correction, CRM);
    await f.handlers.agent_settled();
    await vi.waitFor(() => expect(f.askCalls()).toHaveLength(2));
    await f.runtime.answerAsk(first.askId, answer);
    release(JSON.stringify(verdict({ rule: "以后在这个网站导出，我都会先全选，再核对条数" })));

    await vi.waitFor(() => expect(f.decisions().at(-1)).toMatchObject({ status: "skipped", reason }));
    expect(f.asks()).toEqual([first]);
  });

  it("after 「记住」 the same message is not asked again even if the model words the rule differently (F7)", async () => {
    const wordings = [rule, "以后在这个网站导出，我都会先全选，再核对条数"];
    let n = 0;
    const f = await fixture({ reply: async () => JSON.stringify(verdict({ rule: wordings[n++ % wordings.length]! })) });
    await f.say(correction);
    await f.runtime.answerAsk(f.asks()[0]!.askId, "remember");
    expect(await f.say(correction)).toMatchObject({ status: "skipped", reason: "already-remembered" });
    expect(f.askCalls()).toHaveLength(1);
  });

  it("each end state is announced as a second memory_ask with the same fields plus outcome (F9)", async () => {
    const remembered = await fixture();
    await remembered.say(correction);
    await remembered.runtime.answerAsk(remembered.asks()[0]!.askId, "remember");
    expect(remembered.outcomes()).toEqual([{ ...remembered.asks()[0], outcome: "remembered" }]);

    const once = await fixture();
    await once.say(correction);
    await once.runtime.answerAsk(once.asks()[0]!.askId, "once");
    expect(once.outcomes()).toEqual([{ ...once.asks()[0], outcome: "once" }]);

    const already = await fixture();
    await already.say(correction);
    await already.store.create({ text: rule, scope: { kind: "site", hostname: "crm.example" }, sourceConversationId: "conv-b", kind: "method", sourceQuote: "别的对话里记下的" });
    await already.runtime.answerAsk(already.asks()[0]!.askId, "remember");
    expect(already.outcomes()).toEqual([{ ...already.asks()[0], outcome: "already" }]);
  });

  it("takes the site from the current page, not from a URL typed in the message (F11)", async () => {
    const said = "不对，https://other.example/list 这页只导了当前页 20 条，我要全部";
    const f = await fixture();
    await f.say(said, CRM);
    expect(f.asks()[0]).toMatchObject({ scope: { kind: "site", hostname: "crm.example" }, hostname: "crm.example" });
    expect(JSON.parse(f.askCalls()[0]![1]).currentHostname).toBe("crm.example");
  });

  it("drops earlier user turns that look secret before any model sees recentTurns (F2)", async () => {
    const f = await fixture({ verdict: verdict({ evidence: "以后导出都要选全部" }) });
    const turns = [{ role: "user" as const, text: "我的密码是 Abc12345" }, { role: "assistant" as const, text: "好的，已登录。" }];
    await f.say("不对，以后导出都要选全部", CRM, turns);
    expect(f.complete.mock.calls.length).toBe(2);
    expect(f.complete.mock.calls.filter(([, input]) => input.includes("Abc12345"))).toEqual([]);
    expect(JSON.parse(f.askCalls()[0]![1]).recentTurns).toEqual([{ role: "assistant", text: "好的，已登录。" }]);
  });

  it("「记住」 stores one confirmed method with the correction as its source; the ask is then spent (F9)", async () => {
    const f = await fixture();
    await f.say(correction);
    const askId = f.asks()[0]!.askId;
    const answer = await f.runtime.answerAsk(askId, "remember");
    const stored = await f.store.list();

    expect(stored).toHaveLength(1);
    expect(stored[0]).toEqual({
      id: expect.any(String), factId: stored[0]!.id, version: 1, text: rule, scope: { kind: "site", hostname: "crm.example" },
      sourceConversationId: "conv-a", createdAt: expect.any(Number), updatedAt: expect.any(Number),
      kind: "method", sourceQuote: correction, useCount: 0, status: "active", formatVersion: 3,
    });
    expect(answer).toEqual({ entry: stored[0], entries: [stored[0]], rev: 1 });
    await expect(f.runtime.answerAsk(askId, "remember")).rejects.toThrow("这条询问已失效，请再说一次");
    expect(await f.store.list()).toHaveLength(1);

    // 换一句话，模型总结出同范围已有的同一条做法：不再问（F8）。
    expect(await f.say("不对，又只导了当前页 20 条")).toMatchObject({ status: "skipped", reason: "duplicate" });
    expect(f.asks()).toHaveLength(1);
  });

  it("remembering a rule that got saved meanwhile reports alreadySaved and writes nothing (F9)", async () => {
    const f = await fixture();
    await f.say(correction);
    const existing = await f.store.create({ text: rule, scope: { kind: "site", hostname: "crm.example" }, sourceConversationId: "conv-b", kind: "method", sourceQuote: "别的对话里记下的" });
    const rev = await f.store.currentRev();

    expect(await f.runtime.answerAsk(f.asks()[0]!.askId, "remember")).toEqual({ entry: existing, alreadySaved: true, rev });
    expect(await f.store.currentRev()).toBe(rev);
    expect(await f.store.list()).toEqual([existing]);
  });

  it("an ask whose replace target changed meanwhile is withdrawn with a clear error, not left failing (F10)", async () => {
    const store = await newStore();
    const old = await store.create({ text: "以后在这个网站导出，我只导当前页", scope: { kind: "site", hostname: "crm.example" }, sourceConversationId: "conv-0", kind: "method", sourceQuote: "只导当前页就行" });
    const f = await fixture({ store, verdict: verdict({ replaces: old.id }) });
    await f.say(correction);
    const askId = f.asks()[0]!.askId;
    await store.update({ id: old.id, expectedVersion: 1, text: "以后在这个网站导出，我只导前两页", scope: old.scope });

    await expect(f.runtime.answerAsk(askId, "remember")).rejects.toThrow("要替换的那条做法刚被改过，这条没有记下，请再说一次");
    // 作废的结局事件等面板先收到带原因的失败结果后再发（见下面面板消息那组）。
    expect(f.outcomes()).toEqual([]);
    await expect(f.runtime.answerAsk(askId, "remember")).rejects.toThrow("这条询问已失效，请再说一次");
    expect((await store.list()).map(e => [e.text, e.status])).toEqual([["以后在这个网站导出，我只导前两页", "active"]]);
  });

  it("an unknown ask id is refused and writes nothing (F9)", async () => {
    const f = await fixture();
    await expect(f.runtime.answerAsk("never-asked", "remember")).rejects.toThrow("这条询问已失效，请再说一次");
    expect(await f.store.list()).toEqual([]);
  });

  it("a replacing rule marks the old one replaced, and undo brings the old one back (F10)", async () => {
    const store = await newStore();
    const old = await store.create({ text: "以后在这个网站导出，我只导当前页", scope: { kind: "site", hostname: "crm.example" }, sourceConversationId: "conv-0", kind: "method", sourceQuote: "只导当前页就行" });
    const f = await fixture({ store, verdict: verdict({ replaces: old.id }) });
    await f.say(correction);

    expect(JSON.parse(f.askCalls()[0]![1]).methods).toEqual([{ id: old.id, text: old.text, scope: old.scope }]);
    const ask = f.asks()[0]!;
    expect(ask.replaces).toEqual({ id: old.id, text: old.text });

    const answer = await f.runtime.answerAsk(ask.askId, "remember");
    const [fresh, replaced] = answer.entries!;
    expect(fresh).toMatchObject({ text: rule, status: "active", factId: old.factId, kind: "method", sourceQuote: correction });
    expect(replaced).toMatchObject({ id: old.id, status: "replaced", replacedBy: fresh!.id, version: 2 });
    expect((await store.list()).filter(e => e.status === "active").map(e => e.id)).toEqual([fresh!.id]);

    // 面板靠「恢复的那条在前」认出撤销结果。
    expect((await store.restore({ id: old.id, expectedVersion: 2 })).map(e => e.id)).toEqual([old.id, fresh!.id]);
    const after = await store.list();
    expect(after.find(e => e.id === old.id)).toMatchObject({ status: "active" });
    expect(after.find(e => e.id === fresh!.id)).toMatchObject({ status: "invalid", replacedBy: old.id });
  });
});

describe("carrying a confirmed rule", () => {
  it("a non-web page is no site: a site rule keyed by an extension id is never carried there (F12)", async () => {
    const f = await fixture();
    await f.store.create({ text: rule, scope: { kind: "site", hostname: "mbjgiikhmkpgkjbaochpogefpaghokfd" }, sourceConversationId: "conv-0", kind: "method", sourceQuote: correction });
    expect(await f.carried("帮我看看这页", { tabId: 9, title: "语音权限", url: "chrome-extension://mbjgiikhmkpgkjbaochpogefpaghokfd/voice-permission.html" })).not.toContain(rule);
    expect(f.records.find(r => r.type === "memory_context")?.data.hostname).toBeNull();
  });

  it("is carried on its own site without word overlap, not on another site, and counts as used (F12)", async () => {
    const f = await fixture();
    await f.say(correction);
    await f.runtime.answerAsk(f.asks()[0]!.askId, "remember");

    expect(await f.carried("帮我看看这页", OTHER)).not.toContain(rule);
    expect((await f.store.list())[0]!.useCount).toBe(0);

    expect(await f.carried("帮我看看这页", CRM)).toContain(rule);
    expect((await f.store.list())[0]).toMatchObject({ useCount: 1, lastUsedAt: expect.any(Number) });
  });
});

describe("the panel's answer message", () => {
  it("answers through the conversation: remember returns the new entry and rev; a spent or unknown ask says it expired", async () => {
    const f = await fixture();
    await f.say(correction);
    const askId = f.asks()[0]!.askId;
    const emitted: ServerMessage[] = [];
    const runtime = { session: { answerMemoryAsk: (id: string, answer: "remember" | "once") => f.runtime.answerAsk(id, answer), modelName: () => "test/model", isHeld: () => false, isStreaming: () => false }, fleet: { teamView: () => null, list: () => [] }, dispose: vi.fn() };
    // SAFETY: 这条路由只用到 session.answerMemoryAsk 与会话列表需要的几个读取方法。
    const manager = new ConversationManager(async () => runtime as never, message => emitted.push(message), undefined, f.store);
    await manager.ensureDefault();

    await manager.handleMessage({ type: "memory_ask_answer", conversationId: "default", requestId: "ask-1", askId, answer: "remember" });
    const stored = await f.store.list();
    expect(emitted.at(-1)).toEqual({ type: "memory_result", conversationId: "default", requestId: "ask-1", action: "ask", ok: true, entry: stored[0], entries: stored, rev: 1 });

    await manager.handleMessage({ type: "memory_ask_answer", conversationId: "default", requestId: "ask-2", askId, answer: "once" });
    expect(emitted.at(-1)).toEqual({ type: "memory_result", conversationId: "default", requestId: "ask-2", action: "ask", ok: false, error: "这条询问已失效，请再说一次", askClosed: true, rev: 1 });

    // 同一条在另一个对话里早已记下：结果带 alreadySaved，不写入。
    await f.store.forget({ id: stored[0]!.id, expectedVersion: 1 });
    await f.say("不对，又只导了当前页 20 条");
    const again = f.asks().at(-1)!.askId;
    const existing = await f.store.create({ text: rule, scope: { kind: "site", hostname: "crm.example" }, sourceConversationId: "conv-b", kind: "method", sourceQuote: "别的对话里记下的" });
    await manager.handleMessage({ type: "memory_ask_answer", conversationId: "default", requestId: "ask-3", askId: again, answer: "remember" });
    expect(emitted.at(-1)).toEqual({ type: "memory_result", conversationId: "default", requestId: "ask-3", action: "ask", ok: true, entry: existing, alreadySaved: true, rev: 3 });
  });

  it("a withdrawn ask: the error result reaches the panel first, then the closed outcome for history (F10)", async () => {
    const store = await newStore();
    const old = await store.create({ text: "以后在这个网站导出，我只导当前页", scope: { kind: "site", hostname: "crm.example" }, sourceConversationId: "conv-0", kind: "method", sourceQuote: "只导当前页就行" });
    const f = await fixture({ store, verdict: verdict({ replaces: old.id }) });
    await f.say(correction);
    const askId = f.asks()[0]!.askId;
    await store.update({ id: old.id, expectedVersion: 1, text: "以后在这个网站导出，我只导前两页", scope: old.scope });
    const emitted: ServerMessage[] = [];
    const runtime = { session: { answerMemoryAsk: (id: string, answer: "remember" | "once") => f.runtime.answerAsk(id, answer), modelName: () => "test/model", isHeld: () => false, isStreaming: () => false }, fleet: { teamView: () => null, list: () => [] }, dispose: vi.fn() };

    const sink = (message: ServerMessage) => {
      emitted.push(message);

      if (message.type === "memory_result") f.trace.push("result");
    };

    // SAFETY: 这条路由只用到 session.answerMemoryAsk 与会话列表需要的几个读取方法。
    const manager = new ConversationManager(async () => runtime as never, sink, undefined, f.store);
    await manager.ensureDefault();

    await manager.handleMessage({ type: "memory_ask_answer", conversationId: "default", requestId: "ask-1", askId, answer: "remember" });
    expect(emitted.at(-1)).toEqual({ type: "memory_result", conversationId: "default", requestId: "ask-1", action: "ask", ok: false, askClosed: true, error: "要替换的那条做法刚被改过，这条没有记下，请再说一次", rev: 2 });
    expect(f.trace).toEqual(["ask:open", "result", "ask:closed"]);
    expect(f.outcomes()).toEqual([{ ...f.asks()[0], outcome: "closed" }]);
  });

  it("a saved rule is reported as saved even if reading the version afterwards fails", async () => {
    const f = await fixture();
    await f.say(correction);
    const emitted: ServerMessage[] = [];
    const runtime = { session: { answerMemoryAsk: (id: string, answer: "remember" | "once") => f.runtime.answerAsk(id, answer), modelName: () => "test/model", isHeld: () => false, isStreaming: () => false }, fleet: { teamView: () => null, list: () => [] }, dispose: vi.fn() };
    // SAFETY: 这条路由只用到 session.answerMemoryAsk 与会话列表需要的几个读取方法。
    const manager = new ConversationManager(async () => runtime as never, message => emitted.push(message), undefined, f.store);
    await manager.ensureDefault();
    vi.spyOn(f.store, "currentRev").mockRejectedValue(new Error("storage busy"));

    await manager.handleMessage({ type: "memory_ask_answer", conversationId: "default", requestId: "ask-1", askId: f.asks()[0]!.askId, answer: "remember" });
    const stored = await f.store.list();
    expect(emitted.at(-1)).toEqual({ type: "memory_result", conversationId: "default", requestId: "ask-1", action: "ask", ok: true, entry: stored[0], entries: stored });
  });

  it("a transient write failure keeps the ask answerable and is not marked closed", async () => {
    const f = await fixture();
    await f.say(correction);
    const askId = f.asks()[0]!.askId;
    const emitted: ServerMessage[] = [];
    const runtime = { session: { answerMemoryAsk: (id: string, answer: "remember" | "once") => f.runtime.answerAsk(id, answer), modelName: () => "test/model", isHeld: () => false, isStreaming: () => false }, fleet: { teamView: () => null, list: () => [] }, dispose: vi.fn() };
    // SAFETY: 这条路由只用到 session.answerMemoryAsk 与会话列表需要的几个读取方法。
    const manager = new ConversationManager(async () => runtime as never, message => emitted.push(message), undefined, f.store);
    await manager.ensureDefault();
    vi.spyOn(f.store, "saveMethod").mockRejectedValueOnce(new Error("disk full"));

    await manager.handleMessage({ type: "memory_ask_answer", conversationId: "default", requestId: "ask-1", askId, answer: "remember" });
    expect(emitted.at(-1)).toEqual({ type: "memory_result", conversationId: "default", requestId: "ask-1", action: "ask", ok: false, error: "disk full", rev: 0 });
    expect(f.outcomes()).toEqual([]);

    await manager.handleMessage({ type: "memory_ask_answer", conversationId: "default", requestId: "ask-2", askId, answer: "remember" });
    expect(emitted.at(-1)).toMatchObject({ requestId: "ask-2", ok: true });
  });
});

describe("task history hides secret values, not ordinary tasks", () => {
  async function recorded(entry: Partial<TaskHistoryEntry>) {
    const root = await mkdtemp(join(tmpdir(), "sideagent-task-secret-")); roots.push(root);
    const history = new TaskHistoryStore(new FileDocument(root, TASK_HISTORY_FILE));
    const full: TaskHistoryEntry = { id: "run-1", conversationId: "c1", goal: "x", revisions: [], hosts: ["crm.example"], outcome: "partial", summary: "好的", unfinished: [], startedAt: 1, endedAt: 2, ...entry };
    await history.record(full);

    return { full, saved: (await history.list())[0]! };
  }

  it.each([
    [{ goal: "查一下淘宝订单 3012345678901234567 的物流" }],
    [{ goal: "帮我找到 GitHub 忘记密码的入口" }],
    [{ goal: "登录 12306，订 10 月 3 日北京到成都的票", summary: "需要你提供短信验证码才能继续" }],
    [{ goal: "我信用卡账单怎么还没出，帮我查一下招行" }],
  ])("keeps an ordinary task word for word: %o", async patch => {
    const { full, saved } = await recorded(patch);
    expect(saved).toEqual(full);
  });

  it("removes the secret value of a password correction from everything stored", async () => {
    const secret = "不对，密码应该是 Abc12345";
    const { saved } = await recorded({ goal: secret, revisions: ["把客户名单导出来", secret], summary: "好的，已改用 Abc12345 登录。", unfinished: ["用 Abc12345 再登录一次"], page: "Abc12345 - 登录" });
    expect(JSON.stringify(saved)).not.toContain("Abc12345");
    expect(saved).toMatchObject({ goal: "不对，密码应该是 （已隐去）", revisions: ["把客户名单导出来", "不对，密码应该是 （已隐去）"], summary: "好的，已改用 （已隐去） 登录。" });
  });

  it("removes a card number tied to a card keyword, but not an order number", async () => {
    const { saved } = await recorded({ goal: "用银行卡 6222020200112233445 付订单 3012345678901234567" });
    expect(saved.goal).toBe("用银行卡 （已隐去） 付订单 3012345678901234567");
  });
});
