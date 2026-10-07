/**
 * 记忆底座加固验收（docs/evals/20261001-memory-hardening.md 的 H1–H9；H7–H9 的假通过路径写在各自函数上方）。验收者按合同独立编写，不读实现算答案。
 * 只装扩展的隔离无头 Chrome、真侧栏、脚本模型（前面挡一层记录代理，能看到并改写「要不要记」的判断请求）。
 * 证据只取用户看得到或导出/落盘的东西：侧栏回答、「记忆」面板、设置页导出的诊断记录、扩展自己的 IndexedDB 原文。
 *
 *   npx tsx scripts/acceptance/real-path/memory-hardening.mts --headless --scripted
 *   可加 --only=H2,H4 只跑部分场景（H5 依附 H3，选 H5 时 H3 也会跑）。
 * 产物：out/acceptance/real-path/<时间>-memory-hardening-scripted-<pid>/ 下 summary.json 与截图。任一场景 status=no 则退出码非 0。
 * 不跑真实模型：H3 需要代理把第一次判断请求改成服务错误，只有脚本模型路径能做到。
 *
 * ── 各场景「假通过」的路径，以及脚本怎么堵 ─────────────────────────────────────────
 * H1 读坏不覆盖：
 *   假：这一轮根本没走到「写过往任务」（纯聊天不记），所以原文自然没变；或任务没完成所以没写。
 *   堵：先在空库上跑同一句话做对照，必须真留下一条过往任务、页面上的备注框真被改了；再预置未来格式 / 损坏原文各跑一次，
 *       要求页面同样被改、回答出现、库里原文逐字节相同（不是「解析后等价」）。
 * H2 生效值 ≤1：
 *   假：库空了或读不出来，「≤1」空洞成立；或只看库不看面板；或「忘掉」只删了生效那条，旧值还在历史里。
 *   堵：每一步不仅数生效条数，还核对此刻唯一生效的是不是合同语义下应当生效的那个值（a/b/c/a/a/c）；
 *       同时按 factId（若有）分组、并把所有邮箱条目当作同一件事（场景构造保证）各数一次；面板非历史区的邮箱行也 ≤1；
 *       面板操作后不得出现冲突/失败文字；「忘掉」后库、面板、下一轮发给模型的上下文都不能再有任何 example.com。
 * H3 失败后补判、不重复：
 *   假：第一次请求其实没失败（代理没拦到）；或补判从没发生、条目来自别处；或补判只是没再触发，所以「不重复」空洞成立。
 *   堵：代理只对含「靠过道」的第一次判断请求回 500，并记下拦截次数（必须为 1）；条目存在即证明有第二次成功请求；
 *       之后每次再判这句话，代理都回「save」（像模型没认出已记过），并统计后续判断请求次数；再来一轮后库里仍恰好 1 条。
 *       「补判发生在本轮结束后」只作证据（成功请求时刻 vs 本轮最后一次对话请求时刻），不作判定（见下方说明）。
 * H4 面板自动更新、修改不冲突：
 *   假：面板打开时条目已在（不是自动更新出来的）；或靠重开面板才出现；或修改「成功」但库里没变。
 *   堵：判断回复延迟 8 秒，先发消息再立刻开面板，记录开面板时该行不存在；之后不重开、只轮询 DOM 等它出现；
 *       点「修改」改成 c2@，保存后面板无错误/冲突文字、编辑框关闭，库里 c2@ 生效、c@ 不再生效。
 * H5 诊断不留原话：
 *   假：导出里根本没有记忆判断记录，所以「没有原话」空洞成立。
 *   堵：导出里必须至少有一条记忆判断记录且带种类；所有这类记录都不得含「靠过道」。（仅限记忆判断记录；对话记录本身可含原话。）
 * H6 格式 2 升级到 3：
 *   假：面板读得出但库没升级；或升级了但丢条/断链；或读得出但不可用（不带给模型、不能撤销）。
 *   堵：面板逐条核对所有预置文字；下一轮上下文带 b@ 不带 a@、带有效行程；真点撤销替换后 a@ 生效、b@ 不生效；
 *       之后库为格式 3、条数不变、a→b 的替换关系还在（撤销前读一次）；若有 factId，a/b 共用且与别的事不同。
 *
 * 实现相关的名字全在下面的 TARGETS 里；判定逻辑不写死任何一个。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, exportDiagnosticsViaSettings, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json, type JsonRecord } from "./harness.mts";
import { configureViaSettings } from "./inproc-config.mts";
import { startScriptedModel, type Rule } from "./scripted-model.mts";

requireHeadless();

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

if (!process.argv.includes("--scripted")) {
  console.error("只支持 --scripted：H3 要在代理里把第一次判断请求改成服务错误，真实模型路径做不到。");
  process.exit(2);
}

const only = arg("only") ? new Set(arg("only")!.split(",")) : null;

// ══ TARGETS：一切依赖实现的名字 ═══════════════════════════════════════════════════
// TODO(fill from implementer report)：下面带「?」注释的是验收者按合同与 a5552ec/HEAD 现状猜的，实现者报告后核对。

type Doc = "memories" | "tasks";

/** 判断请求里验收要读的两项：用户原话、请求带来的现有条目。 */
type DecisionInput = { userMessage: string; entries: JsonRecord[] };

// SAFETY: 这一块只描述库/面板/诊断长什么样；读不到时得到 undefined/默认值，判定会失败而不是误通过。
const TARGETS = {
  db: { name: "sideagent-memory", store: "kv", version: 1, keys: { memories: "memories", tasks: "tasks" } as Record<Doc, string> },
  // 格式 2 的样本按 a5552ec 的 shared/memory.ts 与 agent/src/memory-store.ts 构造；升级后应为 3。
  legacyFormat: 2,
  newFormat: 3, // ? 文档顶层 format
  taskFormat: 1, // 过往任务文档在 a5552ec 是 format 1
  arrayField: { memories: "entries", tasks: "tasks" } as Record<Doc, string>,
  statuses: { active: "active", replaced: "replaced", inactive: "invalid" },
  kinds: { aboutYou: "profile", did: "past", method: "method" },
  read: {
    text: (e: JsonRecord) => String(e.text ?? ""),
    status: (e: JsonRecord) => (e.status as string | undefined) ?? "active",
    replacedBy: (e: JsonRecord) => e.replacedBy as string | undefined, // ? 格式 3 若改名，替换关系从这里读
    factId: (e: JsonRecord) => e.factId as string | undefined, // ? 「同一件事一个编号」的字段名
    format: (doc: JsonRecord) => doc.format as number | undefined,
  },
  // 「要不要记」请求：系统提示里的标记，用户输入是 JSON（userMessage + entries）。
  decision: {
    systemMarker: "You interpret the CURRENT direct user message",
    parse: (userContent: string): DecisionInput => {
      try {
        // SAFETY: 判断请求的用户输入是产品序列化的 JSON；取不到就当空，判定会失败而不是误通过。
        const o = JSON.parse(userContent) as { userMessage?: string; entries?: JsonRecord[] };

        return { userMessage: String(o.userMessage ?? ""), entries: Array.isArray(o.entries) ? o.entries : [] };
      } catch { return { userMessage: "", entries: [] }; }
    },
  },
  diag: {
    decisionType: "memory_decision",
    // ? 「判断失败」那条记录的辨认方式。
    failed: /fail|error|失败|retry|补判|pending/i,
  },
  panel: {
    rowSelector: ".memory-row",
    activeRowSelector: ".memory-row:not(.memory-history-row):not(.past-task)",
    historyToggle: "details.memory-history:not([open]) > summary",
    rowTextSelector: ".memory-row-text",
    replacedText: "已被替换",
    undoText: "撤销替换",
    restoreInvalidText: "恢复这条", // 失效那条的恢复按钮文字
    deleteText: "删除", // 历史行的删除按钮
    forgetConfirmSelector: ".memory-forget-submit",
    editText: "修改",
    editTextarea: "textarea[data-memory-field=\"text\"]",
    saveSelector: "button[data-memory-action=\"save\"]",
    errorSelector: ".memory-error:not([hidden])",
    trouble: /冲突|conflict|not found|没有撤销|未保存|失败/i,
  },
};

