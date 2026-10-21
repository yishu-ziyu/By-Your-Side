/**
 * 用户嫌回答方式不好（「以后讲解都给我用卡片或图示」）→ 这一轮答完后侧栏问「…，要我记住吗？」并给出依据原话 →
 * 点「记住」后记忆里有这条到处适用的做法 → 新对话里讲解概念时回答用上了卡片。
 * 反例：只是追问话题的一句不问。
 *
 * 真扩展、隔离无头 Chrome、真模型（默认 MiniMax M3.1；密钥运行时读本机文件，不打印、不落盘）。
 *   npx tsx scripts/acceptance/real-path/style-feedback.mts --headless
 */
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, sleep, until, type Json } from "./harness.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-style-feedback`);
await mkdir(out, { recursive: true });

// 默认用 MiniMax M3.1（密钥在 ~/.pi/agent/auth.json）；BYS_STYLE_MODEL=commandcode 改用 Command Code 的 Claude Haiku 5.5。
const useCommandCode = process.env.BYS_STYLE_MODEL === "commandcode";
const authFile = useCommandCode ? join(homedir(), ".commandcode/auth.json") : join(homedir(), ".pi/agent/auth.json");
const auth: unknown = JSON.parse(readFileSync(authFile, "utf8"));
const field = (value: unknown, name: string): unknown => (typeof value === "object" && value !== null ? Object.getOwnPropertyDescriptor(value, name)?.value : undefined);
const keyValue = useCommandCode ? field(auth, "apiKey") : field(field(auth, "minimax-cn"), "key");
const key = typeof keyValue === "string" ? keyValue : "";

if (!key) throw new Error(`${authFile} 里没有可用的密钥`);
const MODEL = useCommandCode ? { provider: "commandcode", modelId: "claude-haiku-5-5" } : { provider: "minimax-cn", modelId: "MiniMax-M3.1-Flash-Preview" };
/** 前后问同一个没有数字的讲解问题：有数字时默认规则本来就会用卡片，分不出是不是记忆的作用。 */
const EXPLAIN = "解释一下什么是用户画像";

