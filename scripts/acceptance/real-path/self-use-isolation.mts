/**
 * 模拟用户模式：代理替用户试用时说的话不进用户的记忆、过往任务，诊断里标 self-use，侧栏顶上写明。
 * 只装扩展、隔离构建、本机脚本模型（记忆判断按原话回「记住」）。
 *   npx tsx scripts/acceptance/real-path/self-use-isolation.mts --headless
 *   a) 对照：模式关着，说「记住我的邮箱是 a1@…，以后讲解都用卡片」，记忆多出一条。
 *   b) 打开模式：侧栏顶上出现提示条。
 *   c) 新对话里说同样的话（换个邮箱），记忆条数不变、过往任务不变、没有「已记住」回执和「要我记住吗」卡片。
 *   d) 诊断里这次运行的 run_start 标了 selfUse，对照那次没有。关掉模式后提示条消失。
 * 失败方式：去掉 browser-host 里的只读包装和 usePausedMemory，c 失败。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-self-use-isolation`);

await mkdir(out, { recursive: true });

const USER_A = "记住我的邮箱是 a1@example.com，以后讲解都用卡片。";
const USER_B = "记住我的邮箱是 b2@example.com，以后讲解都用卡片。";

const decision = (email: string) => JSON.stringify({
  action: "save", text: `邮箱：${email}`, evidence: `记住我的邮箱是 ${email}`, scope: { kind: "all" }, targets: [], taskRequested: false,
  about: { longTerm: true, date: null, onlyThisTask: false, explicitRequest: true, dateIsTheTask: false },
});

// 记忆判断的输入是带 "userMessage" 字段的 JSON，排在前面先匹配；主对话的话不带这个字段。
const model = await startScriptedModel([
  { match: `"userMessage":"${USER_A}`, steps: [{ text: decision("a1@example.com") }] },
  { match: `"userMessage":"${USER_B}`, steps: [{ text: decision("b2@example.com") }] },
  { match: "以后讲解都用卡片", steps: [{ text: "好的，以后讲解时我会用卡片。" }] },
]);

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

/** 扩展自己的 IndexedDB：记忆与过往任务（库 sideagent-memory，表 kv），诊断（库 sideagent-diagnostics，表 trace-lines）。 */
const readKv = (key: string) => `new Promise((resolve) => { const r = indexedDB.open("sideagent-memory"); r.onerror = () => resolve(null);
  r.onsuccess = () => { const db = r.result; if (!db.objectStoreNames.contains("kv")) { db.close(); resolve(null); return; }
    const q = db.transaction("kv").objectStore("kv").get(${JSON.stringify(key)}); q.onsuccess = () => { db.close(); resolve(q.result ?? null); }; q.onerror = () => { db.close(); resolve(null); }; }; })`;
const traceStarts = `new Promise((resolve) => { const r = indexedDB.open("sideagent-diagnostics"); r.onerror = () => resolve([]);
  r.onsuccess = () => { const db = r.result; if (!db.objectStoreNames.contains("trace-lines")) { db.close(); resolve([]); return; }
    const q = db.transaction("trace-lines").objectStore("trace-lines").getAll(); q.onsuccess = () => { db.close(); resolve(q.result.map(x => JSON.parse(x.line)).filter(e => e.type === "run_start").map(e => ({ text: e.data?.text ?? "", selfUse: e.data?.selfUse === true }))); }; }; })`;

try {
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(() => true)`);
  const ready = 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")';
  await until(async () => await rp.evaluate(panel, ready), 60_000, "侧栏就绪");
  const memories = async () => { const raw = await rp.evaluate(panel, readKv("memories")) as string | null; return raw ? (JSON.parse(raw).entries ?? []).filter((e: { status?: string }) => e.status === "active").map((e: { text: string }) => e.text) as string[] : []; };
  const tasks = async () => String(await rp.evaluate(panel, readKv("tasks")) ?? "");

  const say = async (text: string) => {
    await rp.click(panel, "#input");
    await rp.typeText(panel, text);
    await rp.pressEnter(panel);
    await until(async () => await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes("以后讲解时我会用卡片"))`) || undefined, 60_000, "收到回答");
    await until(async () => await rp.evaluate(panel, ready), 60_000, "这一轮结束");
  };

  // a) 对照：模式关着，记忆多出一条。
  await say(USER_A);
  const afterA = await until(async () => { const list = await memories(); return list.some(t => t.includes("a1@example.com")) ? list : null; }, 30_000, "对照记下邮箱");
  check("a 对照：模式关着时，这句话记进了记忆", afterA.length === 1, afterA);
  const tasksBefore = await tasks();

  // b) 打开模式：侧栏顶上出现提示条。
  await rp.evaluate(panel, `chrome.storage.local.set({ sideagent_self_use: { until: Date.now() + 3600_000 } }).then(() => true)`);
  const banner = await until(async () => await rp.evaluate(panel, `(() => { const b = document.querySelector("#self-use-banner"); return b && !b.hidden ? b.textContent : null; })()`) as string | null, 10_000, "提示条出现");
  check("b 打开模式后侧栏顶上写明不写记忆", banner.includes("不写记忆"), banner);

  // c) 新对话里说同样的话：记忆、过往任务都不变，没有回执和提问卡。
  await rp.click(panel, "#conversation-new");
  await sleep(1_500);
  await until(async () => await rp.evaluate(panel, ready), 60_000, "新对话就绪");
  await say(USER_B);
  await sleep(8_000);
  const afterB = await memories();
  check("c 模拟用户说「以后都用卡片」后，用户的记忆条数不变", afterB.length === afterA.length && !afterB.some(t => t.includes("b2@example.com")), { before: afterA.length, after: afterB.length, entries: afterB });
  check("c 过往任务不变", (await tasks()) === tasksBefore, null);
  const visible = await rp.evaluate(panel, `({ receipts: document.querySelectorAll(".memory-receipt").length, asks: document.querySelectorAll(".memory-ask").length })`) as { receipts: number; asks: number };
  check("c 这段对话里没有「已记住」回执，也没有「要我记住吗」卡片", visible.receipts === 0 && visible.asks === 0, visible);
  await rp.screenshot(panel, join(out, "c-self-use.png"));

  // d) 诊断里这次运行标了 self-use，对照那次没有；关掉后提示条消失。
  const starts = await rp.evaluate(panel, traceStarts) as Array<{ text: string; selfUse: boolean }>;
  const startA = starts.find(s => s.text.includes("a1@example.com"));
  const startB = starts.find(s => s.text.includes("b2@example.com"));
  check("d 诊断里这次运行标了 self-use，对照那次没有", startB?.selfUse === true && startA?.selfUse === false, { startA: startA ?? null, startB: startB ?? null });
  await rp.evaluate(panel, `chrome.storage.local.remove("sideagent_self_use").then(() => true)`);
  check("d 关掉模式后提示条消失", await until(async () => await rp.evaluate(panel, `document.querySelector("#self-use-banner")?.hidden === true`) || undefined, 10_000, "提示条消失") === true, null);
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.length > 0 && checks.every(c => c.pass) ? "PASS" : "FAIL", checks, modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close();
}

console.log(`证据：${out}`);

if (checks.length === 0 || checks.some(c => !c.pass)) process.exitCode = 1;