// ══ 日期与站点 ═════════════════════════════════════════════════════════════════════

const DAY = 86_400_000;

function dayStart(offset: number) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);

  return d;
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const HOTEL = "hotel.test";

const NOTE = "note.test";

const page = (title: string, body: string) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head><body style="font:16px/1.7 -apple-system,sans-serif;margin:32px;max-width:720px">${body}</body></html>`;

async function body(req: IncomingMessage) {
  let s = "";

  for await (const c of req) s += c;

  return s;
}

function site(req: IncomingMessage, res: ServerResponse) {
  const host = String(req.headers.host ?? "").split(":")[0]!;
  const html = (s: string) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(s);

  if (host === NOTE) return html(page("备注页", `<h1>备注页</h1><label>备注 <textarea id="note"></textarea></label>`));

  html(page("酒店预订", `<h1>${host}</h1><p>这里是 ${host} 的一个普通页面。</p>`));
}

// ══ 记录代理：对话请求转给脚本模型；判断请求由代理按场景直接回答 ═════════════════════════

type ChatMessage = { role: string; content?: string | Array<{ text?: string }> | null };

type Recorded = { n: number; at: number; decision: boolean; userMessage: string; context: string; messages: ChatMessage[]; status: number };

const textOf = (c: ChatMessage["content"]) => Array.isArray(c) ? c.map((p) => p.text ?? "").join("") : c ?? "";

const H1_VALUE = "H1 备注已写";

const RULES: Rule[] = [
  { match: "慢慢写备注H8", steps: [{ tool: { name: "fill", args: { target: "#note", value: "H8" } } }, { text: "H8 写完了。", delayMs: 45_000 }] },
  { match: "慢慢写备注H9", steps: [{ tool: { name: "fill", args: { target: "#note", value: "H9" } } }, { text: "H9 写完了。", delayMs: 12_000 }] },
  { match: "顺便看下价格", steps: [{ text: "价格是 100 元。H9-PRICE" }] },
  { match: "不对，是", steps: [{ text: "好的，按新邮箱。" }] },
  { match: "在这页写备注", steps: [{ tool: { name: "fill", args: { target: "#note", value: H1_VALUE } } }, { text: "已写好备注。H1-DONE" }] },
  { match: "我的邮箱是", steps: [{ text: "好的，记下了。" }] },
  { match: "我邮箱换成", steps: [{ text: "好的，已换成新邮箱。" }] },
  { match: "忘掉我的邮箱", steps: [{ text: "好的，已忘掉。" }] },
  { match: "靠过道", steps: [{ text: "好的，以后选靠过道。" }] },
  { match: "帮我填邮箱", steps: [{ text: "好的。" }] },
  { match: "帮我看看这页", steps: [{ text: "好的。" }] },
];

const about = (longTerm: boolean) => ({ longTerm, date: null, onlyThisTask: false, explicitRequest: false, dateIsTheTask: false });

const NONE = { action: "none", text: "", evidence: "", scope: { kind: "all" }, targets: [], taskRequested: false, about: about(false) };

const isActive = (e: JsonRecord) => TARGETS.read.status(e) === TARGETS.statuses.active;

/** 「要不要记」的脚本回答：按原话与请求里带来的现有条目现算（目标 id/版本要用真的）。 */
function decide(userMessage: string, entries: JsonRecord[]): JsonRecord {
  const emailTargets = () => {
    const mail = entries.filter((e) => TARGETS.read.text(e).includes("邮箱"));
    const live = mail.filter((e) => "status" in e ? isActive(e) : true);

    return ("status" in (mail[0] ?? {}) ? live : live.slice(-1)).map((e) => ({ id: e.id, version: e.version }));
  };

  const saved = userMessage.match(/我的邮箱是\s*(\S+@example\.com)/);

  if (saved) return { action: "save", text: `邮箱：${saved[1]}`, evidence: saved[1], scope: { kind: "all" }, targets: [], taskRequested: false, about: about(true) };
  const changed = userMessage.match(/我邮箱换成\s*(\S+@example\.com)/);

  if (changed) return { action: "update", text: `邮箱：${changed[1]}`, evidence: changed[1], scope: { kind: "all" }, targets: emailTargets(), taskRequested: false, about: about(true) };

  const corrected = userMessage.match(/不对，是\s*(\S+@example\.com)/);

  if (corrected) {
    const targets = emailTargets();

    return { action: targets.length ? "update" : "save", text: `邮箱：${corrected[1]}`, evidence: corrected[1], scope: { kind: "all" }, targets, taskRequested: false, about: about(true) };
  }

  if (userMessage.includes("忘掉我的邮箱")) return { action: "forget", text: "", evidence: "忘掉我的邮箱", scope: { kind: "all" }, targets: emailTargets(), taskRequested: false, about: about(false) };

  if (userMessage.includes("我坐飞机都要靠过道")) return { action: "save", text: "坐飞机要靠过道", evidence: "我坐飞机都要靠过道", scope: { kind: "all" }, targets: [], taskRequested: false, about: about(true) };

  return NONE;
}

const sse = (delta: JsonRecord, finish: string | null = null) => `data: ${JSON.stringify({ id: "chatcmpl-proxy", object: "chat.completion.chunk", created: 0, model: "demo-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

function answer(res: ServerResponse, stream: boolean, text: string) {
  if (stream) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(sse({ role: "assistant", content: text }));
    res.write(sse({}, "stop"));
    res.end("data: [DONE]\n\n");

    return;
  }

  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
    id: "chatcmpl-proxy", object: "chat.completion", created: 0, model: "demo-model",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  }));
}

/** 原话含 when 的判断请求：前 times 次回 500；从第 holdFrom 次起每次先挂起 holdMs 再回（H8 让补判「正在进行」）。 */
interface FailRule { when: string; times: number; holdMs: number; holdFrom: number; seen: number; failed: number; served: number; inFlight: number }

/** 场景可调的代理行为。 */
interface ProxyControl {
  rules: FailRule[];
  /** 原话含这段的判断请求延迟多少毫秒才回（H4）。 */
  delay: { when: string; ms: number } | null;
}

const proxyControl: ProxyControl = { rules: [], delay: null };

function failRule(when: string, times: number, hold: { ms: number; from: number } = { ms: 0, from: 1 }): FailRule {
  const rule: FailRule = { when, times, holdMs: hold.ms, holdFrom: hold.from, seen: 0, failed: 0, served: 0, inFlight: 0 };
  proxyControl.rules.push(rule);

  return rule;
}