const checks: Array<{ item: string; pass: boolean; detail: Json }> = [];
const check = (item: string, pass: boolean, detail: Json = null) => {
  checks.push({ item, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${item} ${JSON.stringify(detail).slice(0, 300)}`);
};

const rp = await launchRealPath();
let panel = "";
let fatal: string | null = null;

const PANEL = `(() => {
  const q = (s) => document.querySelector(s);
  return {
    connected: q("#status-dot")?.classList.contains("on") ?? false,
    ready: q("#send-btn")?.disabled === false,
    busy: !!(q("#status-pill")?.classList.contains("running") || q("#send-btn")?.classList.contains("stopping") || q(".msg.assistant.streaming, .msg.assistant[data-revealing]")),
    userMessages: document.querySelectorAll("#messages .msg.user").length,
    replies: document.querySelectorAll("#messages .msg:not(.user)").length,
  };
})()`;
type PanelState = { connected: boolean; ready: boolean; busy: boolean; userMessages: number; replies: number };
// SAFETY: PANEL 返回的字段与 PanelState 一一对应。
const read = async () => (await rp.evaluate(panel, PANEL)) as PanelState;
const shot = (name: string) => rp.screenshot(panel, join(out, `${name}.png`));

async function turn(text: string): Promise<void> {
  const before = await read();
  await rp.click(panel, "#input");
  await rp.typeText(panel, text);
  await rp.pressEnter(panel);
  await until(async () => (await read()).userMessages > before.userMessages || undefined, 10_000, "消息发出");
  const started = Date.now();
  let idle = 0;

  while (Date.now() - started < 150_000 && idle < 12) {
    const s = await read().catch(() => null);
    idle = s && !s.busy && s.replies > before.replies && Date.now() - started > 2000 ? idle + 1 : 0;
    await sleep(250);
  }

  if (idle < 12) throw new Error(`150 秒内这一轮没有结束：${text}`);
}

/** 最后一条用户消息之后出现的询问卡片。 */
const lastAsk = async () => await rp.evaluate(panel, `(() => {
  const all = [...document.querySelectorAll("#messages > *")];
  const lastUser = all.map((n) => n.matches(".msg.user")).lastIndexOf(true);
  const card = all.slice(lastUser + 1).flatMap((n) => n.matches(".memory-ask") ? [n] : [...n.querySelectorAll(".memory-ask")]).at(-1);
  if (!card) return null;
  return { line: card.querySelector(".memory-ask-line")?.textContent ?? "", evidence: [...card.querySelectorAll("[data-memory-ask-evidence] div")].map((d) => d.textContent), summary: card.querySelector("[data-memory-ask-evidence] summary")?.textContent ?? "" };
})()`) as { line: string; evidence: string[]; summary: string } | null;

const SAMPLES = 3;

async function newConversation(): Promise<void> {
  await rp.click(panel, "#conversation-new");
  await until(async () => (await rp.evaluate(panel, `document.querySelectorAll(".msg.user").length === 0`)) || undefined, 15_000, "新会话");
  await sleep(800);
}

const cardsInLastAnswer = async () => await rp.evaluate(panel, `[...document.querySelectorAll("#messages .msg.assistant")].at(-1)?.querySelectorAll(".gen-card").length ?? 0`) as number;

const memories = async () => await rp.evaluate(panel, `new Promise((resolve) => {
  const req = indexedDB.open("sideagent-memory", 1);
  req.onsuccess = () => { const get = req.result.transaction("kv").objectStore("kv").get("memories"); get.onsuccess = () => resolve(get.result ?? null); get.onerror = () => resolve(null); };
  req.onerror = () => resolve(null);
})`) as string | null;

try {
  panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: MODEL, inproc_fast_model_config: MODEL })}).then(() => true)`);
  // 密钥直接写进隔离配置的存储，不经命令行和日志。
  await rp.evaluate(panel, `chrome.storage.local.set({["inproc_cred:" + ${JSON.stringify(MODEL.provider)}]: {type: "api_key", key: ${JSON.stringify(key)}}}).then(() => true)`);
  await rp.evaluate(panel, `location.reload(); true`);
  await sleep(1500);
  await until(async () => { const s = await read().catch(() => null); return s?.connected && s.ready ? s : undefined; }, 90_000, "侧栏就绪", 500);

  // 反例：第一句只是问话题，答完不该问。
  // 对照：记住之前，同一个讲解问题在 3 个新对话里各问一次，数用了卡片的次数；模型每次不同，一次分不出差别。
  let baseline = 0;

  for (let i = 0; i < SAMPLES; i++) {
    if (i > 0) await newConversation();
    await turn(EXPLAIN);
    if (await cardsInLastAnswer() > 0) baseline++;
  }
  await shot("0-baseline");
  await sleep(12_000);
  check("只问话题的一句：不出询问卡", (await lastAsk()) === null, { baselineWithCards: baseline });

  await newConversation();
  await turn(EXPLAIN);
  await turn("你又是一大段字。以后讲解都给我用卡片或者图示，别只写文字");
  const ask = await until(async () => (await lastAsk()) ?? undefined, 45_000, "沟通方式的询问卡出现").catch(() => null);
  await shot("1-ask");
  check("抱怨回答方式后出现「要我记住吗」", !!ask && /要我记住吗/.test(ask.line) && /卡片|图/.test(ask.line), ask);
  check("询问卡给出依据原话", !!ask && ask.evidence.some((t) => t.includes("以后讲解都给我用卡片")), ask?.evidence ?? null);

  if (ask) {
    await rp.click(panel, '.memory-ask [data-memory-ask-answer="remember"]');
    const saved = await until(async () => { const text = await memories(); return text && /卡片|图/.test(text) && text.includes('"method"') ? text : undefined; }, 20_000, "做法写进记忆").catch(() => null);
    const entry = saved ? (JSON.parse(saved).entries as Array<{ kind: string; text: string; scope: { kind: string }; status: string }>).find((e) => e.kind === "method" && e.status === "active") : null;
    check("点「记住」后记成到处适用的做法", !!entry && entry.scope.kind === "all", entry ? { text: entry.text, scope: entry.scope } : null);
    const all = saved ? (JSON.parse(saved).entries as Array<{ kind: string; text: string; status: string }>).filter((e) => e.status === "active") : [];
    // 同一句话也可能被自动记忆记成「关于你」：两条都会交给模型，需要知道是哪条起作用。
    check("记忆里只多了这一条做法，没有重复记成别的", all.length === 1, all.map((e) => `${e.kind}: ${e.text}`));
    await shot("2-remembered");

    let after = 0;

    for (let i = 0; i < SAMPLES; i++) {
      await newConversation();
      await turn(EXPLAIN);
      if (await cardsInLastAnswer() > 0) after++;
    }
    await shot("3-new-conversation");
    check(`记住之后用卡片的次数明显多于之前（各 ${SAMPLES} 次）`, after >= SAMPLES - 1 && after > baseline, { baseline, after });
  }
} catch (error) {
  fatal = error instanceof Error ? error.stack ?? error.message : String(error);
} finally {
  // 复盘与询问的决定记录（不含原话）：失败时据此看卡在哪一步。
  const trace = panel ? await rp.evaluate(panel, `new Promise((resolve) => {
    const req = indexedDB.open("sideagent-diagnostics");
    req.onsuccess = () => { const all = req.result.transaction("trace-lines").objectStore("trace-lines").getAll(); all.onsuccess = () => resolve(all.result.map((r) => r.line).filter((l) => /turn_review|memory_ask_decision|side_call/.test(l))); all.onerror = () => resolve([]); };
    req.onerror = () => resolve([]);
  })`).catch(() => []) : [];
  await writeFile(join(out, "decisions.jsonl"), (trace as string[]).join("\n"));
  const status = !fatal && checks.length > 0 && checks.every((c) => c.pass) ? "PASS" : "FAIL";
  await writeFile(join(out, "summary.json"), JSON.stringify({ status, fatal, checks }, null, 2));
  await rp.close();
  await rp.remove();
  console.log(JSON.stringify({ status, out, fatal }));

  if (status !== "PASS") process.exitCode = 1;
}