async function startRecordingModel() {
  const upstream = await startScriptedModel(RULES);
  const origin = new URL(upstream.baseUrl).origin;
  const log: Recorded[] = [];

  const server = createServer(async (req, res) => {
    const payloadText = await body(req);

    if (req.method === "POST" && (req.url ?? "").endsWith("/chat/completions")) {
      // SAFETY: OpenAI 兼容请求体。
      const payload = JSON.parse(payloadText) as { messages?: ChatMessage[]; stream?: boolean };
      const messages = payload.messages ?? [];
      const system = messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content)).join("\n");
      const lastUserIndex = messages.map((m) => m.role).lastIndexOf("user");
      const lastUser = lastUserIndex >= 0 ? textOf(messages[lastUserIndex]!.content) : "";
      const decision = system.includes(TARGETS.decision.systemMarker);
      const parsed = decision ? TARGETS.decision.parse(lastUser) : { userMessage: lastUser, entries: [] };
      const context = messages.filter((_, i) => i !== lastUserIndex).map((m) => textOf(m.content)).join("\n");
      const record: Recorded = { n: log.length, at: Date.now(), decision, userMessage: parsed.userMessage, context, messages, status: 200 };
      log.push(record);

      if (decision) {
        const rule = proxyControl.rules.find((x) => parsed.userMessage.includes(x.when));

        if (rule) {
          rule.seen += 1;

          if (rule.holdMs && rule.seen >= rule.holdFrom) {
            rule.inFlight += 1;
            await sleep(rule.holdMs);
            rule.inFlight -= 1;
          }

          if (rule.failed < rule.times) {
            rule.failed += 1;
            record.status = 500;
            res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "scripted upstream failure" } }));

            return;
          }

          rule.served += 1;
        }

        if (proxyControl.delay && parsed.userMessage.includes(proxyControl.delay.when)) await sleep(proxyControl.delay.ms);
        answer(res, payload.stream === true, JSON.stringify(decide(parsed.userMessage, parsed.entries)));

        return;
      }

      // 「不对，……」还会问一次「是不是可复用的做法」（10-01 之后加的判断，见 agent/src/memory-correction.ts）。
      // 这里的纠正都是个人资料（邮箱），按提示词规定答不可复用；不答的话产品解析失败，整句排进补判。
      if (system.includes("You review a direct user correction")) {
        // SAFETY: 产品发来的纠正判断输入是 JSON，带 userMessage。
        const asked = (JSON.parse(lastUser) as { userMessage?: string }).userMessage ?? "";
        const evidence = asked.match(/^不对/)?.[0] ?? "";
        answer(res, payload.stream === true, JSON.stringify({ correction: !!evidence, reusable: false, about: "assistant", rule: "", evidence, replaces: null, personalEvidence: "" }));

        return;
      }
    }

    // 用户点停止时扩展会中断请求，上游连接随之关闭；这不是失败，代理只需收尾，不能让整个脚本崩掉。
    try {
      const reply = await fetch(origin + (req.url ?? "/"), { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "GET" ? undefined : payloadText });

      if (!res.headersSent) res.writeHead(reply.status, { "content-type": reply.headers.get("content-type") ?? "application/json" });

      for await (const chunk of reply.body ?? []) res.write(chunk);
    } catch { /* 连接已被中断 */ }

    res.end();
  });

  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));

  return { baseUrl: `http://127.0.0.1:${siteAddress(server).port}/v1`, log, close: async () => { server.closeAllConnections(); server.close(); await upstream.close(); } };
}

// ══ 判据与记录 ════════════════════════════════════════════════════════════════════

type Verdict = { status: "yes" | "no" | "n-a"; evidence: JsonRecord };

const verdicts: Record<string, Verdict> = {};

const verdict = (pass: boolean, evidence: JsonRecord): Verdict => ({ status: pass ? "yes" : "no", evidence });

const startedAt = new Date();

const artifacts = join(REPO, "out/acceptance/real-path", `${startedAt.toISOString().replace(/[:.]/g, "-")}-memory-hardening-scripted-${process.pid}`);

await mkdir(artifacts, { recursive: true });

const wants = (id: string) => !only || only.has(id) || (id === "H3" && only.has("H5")) || (id === "H7b" && only.has("H7"));

const siteServer = createServer((req, res) => void site(req, res));

await new Promise<void>((done) => siteServer.listen(0, "127.0.0.1", done));

const sitePort = siteAddress(siteServer).port;

const model = await startRecordingModel();

const rp = await launchRealPath({ chromeArgs: [`--host-resolver-rules=${[HOTEL, NOTE].map((h) => `MAP ${h} 127.0.0.1:${sitePort}`).join(", ")}`, "--no-proxy-server"] });

const PANEL = `(() => {
  const q = (s) => document.querySelector(s);
  return {
    connected: q("#status-dot")?.classList.contains("on") ?? false,
    ready: q("#send-btn")?.disabled === false,
    busy: !!(q("#status-pill")?.classList.contains("running") || q("#send-btn")?.classList.contains("stopping") || q(".msg.assistant.streaming, .msg.assistant[data-revealing]")),
    userMessages: document.querySelectorAll("#messages .msg.user").length,
    replies: document.querySelectorAll("#messages .msg:not(.user)").length,
    transcript: q("#messages")?.innerText ?? "",
  };
})()`;

type PanelState = { connected: boolean; ready: boolean; busy: boolean; userMessages: number; replies: number; transcript: string };

let panel = "";

let work = "";

let workTargetId = "";

let ext = "";

const read = async (): Promise<PanelState> => {
  const state: Json = await rp.evaluate(panel, PANEL);

  // SAFETY: PANEL 返回的字段与 PanelState 一一对应。
  return state as PanelState;
};

// ── 扩展自己的 IndexedDB（种数据与读回原文）──

const idbOpen = `async () => {
  const name = ${JSON.stringify(TARGETS.db.name)}, store = ${JSON.stringify(TARGETS.db.store)};
  const exists = (await indexedDB.databases()).some((d) => d.name === name);
  return await new Promise((res, rej) => {
    const r = exists ? indexedDB.open(name) : indexedDB.open(name, ${TARGETS.db.version});
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(store)) r.result.createObjectStore(store); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}`;

async function putDoc(doc: Doc, value: string | null) {
  await rp.evaluate(ext, `(async () => { const db = await (${idbOpen})(); const tx = db.transaction(${JSON.stringify(TARGETS.db.store)}, "readwrite"); const s = tx.objectStore(${JSON.stringify(TARGETS.db.store)});
    ${value === null ? `s.delete(${JSON.stringify(TARGETS.db.keys[doc])})` : `s.put(${JSON.stringify(value)}, ${JSON.stringify(TARGETS.db.keys[doc])})`};
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); db.close(); return true; })()`);
}

async function rawDoc(doc: Doc): Promise<string | null> {
  const v = await rp.evaluate(ext, `(async () => { const db = await (${idbOpen})(); const v = await new Promise((res, rej) => { const r = db.transaction(${JSON.stringify(TARGETS.db.store)}).objectStore(${JSON.stringify(TARGETS.db.store)}).get(${JSON.stringify(TARGETS.db.keys[doc])}); r.onsuccess = () => res(r.result ?? null); r.onerror = () => rej(r.error); }); db.close(); return v; })()`);

  return v === null || v === undefined ? null : String(v);
}

type Stored = { raw: JsonRecord | null; items: JsonRecord[]; unreadable: boolean };

async function readDoc(doc: Doc): Promise<Stored> {
  const text = await rawDoc(doc);

  if (!text) return { raw: null, items: [], unreadable: false };

  try {
    // SAFETY: 产品写入的 JSON 文本，顶层对象，数组字段由 TARGETS.arrayField 指定。
    const raw = JSON.parse(text) as JsonRecord;
    // SAFETY: 同上。
    const items = raw[TARGETS.arrayField[doc]] as JsonRecord[] | undefined;

    return { raw, items: Array.isArray(items) ? items : [], unreadable: false };
  } catch { return { raw: null, items: [], unreadable: true }; }
}

async function emptyStores() {
  await putDoc("memories", null);
  await putDoc("tasks", null);
}

// ── 侧栏操作 ──

async function waitReady() {
  await until(async () => {
    const s = await read();

    return s.connected && s.ready ? s : undefined;
  }, 90_000, "侧栏就绪", 500);
}

async function newConversation() {
  await rp.click(panel, "#conversation-new");
  await until(async () => (await rp.evaluate(panel, `document.querySelectorAll(".msg.user").length === 0 && !document.querySelector("#conversation-new").disabled`)) || undefined, 15_000, "新会话");
  await sleep(800);
}

async function navigate(host: string, path = "/") {
  await rp.cdp.send("Page.navigate", { url: `http://${host}${path}` }, work);
  await until(async () => (await rp.evaluate(work, `location.hostname === ${JSON.stringify(host)} && document.readyState === "complete"`).catch(() => false)) || undefined, 15_000, `打开 ${host}`);
  await rp.cdp.send("Target.activateTarget", { targetId: workTargetId });
  await sleep(800);
}

async function send(text: string) {
  const before = await read();
  await rp.click(panel, "#input");
  await rp.typeText(panel, text);
  await rp.pressEnter(panel);
  const sent = await until(async () => (await read()).userMessages > before.userMessages || undefined, 5_000, "消息发出").catch(() => false);

  if (!sent) await rp.click(panel, "#send-btn");
  await until(async () => (await read()).userMessages > before.userMessages || undefined, 10_000, `发出：${text}`);

  return before;
}

async function waitTurnEnd(before: PanelState, limitMs = 240_000) {
  const started = Date.now();
  let idle = 0;

  while (Date.now() - started < limitMs && idle < 12) {
    const s = await read().catch(() => null);
    idle = s && !s.busy && s.replies > before.replies && Date.now() - started > 3000 ? idle + 1 : 0;
    await sleep(250);
  }

  if (idle < 12) throw new Error(`${limitMs / 1000} 秒内这一轮没有结束`);
  await sleep(1500);
}

/** 发一句话，等这一轮结束，返回这一轮期间代理记下的请求与侧栏全文。 */
async function turn(text: string) {
  const mark = model.log.length;
  const sentAt = Date.now();
  const before = await send(text);
  await waitTurnEnd(before);
  const requests = model.log.slice(mark);

  return { requests, chat: requests.filter((r) => !r.decision), transcript: (await read()).transcript, sentAt, endedAt: Date.now() };
}

// ── 记忆面板 ──

type Row = { id: string | null; text: string };

const rowsJs = (selector: string) => `[...document.querySelectorAll(${JSON.stringify(selector)})].map((r) => ({ id: r.dataset.memoryId ?? null, text: r.textContent.replace(/\\s+/g, " ").trim() }))`;

async function panelRows(selector = TARGETS.panel.rowSelector): Promise<Row[]> {
  const rows: Json = await rp.evaluate(panel, rowsJs(selector));

  // SAFETY: 页面脚本返回 [{ id, text }]。
  return rows as Row[];
}

async function openMemoryPanel(): Promise<Row[]> {
  for (let i = 0; i < 3 && !(await rp.evaluate(panel, `document.querySelector("#header-menu").matches(":popover-open")`)); i += 1) {
    await rp.click(panel, "#header-more");
    await sleep(400);
  }

  await rp.click(panel, "#memory-open");
  await sleep(500);
  await rp.evaluate(panel, `document.querySelector("#seg-memory")?.click(); true`);
  await until(async () => (await rp.evaluate(panel, `(() => { const t = document.querySelector("#memory-body")?.innerText ?? ""; return t.length > 0 && !t.includes("正在读取") ? t : ""; })()`)) || undefined, 15_000, "记忆面板读完");
  await sleep(800);
  await expandHistory();

  return panelRows();
}

/** 把带 data-acceptance-click 标记的元素滚进窗口。scrollIntoView 在面板里不一定够（实测 H6：按钮在 947/765），不够就像用户一样在面板上滚轮。 */
async function scrollMarkedIntoView() {
  await rp.evaluate(panel, `document.querySelector("[data-acceptance-click]")?.scrollIntoView({ block: "center" }); true`);
  await sleep(200);

  for (let i = 0; i < 15; i += 1) {
    const box = await rp.evaluate(panel, `(() => { const r = document.querySelector("[data-acceptance-click]").getBoundingClientRect(); return { y: r.y, h: r.height, x: r.x, vh: innerHeight, vw: innerWidth }; })()`);
    // SAFETY: 上一行页面脚本返回这五个数字。
    const b = box as { y: number; h: number; x: number; vh: number; vw: number };

    if (b.y >= 0 && b.y + b.h <= b.vh) break;

    await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: Math.round(b.vw / 2), y: Math.round(b.vh * 0.7), deltaX: 0, deltaY: Math.round(Math.max(-400, Math.min(400, b.y - b.vh / 2))) }, panel);
    await sleep(250);
  }
}

async function expandHistory() {
  if (await rp.evaluate(panel, `(() => { const t = document.querySelector(${JSON.stringify(TARGETS.panel.historyToggle)}); if (!t) return false; t.setAttribute("data-acceptance-click", "1"); return true; })()`)) {
    await scrollMarkedIntoView();
    await rp.click(panel, "[data-acceptance-click]");
    await rp.evaluate(panel, `document.querySelector("[data-acceptance-click]")?.removeAttribute("data-acceptance-click"); true`);
    await sleep(300);
  }
}

const closeMemoryPanel = () => rp.click(panel, "#memory-close").catch(() => undefined);

const panelTrouble = async () => String(await rp.evaluate(panel, `(() => { const b = document.querySelector("#memory-body"); if (!b) return ""; const errs = [...b.querySelectorAll(${JSON.stringify(TARGETS.panel.errorSelector)})].map((e) => e.textContent.trim()).filter(Boolean).join(" | "); const m = b.innerText.match(${TARGETS.panel.trouble.toString()}); return errs || (m ? m[0] : ""); })()`));

async function shot(name: string) {
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 0, height: 0, deviceScaleFactor: 2, mobile: false }, panel);
  await sleep(300);
  await rp.screenshot(panel, join(artifacts, `${name}.png`));
}

let lastHitTest = "";

/** 真点面板某一行（文字精确等于 rowText 优先，否则包含）里文字含 label 的按钮。alsoIn 用来挑历史区那一行。 */
async function clickRowButton(rowText: string, label: string, alsoIn = "") {
  // 面板重绘时「历史」可能又收起（H6 实测），折叠里的按钮点不到；先像用户一样再点开。
  await expandHistory();

  const found = await rp.evaluate(panel, `(() => { const rows = [...document.querySelectorAll(${JSON.stringify(TARGETS.panel.rowSelector)})].filter((r) => r.textContent.includes(${JSON.stringify(alsoIn)}));
    const exact = rows.find((r) => r.querySelector(${JSON.stringify(TARGETS.panel.rowTextSelector)})?.textContent.trim() === ${JSON.stringify(rowText)});
    const target = exact ?? rows.find((r) => r.textContent.includes(${JSON.stringify(rowText)}));
    const b = target && [...target.querySelectorAll("button")].find((x) => x.textContent.includes(${JSON.stringify(label)}));
    if (!b) return false; b.setAttribute("data-acceptance-click", "1"); b.scrollIntoView({ block: "center" }); return true; })()`);

  if (!found) return false;
  await sleep(300);

  await scrollMarkedIntoView();

  // 点之前确认按钮中心处最上层就是它，避免点到遮挡物还当成「点了」。
  lastHitTest = String(await rp.evaluate(panel, `(() => { const b = document.querySelector("[data-acceptance-click]"); const r = b.getBoundingClientRect(); const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return top === b || b.contains(top) ? "ok" : \`blocked by \${top?.tagName}.\${top?.className}「\${(top?.textContent ?? "").trim().slice(0, 40)}」 at \${Math.round(r.y)} of \${innerHeight}; details open=\${b.closest("details")?.open} class=\${b.closest("details")?.className} connected=\${b.isConnected}\`; })()`));
  await rp.click(panel, "[data-acceptance-click]");
  await rp.evaluate(panel, `document.querySelector("[data-acceptance-click]")?.removeAttribute("data-acceptance-click"); true`);

  return true;
}

// ── 诊断导出 ──

let exportN = 0;

async function diagnostics(): Promise<string> {
  const out = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(rp.dirs.downloads, `export-${++exportN}`), { clearAfter: true });

  return out.traces;
}

const decisionLines = (traces: string) => traces.split("\n").filter((l) => l.includes(TARGETS.diag.decisionType));

// ── 「同一件事生效值 ≤1」检查 ──

const MAIL = "@example.com";

/** 读库，按 factId（若有）与「所有邮箱条目是同一件事」两种分组各数生效条数；expectActive 为此刻应当唯一生效的值（null = 应无）。 */
async function factCheck(step: string, expectActive: string | null): Promise<JsonRecord> {
  const store = await readDoc("memories");
  const mail = store.items.filter((e) => TARGETS.read.text(e).includes(MAIL));
  const active = mail.filter(isActive);
  const byFact = new Map<string, number>();

  for (const e of store.items.filter(isActive)) {
    const f = TARGETS.read.factId(e);

    if (f) byFact.set(f, (byFact.get(f) ?? 0) + 1);
  }

  const factIds = [...new Set(mail.map((e) => TARGETS.read.factId(e) ?? "∅"))];
  const maxPerFact = Math.max(0, ...byFact.values());

  const ok = !store.unreadable && active.length <= 1 && maxPerFact <= 1
    && (expectActive === null ? active.length === 0 : active.length === 1 && TARGETS.read.text(active[0]!).includes(expectActive));

  return { step, ok, unreadable: store.unreadable, mailEntries: mail.map((e) => `${TARGETS.read.text(e)}=${TARGETS.read.status(e)}`), activeMail: active.length, maxActivePerFactId: maxPerFact, mailFactIds: factIds, expectActive };
}

async function panelActiveMailRows() {
  return (await panelRows(TARGETS.panel.activeRowSelector)).filter((r) => r.text.includes(MAIL)).length;
}

// ══ 场景 ═════════════════════════════════════════════════════════════════════════

const NOW = Date.now();

/** H1 读坏不覆盖。 */
async function h1(): Promise<Verdict> {
  const ask = "在这页写备注";

  const runTask = async (label: string) => {
    await navigate(NOTE);
    await newConversation();
    const t = await turn(ask);
    const note = String(await rp.evaluate(work, `document.querySelector("#note")?.value ?? ""`));
    await shot(`H1-${label}`);

    return { pageChanged: note === H1_VALUE, answered: t.transcript.includes("H1-DONE") };
  };

  // 对照：空库上同一句话必须真留下一条过往任务，否则下面「没覆盖」证明不了什么。
  await emptyStores();
  const control = await runTask("control");
  const controlTasks = (await readDoc("tasks")).items.filter((e) => JSON.stringify(e).includes(ask));

  const FUTURE = JSON.stringify({ format: 99, tasks: [{ id: "future-1", nextGeneration: { goal: "未来格式里的任务 FUTURE-A" } }], extra: "保留我" }) + "\n";
  const CORRUPT = `{"format":1,"tasks":[{"id":"run-c","goal":"损坏的任务 CORRUPT-A","hosts":["hotel.test"]},{"id":"run-d","goal":"写到一半`;
  const cases: Record<string, { pageChanged: boolean; answered: boolean; byteIdentical: boolean; afterLength: number | null; beforeLength: number; afterHead: string | null }> = {};

  for (const [label, raw] of [["future", FUTURE], ["corrupt", CORRUPT]] as const) {
    await emptyStores();
    await putDoc("tasks", raw);
    const run = await runTask(label);
    const after = await rawDoc("tasks");
    cases[label] = { ...run, byteIdentical: after === raw, afterLength: after?.length ?? null, beforeLength: raw.length, afterHead: after?.slice(0, 120) ?? null };
  }

  const evidence: JsonRecord = { control: { ...control, taskRecorded: controlTasks.length }, cases };
  const caseOk = (label: string) => cases[label]?.byteIdentical === true && cases[label]?.answered === true && cases[label]?.pageChanged === true;

  return verdict(control.pageChanged && control.answered && controlTasks.length >= 1 && caseOk("future") && caseOk("corrupt"), evidence);
}

/** H2 同一件事生效值 ≤1。 */
async function h2(): Promise<Verdict> {
  await emptyStores();
  await navigate(HOTEL);
  await newConversation();
  const steps: JsonRecord[] = [];
  const panelChecks: JsonRecord[] = [];

  await turn("我的邮箱是 a@example.com");
  steps.push(await factCheck("save a", "a@example.com"));
  await turn("我邮箱换成 b@example.com");
  steps.push(await factCheck("a→b", "b@example.com"));
  await turn("我邮箱换成 c@example.com");
  steps.push(await factCheck("b→c", "c@example.com"));

  // 撤销：把最早的 a 恢复成唯一生效值；这样历史里剩 b（链的中间那条）和 c。
  await openMemoryPanel();
  const undo1 = await clickRowButton("邮箱：a@example.com", TARGETS.panel.undoText, TARGETS.panel.replacedText);
  await sleep(1500);
  await expandHistory();
  panelChecks.push({ step: "undo a", clicked: undo1, trouble: await panelTrouble(), activeRows: await panelActiveMailRows() });
  steps.push(await factCheck("undo → a", "a@example.com"));
  await shot("H2-after-undo1");

  // 删历史中间那条 b（会先问一次，像用户一样确认）。
  const del = await clickRowButton("邮箱：b@example.com", TARGETS.panel.deleteText, TARGETS.panel.replacedText);
  await sleep(500);
  await rp.click(panel, TARGETS.panel.forgetConfirmSelector).catch(() => undefined);
  await sleep(1500);
  await expandHistory();
  panelChecks.push({ step: "delete b", clicked: del, trouble: await panelTrouble(), activeRows: await panelActiveMailRows(), bRowsLeft: (await panelRows()).filter((r) => r.text.includes("b@example.com")).length });
  const afterDelete = await factCheck("delete b", "a@example.com");
  afterDelete.bGone = !(await readDoc("memories")).items.some((e) => TARGETS.read.text(e).includes("b@example.com"));
  afterDelete.ok = afterDelete.ok === true && afterDelete.bGone === true;
  steps.push(afterDelete);

  // 再撤销：把 c 恢复成唯一生效值。
  const undo2 = await clickRowButton("邮箱：c@example.com", TARGETS.panel.restoreInvalidText);
  await sleep(1500);
  await expandHistory();
  panelChecks.push({ step: "undo c", clicked: undo2, trouble: await panelTrouble(), activeRows: await panelActiveMailRows() });
  steps.push(await factCheck("undo → c", "c@example.com"));
  await shot("H2-after-undo2");
  await closeMemoryPanel();

  // 聊天里忘掉：整件事全部消失。
  const forgetTurn = await turn("忘掉我的邮箱");
  const forgetJudged = forgetTurn.requests.some((r) => r.decision && r.userMessage.includes("忘掉我的邮箱"));
  steps.push(await factCheck("forget", null));
  const leftover = (await readDoc("memories")).items.filter((e) => JSON.stringify(e).includes(MAIL)).length;
  const rows = await openMemoryPanel();
  await shot("H2-after-forget");
  await closeMemoryPanel();
  await newConversation();
  const next = await turn("帮我填邮箱");
  const ctx = next.chat[0]?.context ?? "";

  const final = { forgetJudged, leftoverInStore: leftover, panelRowsWithMail: rows.filter((r) => r.text.includes(MAIL)).length, nextContextHasMail: ctx.includes(MAIL) };
  const evidence: JsonRecord = { steps, panelChecks, final };

  const pass = steps.every((s) => s.ok === true)
    && panelChecks.every((p) => p.clicked === true && p.trouble === "" && Number(p.activeRows) <= 1)
    && panelChecks[1]?.bRowsLeft === 0
    && forgetJudged && leftover === 0 && final.panelRowsWithMail === 0 && !final.nextContextHasMail;

  return verdict(pass, evidence);
}

/** H4 面板开着时自动出现新记的条目，随即修改不冲突。 */
async function h4(): Promise<Verdict> {
  await emptyStores();
  await navigate(HOTEL);
  await newConversation();
  proxyControl.delay = { when: "我的邮箱是 c@example.com", ms: 8000 };
  const before = await send("我的邮箱是 c@example.com");
  const openRows = await openMemoryPanel();
  const presentAtOpen = openRows.some((r) => r.text.includes("c@example.com"));
  // 不重开面板，只等 DOM 自己变。
  const appeared = await until(async () => (await panelRows()).some((r) => r.text.includes("c@example.com")) || undefined, 45_000, "面板自动出现 c@").catch(() => false);
  await shot("H4-auto-appeared");
  proxyControl.delay = null;

  let edit: JsonRecord = { skipped: "条目没出现" };

  if (appeared) {
    const clickedEdit = await clickRowButton("邮箱：c@example.com", TARGETS.panel.editText);
    await sleep(500);
    const hasBox = !!(await rp.evaluate(panel, `!!document.querySelector(${JSON.stringify(TARGETS.panel.editTextarea)})`));

    if (hasBox) {
      await rp.click(panel, TARGETS.panel.editTextarea);
      await rp.evaluate(panel, `document.querySelector(${JSON.stringify(TARGETS.panel.editTextarea)}).select(); true`);
      await rp.typeText(panel, "邮箱：c2@example.com");
    }

    const saved = hasBox && !!(await rp.evaluate(panel, `!!document.querySelector(${JSON.stringify(TARGETS.panel.saveSelector)})`));

    if (saved) await rp.click(panel, TARGETS.panel.saveSelector);
    await sleep(2000);
    const trouble = await panelTrouble();
    const boxStillOpen = !!(await rp.evaluate(panel, `!!document.querySelector(${JSON.stringify(TARGETS.panel.editTextarea)})`));
    await shot("H4-after-edit");
    const rows = await panelRows(TARGETS.panel.activeRowSelector);
    edit = { clickedEdit, hasBox, saved, trouble, boxStillOpen, panelShowsC2: rows.some((r) => r.text.includes("c2@example.com")) };
  }

  await closeMemoryPanel();
  await waitTurnEnd(before).catch(() => undefined);
  const store = (await readDoc("memories")).items;
  const c2 = store.find((e) => TARGETS.read.text(e).includes("c2@example.com"));
  const cActive = store.filter((e) => isActive(e) && TARGETS.read.text(e).includes("c@example.com")).length;

  const evidence: JsonRecord = { presentAtOpen, appearedWithoutReopen: appeared !== false, edit, storeC2Status: c2 ? TARGETS.read.status(c2) : "missing", oldCStillActive: cActive, activeMail: store.filter((e) => isActive(e) && TARGETS.read.text(e).includes(MAIL)).length };

  return verdict(!presentAtOpen && appeared !== false && edit.saved === true && edit.trouble === "" && edit.boxStillOpen === false && edit.panelShowsC2 === true
    && evidence.storeC2Status === TARGETS.statuses.active && cActive === 0 && evidence.activeMail === 1, evidence);
}

/** H3 判断失败后补判、不重复；H5 诊断不留原话（同一份导出）。 */
async function h3h5(): Promise<{ h3: Verdict; h5: Verdict }> {
  const QUOTE = "我坐飞机都要靠过道";
  await emptyStores();
  await navigate(HOTEL);
  await newConversation();
  await diagnostics();
  const aisleRule = failRule("靠过道", 1);
  const mark = model.log.length;
  const t = await turn(QUOTE);
  const lastChatAt = Math.max(0, ...t.chat.map((r) => r.at));
  const countAisle = async () => (await readDoc("memories")).items.filter((e) => TARGETS.read.text(e).includes("靠过道")).length;
  // 补判在本轮结束后发生：给它最多 60 秒。
  const afterTurn = await until(async () => (await countAisle()) || undefined, 60_000, "补判记下").catch(() => 0);
  await sleep(3000);
  const settled = await countAisle();
  const another = await turn("帮我看看这页");
  await sleep(5000);
  const afterAnother = await countAisle();
  const traces = await diagnostics();
  proxyControl.rules = [];
  const rows = await openMemoryPanel();
  await shot("H3-panel");
  await closeMemoryPanel();

  const aisleDecisions = model.log.slice(mark).filter((r) => r.decision && r.userMessage.includes("靠过道"));
  const success = aisleDecisions.find((r) => r.status === 200);
  const lines = decisionLines(traces);
  const failLines = lines.filter((l) => TARGETS.diag.failed.test(l));

  const h3Evidence: JsonRecord = {
    interceptedFailures: aisleRule.failed, aisleDecisionRequests: aisleDecisions.length,
    successAfterTurnEnd: success ? success.at > t.endedAt : null, successBeforeNextTurn: success ? success.at < another.sentAt : null,
    msFromTurnEndToRetry: success ? success.at - t.endedAt : null, msFromNextTurnSendToRetry: success ? success.at - another.sentAt : null, lastChatAt,
    countAfterTurn: afterTurn || 0, countSettled: settled, countAfterAnotherTurn: afterAnother, anotherTurnDecisions: another.requests.filter((r) => r.decision).length,
    failureRecords: failLines.length, failureSample: failLines[0]?.slice(0, 300) ?? null, panelRows: rows.filter((r) => r.text.includes("靠过道")).length,
  };

  const h3 = verdict(aisleRule.failed === 1 && aisleDecisions.length >= 2 && settled === 1 && afterAnother === 1 && failLines.length >= 1 && h3Evidence.panelRows === 1, h3Evidence);

  const leaking = lines.filter((l) => l.includes("靠过道"));
  const withKind = lines.filter((l) => l.includes(TARGETS.kinds.aboutYou));
  const h5Evidence: JsonRecord = { decisionRecords: lines.length, recordsWithKind: withKind.length, leaking: leaking.length, leakingSample: leaking[0]?.slice(0, 300) ?? null, sample: lines.slice(0, 3).map((l) => l.slice(0, 300)) };
  const h5 = verdict(lines.length >= 1 && withKind.length >= 1 && leaking.length === 0, h5Evidence);

  return { h3, h5 };
}

/** H6 格式 2 的真实样本升级到 3。字段与 a5552ec 的 shared/memory.ts、agent/src/memory-store.ts StoreFile 同形。 */
async function h6(): Promise<Verdict> {
  const tomorrow = dayStart(1);
  const tomorrowEnd = dayStart(2).getTime() - 1;
  const base = { sourceConversationId: "conv-v2", useCount: 0, formatVersion: 2 };

  const entries = [
    { ...base, id: "v2-email-a", version: 2, text: "邮箱：a@example.com", scope: { kind: "all" }, createdAt: NOW - 20 * DAY, updatedAt: NOW - 10 * DAY, kind: "profile", sourceQuote: "我的邮箱是 a@example.com", useCount: 3, lastUsedAt: NOW - 11 * DAY, status: "replaced", replacedBy: "v2-email-b" },
    { ...base, id: "v2-email-b", version: 1, text: "邮箱：b@example.com", scope: { kind: "all" }, createdAt: NOW - 10 * DAY, updatedAt: NOW - 10 * DAY, kind: "profile", sourceQuote: "我邮箱换成 b@example.com", status: "active" },
    { ...base, id: "v2-name", version: 1, text: "姓名：何一舒", scope: { kind: "all" }, createdAt: NOW - 30 * DAY, updatedAt: NOW - 30 * DAY, kind: "profile", sourceQuote: "我叫何一舒", status: "active" },
    { ...base, id: "v2-site", version: 1, text: "酒店站导出要选全部", scope: { kind: "site", hostname: HOTEL }, createdAt: NOW - 9 * DAY, updatedAt: NOW - 9 * DAY, kind: "profile", status: "active" },
    { ...base, id: "v2-method", version: 1, text: "在 hotel.test 订房要先选日期", scope: { kind: "site", hostname: HOTEL }, createdAt: NOW - 8 * DAY, updatedAt: NOW - 8 * DAY, kind: "method", status: "active", experience: { runId: "run-v2-m", evidence: ["你的纠正：先选日期"], topic: "订房" } },
    { ...base, id: "v2-trip", version: 1, text: "明天北京→成都，东航 V2TRIP-MU88", scope: { kind: "all" }, createdAt: NOW - 2 * DAY, updatedAt: NOW - 2 * DAY, kind: "past", date: iso(tomorrow), validity: { end: tomorrowEnd }, sourceQuote: "我明天飞成都", status: "active" },
  ];

  const tasks = [
    { id: "run-v2-a", conversationId: "conv-v2", goal: "订酒店 V2TASK-A", page: "酒店预订", revisions: [], hosts: [HOTEL], outcome: "complete", summary: "已订", unfinished: [], startedAt: NOW - 5 * DAY, endedAt: NOW - 5 * DAY + 60_000, useCount: 1, lastUsedAt: NOW - 4 * DAY },
    { id: "run-v2-b", conversationId: "conv-v2", goal: "订机票 V2TASK-B", revisions: [], hosts: [HOTEL], outcome: "complete", summary: "已订明天的票", unfinished: [], startedAt: null, endedAt: NOW - 3 * DAY, date: iso(tomorrow), validity: { end: tomorrowEnd } },
    { id: "run-v2-c", conversationId: "conv-v2", goal: "查订单 V2TASK-C", revisions: [], hosts: [HOTEL], outcome: "partial", summary: "查到一半", unfinished: ["还没确认地址"], startedAt: null, endedAt: NOW - 2 * DAY },
  ];

  await putDoc("memories", JSON.stringify({ format: TARGETS.legacyFormat, entries, forgottenExperiences: [] }) + "\n");
  await putDoc("tasks", JSON.stringify({ format: TARGETS.taskFormat, tasks }) + "\n");
  await navigate(HOTEL);
  await newConversation();
  const rows = await openMemoryPanel();
  await shot("H6-panel");
  const allText = String(await rp.evaluate(panel, `document.querySelector("#memory-body")?.textContent ?? ""`));
  const missingInPanel = [...entries.map((e) => e.text), ...tasks.map((t) => t.goal)].filter((x) => !allText.includes(x));
  const aRow = rows.find((r) => r.text.includes("a@example.com"))?.text ?? "";
  const bRow = rows.find((r) => r.text.includes("b@example.com"))?.text ?? "";
  await closeMemoryPanel();

  // 可用：下一轮带给助手的上下文。
  const t = await turn("帮我填邮箱");
  const ctx = t.chat[0]?.context ?? "";
  const usable = { hasB: ctx.includes("b@example.com"), hasA: ctx.includes("a@example.com"), hasName: ctx.includes("何一舒"), hasSite: ctx.includes("酒店站导出要选全部"), hasTrip: ctx.includes("V2TRIP-MU88") };

  // 升级后的库（任何写入之后都应是格式 3；用过次数已更新）。
  const upgraded = await readDoc("memories");
  const find = (id: string) => upgraded.items.find((e) => e.id === id);
  const a = find("v2-email-a");
  const b = find("v2-email-b");
  const chain = { aStatus: a ? TARGETS.read.status(a) : "missing", aReplacedBy: a ? TARGETS.read.replacedBy(a) ?? null : null, bStatus: b ? TARGETS.read.status(b) : "missing" };
  const factA = a ? TARGETS.read.factId(a) : undefined;
  const factB = b ? TARGETS.read.factId(b) : undefined;
  const otherFacts = upgraded.items.filter((e) => !TARGETS.read.text(e).includes(MAIL)).map((e) => TARGETS.read.factId(e));
  const factIdPresent = upgraded.items.some((e) => TARGETS.read.factId(e) !== undefined);
  const factOk = !factIdPresent || (!!factA && factA === factB && !otherFacts.includes(factA));

  // 可用：真点撤销替换，a 恢复唯一生效。
  await openMemoryPanel();
  await sleep(Number(process.env.H6_SETTLE_MS ?? 0));
  const undo = await clickRowButton("邮箱：a@example.com", TARGETS.panel.undoText, TARGETS.panel.replacedText);
  await sleep(1500);
  const hitTest = lastHitTest;
  const trouble = await panelTrouble();
  await shot("H6-after-undo");
  const historyAfterUndo = (await panelRows()).filter((r) => r.text.includes(MAIL)).map((r) => r.text.slice(0, 160));
  await closeMemoryPanel();
  const after = await readDoc("memories");

  const statusOf = (id: string) => {
    const e = after.items.find((x) => x.id === id);

    return e ? TARGETS.read.status(e) : "missing";
  };

  const storedTasks = await readDoc("tasks");

  const evidence: JsonRecord = {
    missingInPanel, aRowShowsReplaced: aRow.includes(TARGETS.panel.replacedText), bRowShowsReplaced: bRow.includes(TARGETS.panel.replacedText), usable,
    formatAfterTurn: TARGETS.read.format(upgraded.raw ?? {}) ?? null, formatAfterUndo: TARGETS.read.format(after.raw ?? {}) ?? null,
    countBefore: entries.length, countAfter: after.items.length, chain, factIdPresent, factA: factA ?? null, factB: factB ?? null, factOk,
    undo: { clicked: undo, hitTest, trouble, aStatus: statusOf("v2-email-a"), bStatus: statusOf("v2-email-b"), historyAfterUndo, storedMail: after.items.filter((e) => TARGETS.read.text(e).includes(MAIL)).map((e) => ({ id: e.id ?? null, version: e.version ?? null, status: TARGETS.read.status(e), replacedBy: TARGETS.read.replacedBy(e) ?? null })) },
    tasksAfter: storedTasks.items.length, tasksBefore: tasks.length,
  };

  const pass = missingInPanel.length === 0 && evidence.aRowShowsReplaced === true && evidence.bRowShowsReplaced === false
    && usable.hasB && !usable.hasA && usable.hasName && usable.hasSite && usable.hasTrip
    && evidence.formatAfterUndo === TARGETS.newFormat && after.items.length === entries.length
    && chain.aStatus === TARGETS.statuses.replaced && chain.aReplacedBy === "v2-email-b" && chain.bStatus === TARGETS.statuses.active && factOk
    && undo && trouble === "" && statusOf("v2-email-a") === TARGETS.statuses.active && statusOf("v2-email-b") === TARGETS.statuses.inactive
    && storedTasks.items.length === tasks.length;

  return verdict(pass, evidence);
}

/** 等到 done() 为真或超时；期间每秒调用 watch()（H7 用来盯「任何时刻」）。 */
async function waitWatching(limitMs: number, done: () => boolean, watch: () => Promise<void>) {
  const start = Date.now();

  while (Date.now() - start < limitMs && !done()) {
    await watch();
    await sleep(1000);
  }

  await watch();
}

const activeMailTexts = async () => (await readDoc("memories")).items.filter((e) => isActive(e) && TARGETS.read.text(e).includes(MAIL)).map((e) => TARGETS.read.text(e));

/**
 * H7 排队中的旧话不能在纠正 / 忘掉之后被补判记回来。
 * 假：补判根本没发生（排队那句被丢了）所以「始终是 b」空洞成立 → 要求代理收到 a 的补判请求（≥2 次），并记录有没有把「save a」真的回给产品。
 *     只在最后看一眼 → 每秒读库，任何时刻 a 生效或生效邮箱 >1 都记为违例。
 */
async function h7(variant: "correct" | "forget"): Promise<Verdict> {
  await emptyStores();
  await navigate(HOTEL);
  await newConversation();
  // 第一次与第一次补判都失败；之后再判就照常回「save a」（像没看出已被纠正的模型）。
  const rule = failRule("我的邮箱是 a@example.com", 2);
  await turn("我的邮箱是 a@example.com");
  const second = await turn(variant === "correct" ? "不对，是 b@example.com" : "忘掉我的邮箱");
  const afterSecond = await activeMailTexts();
  const violations: string[] = [];
  const watchStart = Date.now();

  // 补判节奏未知：等到 a 被回过一次成功判断再多看 10 秒，最多 90 秒。
  let servedAt = 0;

  await waitWatching(90_000, () => servedAt > 0 && Date.now() - servedAt > 10_000, async () => {
    if (rule.served > 0 && !servedAt) servedAt = Date.now();
    const active = await activeMailTexts();
    const bad = active.some((t) => t.includes("a@example.com")) || active.length > 1 || (variant === "forget" && active.length > 0);

    if (bad) violations.push(`${Math.round((Date.now() - watchStart) / 1000)}s: ${active.join(" / ") || "∅"}`);
  });

  proxyControl.rules = [];
  const store = (await readDoc("memories")).items.filter((e) => TARGETS.read.text(e).includes(MAIL));
  const final = store.filter(isActive).map((e) => TARGETS.read.text(e));
  const rows = await openMemoryPanel();
  await shot(`H7-${variant}`);
  await closeMemoryPanel();

  const evidence: JsonRecord = {
    aRequests: rule.seen, aFailed: rule.failed, aServedSuccess: rule.served, secondJudged: second.requests.some((r) => r.decision && !r.userMessage.includes("a@example.com")),
    activeAfterSecond: afterSecond, violations: violations.slice(0, 5), violationCount: violations.length, finalActive: final,
    finalAllMail: store.map((e) => `${TARGETS.read.text(e)}=${TARGETS.read.status(e)}`), panelMailRows: rows.filter((x) => x.text.includes(MAIL)).length,
  };

  const endOk = variant === "correct"
    ? final.length === 1 && final[0]!.includes("b@example.com") && afterSecond.length === 1 && afterSecond[0]!.includes("b@example.com")
    : store.length === 0 && evidence.panelMailRows === 0;

  return verdict(rule.seen >= 2 && violations.length === 0 && endOk, evidence);
}

/**
 * H8 有补判在排队 / 进行中时点停止，几秒内停下。
 * 假：点停止时任务其实已经结束（所以「立刻空闲」）；或根本没有失败排队的判断。
 * 堵：点之前要求侧栏正忙、判断已失败过至少一次；记录点击时代理手里是否正挂着一个补判请求；从点击到空闲计时。
 */
/** 发起一个慢任务并点停止，返回从点击到侧栏空闲的毫秒数（null = 30 秒内没停下）。 */
async function stopSlowTask(waitInFlight: FailRule | null) {
  const before = await send("在这页慢慢写备注H8");
  await until(async () => (await read()).busy || undefined, 15_000, "任务开始").catch(() => undefined);

  if (waitInFlight) await until(async () => waitInFlight.inFlight > 0 || undefined, 20_000, "补判进行中").catch(() => undefined);
  else await sleep(3000);
  const busyBeforeClick = (await read()).busy;
  const stopButtonShown = Boolean(await rp.evaluate(panel, `document.querySelector("#send-btn")?.classList.contains("stopping") ?? false`));
  const inFlightAtClick = waitInFlight?.inFlight ?? 0;
  const clickedAt = Date.now();
  await rp.click(panel, "#send-btn");

  const idle = await until(async () => {
    const st = await read();

    return !st.busy ? Date.now() : undefined;
  }, 30_000, "停下", 100).catch(() => 0);

  const stopMs = idle ? idle - clickedAt : null;
  await waitTurnEnd(before, 60_000).catch(() => undefined);

  return { busyBeforeClick, stopButtonShown, inFlightAtClick, stopMs };
}

/**
 * H8 有补判在排队 / 进行中时点停止，几秒内停下。
 * 假：点停止时任务其实已经结束（所以「立刻空闲」）；或根本没有失败排队的判断。
 * 假失败：脚本没点中停止、或停止本身在这个环境里就慢 → 先在没有排队补判时做一次对照，对照不过就不把失败归到补判上。
 * 堵：点之前要求侧栏正忙、停止按钮在、判断已失败过至少一次；记录点击时代理手里是否正挂着一个补判请求；从点击到空闲计时。
 */
async function h8(): Promise<Verdict> {
  await emptyStores();
  await navigate(NOTE);
  await newConversation();
  const control = await stopSlowTask(null);
  await shot("H8-control-after-stop");
  await newConversation();
  // 第一次立刻失败（进队列）；之后每次补判都先挂 15 秒再失败。
  const rule = failRule("h8@example.com", Number.MAX_SAFE_INTEGER, { ms: 15_000, from: 2 });
  await turn("我的邮箱是 h8@example.com");
  const withQueue = await stopSlowTask(rule);
  await shot("H8-after-stop");
  proxyControl.rules = [];

  const evidence: JsonRecord = { control, withQueue, failedBeforeClick: rule.failed, decisionRequests: rule.seen, transcriptTail: (await read()).transcript.slice(-200) };
  const fast = (r: typeof control) => r.busyBeforeClick && r.stopButtonShown && r.stopMs !== null && r.stopMs <= 5000;

  return verdict(fast(control) && rule.failed >= 1 && fast(withQueue), evidence);
}

/**
 * H9 任务运行中插话后，之前判断失败的那句仍补判、只记 1 条。
 * 假：插话没有真的在任务运行中送达；条目来自别处；之后又被重复记。
 * 堵：插话发出前要求侧栏正忙；代理只拦第一次，条目必须出现（证明补判发生）；最后再等 10 秒复查仍恰好 1 条。
 */
async function h9(): Promise<Verdict> {
  await emptyStores();
  await navigate(NOTE);
  await newConversation();
  const rule = failRule("靠过道", 1);
  const before = await send("我坐飞机都要靠过道。帮我在这页慢慢写备注H9");
  await until(async () => (await read()).busy || undefined, 15_000, "任务开始").catch(() => undefined);
  await sleep(2000);
  const busyAtInterject = (await read()).busy;
  const failedBeforeInterject = rule.failed;
  await send("顺便看下价格");
  await waitTurnEnd(before, 120_000).catch(() => undefined);
  const answered = (await read()).transcript.includes("H9-PRICE");
  const count = async () => (await readDoc("memories")).items.filter((e) => TARGETS.read.text(e).includes("靠过道")).length;
  const appeared = await until(async () => (await count()) || undefined, 90_000, "补判记下").catch(() => 0);
  await sleep(10_000);
  const settled = await count();
  proxyControl.rules = [];

  const evidence: JsonRecord = { busyAtInterject, failedBeforeInterject, answeredInterjection: answered, decisionRequests: rule.seen, served: rule.served, appeared: appeared || 0, settled };

  return verdict(busyAtInterject && failedBeforeInterject === 1 && answered && settled === 1, evidence);
}

// ══ 主流程 ═══════════════════════════════════════════════════════════════════════

/** H5 与 H3 共用一份诊断导出，H3 跑完后把 H5 的判定交出来。 */
interface H5Holder { verdict: Verdict | null }

let fatal: string | null = null;

try {
  const blank = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  workTargetId = blank.targetId;
  work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  ext = await rp.attach((await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/voice-permission.html` })).targetId);
  await until(async () => (await rp.evaluate(ext, `document.readyState === "complete"`)) || undefined, 10_000, "扩展页");
  await navigate(HOTEL);
  panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, work);
  const plan = { providerId: "custom", modelId: "demo-model", credential: { type: "api_key", key: "local-demo-no-secret" } };
  const configured = await configureViaSettings(rp, panel, plan, { baseUrl: model.baseUrl });
  await rp.cdp.send("Target.closeTarget", { targetId: configured.settingsTargetId });
  await rp.cdp.send("Page.bringToFront", {}, work);
  await waitReady();

  const run = async (id: string, fn: () => Promise<Verdict>) => {
    if (!wants(id)) {
      verdicts[id] = { status: "n-a", evidence: { reason: "--only 未选" } };

      return;
    }

    try { verdicts[id] = await fn(); } catch (error) {
      verdicts[id] = { status: "no", evidence: { error: error instanceof Error ? error.message : String(error) } };
      await shot(`${id}-error`).catch(() => undefined);
      await closeMemoryPanel();
    }

    console.log(`${verdicts[id]!.status.toUpperCase()} ${id} ${JSON.stringify(verdicts[id]!.evidence).slice(0, 400)}`);
  };

  await run("H6", h6);
  await run("H1", h1);
  await run("H2", h2);
  await run("H4", h4);
  await run("H7", () => h7("correct"));
  await run("H7b", () => h7("forget"));
  await run("H8", h8);
  await run("H9", h9);

  if (wants("H3")) {
    const h5Holder: H5Holder = { verdict: null };

    await run("H3", async () => {
      const both = await h3h5();
      h5Holder.verdict = both.h5;

      return both.h3;
    });

    if (only && !only.has("H5")) verdicts.H5 = { status: "n-a", evidence: { reason: "--only 未选" } };
    else verdicts.H5 = h5Holder.verdict ?? { status: "no", evidence: { error: "H3 没跑完，H5 无导出可查" } };
    console.log(`${verdicts.H5.status.toUpperCase()} H5 ${JSON.stringify(verdicts.H5.evidence).slice(0, 400)}`);
  }
} catch (error) {
  fatal = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(fatal);
} finally {
  await rp.close().catch(() => undefined);
  await rp.remove().catch(() => undefined);
  await model.close().catch(() => undefined);
  siteServer.closeAllConnections();
  siteServer.close();
}

const ordered = Object.fromEntries(["H1", "H2", "H3", "H4", "H5", "H6", "H7", "H7b", "H8", "H9"].flatMap((id) => verdicts[id] ? [[id, verdicts[id]]] : []));

const failed = Object.entries(ordered).filter(([, v]) => v.status === "no").map(([id]) => id);

const ok = !fatal && failed.length === 0 && Object.values(ordered).some((v) => v.status === "yes");

await writeFile(join(artifacts, "summary.json"), JSON.stringify({ case: "memory-hardening", startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), mode: { scripted: true }, verdicts: ordered, failed, fatal, ok, targets: "见脚本顶部 TARGETS" }, null, 2));

console.log(`${ok ? "PASS" : "FAIL"} memory-hardening ${artifacts}${failed.length ? ` 失败：${failed.join(",")}` : ""}`);

process.exit(ok ? 0 : 1);
