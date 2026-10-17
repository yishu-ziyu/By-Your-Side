/**
 * 实验：pi-durable 跑在隔离扩展的 offscreen 文档里，任务做到一半时重载扩展，重开后能否接着做完、不重复工具调用。
 * 用法（在工作树里）：npx tsx experiments/pi-durable/run.mts，最后一行是 VERDICT PASS / VERDICT FAIL。
 * EXP_SCENARIO：main（默认，A+B+C）；break（重开前清空存储，故意弄坏，应当 FAIL）；midtool（工具执行到一半时打断）。
 * EXP_HEADED=1：有窗口的 Chrome（无头 Chrome 里扩展自重载后不回来，要验真正的扩展重载用它）。
 * 证据写到 out/exp-durable/result.json。
 */
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { evaluateInWorker } from "../../scripts/acceptance/cdp.mjs";
import { REPO, launchRealPath, siteAddress, sleep, until } from "../../scripts/acceptance/real-path/harness.mts";
import { startScriptedModel, type Rule, type TextStep } from "../../scripts/acceptance/real-path/scripted-model.mts";

const OUT = join(REPO, "out/exp-durable");
const DIST = join(OUT, "dist");
const HANG = 600_000;
const SCENARIO = process.env.EXP_SCENARIO ?? "main";

// EXP_PREBUILT=1：远端节点直接用本机构建好、推过去的 out/exp-durable/dist。
if (!process.env.EXP_PREBUILT) {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  execFileSync(process.execPath, [join(REPO, "extension/build.mjs")], { env: { ...process.env, SIDEAGENT_BUILD_DIST: DIST }, stdio: ["ignore", "ignore", "inherit"] });
  execFileSync(join(REPO, "node_modules/.bin/esbuild"), [join(REPO, "experiments/pi-durable/page.ts"), "--bundle", "--format=esm", "--platform=browser", `--outfile=${join(DIST, "exp-durable.js")}`, "--log-level=warning"], { stdio: "inherit" });
  await cp(join(REPO, "experiments/pi-durable/exp-durable.html"), join(DIST, "exp-durable.html"));
}
process.env.SIDEAGENT_ACCEPTANCE_DIST = DIST;

// 工具每被真正执行一次，这里记一次；它在浏览器外面，扩展重载不影响计数。
const hits: Record<string, number> = {};
const slowTools: Record<string, number> = { C1: 2_500, D: 2_500, E: 20_000, F: 20_000 };
const toolServer = createServer(async (req, res) => {
  const label = new URL(req.url ?? "/", "http://x").searchParams.get("label") ?? "?";
  hits[label] = (hits[label] ?? 0) + 1;
  if (slowTools[label]) await sleep(slowTools[label]);
  res.end(`${label} visit #${hits[label]}`);
});
await new Promise<void>((done) => toolServer.listen(0, "127.0.0.1", done));
const toolUrl = `http://127.0.0.1:${siteAddress(toolServer).port}/hit`;

const tool = (label: string) => ({ tool: { name: "count_hit", args: { label } } });
const answerB: TextStep = { text: "任务B完成。", delayMs: HANG };
const answerC1: TextStep = { text: "任务C1完成。", delayMs: HANG };
const answerD: TextStep = { text: "任务D完成。", delayMs: HANG };
const rules: Rule[] = [
  { match: "任务B", steps: [tool("B"), answerB] },
  { match: "任务C1", steps: [tool("C1"), answerC1] },
  { match: "任务C2", steps: [{ text: "任务C2完成。" }] },
  { match: "任务D", steps: [tool("D"), answerD] },
  { match: "任务E", steps: [tool("E"), { text: "任务E收尾。" }] },
  { match: "任务F", steps: [{ tool: { name: "count_hit_safe", args: { label: "F" } } }, { text: "任务F收尾。" }] },
];
const seen: Array<{ users: string[]; toolResults: number }> = [];
const model = await startScriptedModel(rules, undefined, (payload) => {
  const texts = (payload.messages ?? []).filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => p.text ?? "").join("")));
  seen.push({ users: texts, toolResults: (payload.messages ?? []).filter((m) => m.role === "tool").length });
});

const evidence: Record<string, unknown> = { scenario: SCENARIO, browser: "", steps: [] as string[] };
const log = (line: string) => { (evidence.steps as string[]).push(line); console.log(line); };
const rp = await launchRealPath({ headed: process.env.EXP_HEADED === "1" });
evidence.browser = rp.browser;

const workerOf = async () => (await rp.targets()).find((t) => t.type === "service_worker" && t.url.includes(rp.extensionId))?.targetId;
const pageOf = async () => (await rp.targets()).find((t) => t.url.endsWith("/exp-durable.html"))?.targetId;

/** 在扩展里建 offscreen 文档（产品自己的 inproc 文档若已在，先关掉：一个扩展只能有一个），返回它的 CDP 会话。 */
/** 后台被浏览器停掉时没有 CDP 目标；打开一个扩展页面会把它叫醒。 */
async function wakeWorker(): Promise<string> {
  const found = await until(workerOf, 30_000, "service worker").catch(() => undefined);
  if (found) return found;
  log("service worker not running; waking it with an extension page");
  const { targetId } = await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/voice-permission.html`, background: true });
  try { return (await until(workerOf, 20_000, "service worker after wake"))!; } finally { await rp.cdp.send("Target.closeTarget", { targetId }).catch(() => {}); }
}

async function openOffscreen(): Promise<string> {
  // 刚启动或刚重载的后台偶尔不回第一次 evaluate；重新附着再试。
  const made = await until(async () => evaluateInWorker(rp.cdp, await rp.attach(await wakeWorker()), `(async () => {
    if (typeof chrome?.offscreen?.createDocument !== "function") return undefined;
    const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    const before = existing.map((c) => c.documentUrl);
    if (existing.length && !before[0].endsWith("/exp-durable.html")) await chrome.offscreen.closeDocument();
    if (!existing.length || !before[0].endsWith("/exp-durable.html")) await chrome.offscreen.createDocument({ url: "exp-durable.html", reasons: ["WORKERS"], justification: "pi-durable experiment" });
    const after = (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).map((c) => c.documentUrl);
    return JSON.stringify({ before, after });
  })()`, 30_000).catch((e) => { log(`offscreen attempt failed: ${e.message}`); return undefined; }), 180_000, "offscreen created", 1_000);
  log(`offscreen ${made}`);
  const session = await rp.attach((await until(pageOf, 15_000, "offscreen target"))!);
  await until(async () => (await rp.evaluate(session, "typeof globalThis.exp === 'object'")) || undefined, 15_000, "exp ready");
  return session;
}

async function reloadExtension(): Promise<number> {
  const old = await workerOf();
  const started = Date.now();
  await evaluateInWorker(rp.cdp, await rp.attach(old!), "chrome.runtime.reload(), true", 5_000).catch(() => {});
  // 重载后新后台不一定马上起来；旧的 offscreen 消失说明重载已生效，之后由 openOffscreen 里的 wakeWorker 叫醒。
  await until(async () => !(await pageOf()) || undefined, 20_000, "old offscreen gone");
  await until(async () => { const now = await workerOf(); return now !== old || undefined; }, 20_000, "old worker gone");
  return Date.now() - started;
}

const call = (session: string, expr: string, timeoutMs = 60_000) => rp.evaluate(session, `exp.${expr}`, { timeoutMs }) as Promise<any>;
const cfg = JSON.stringify({ baseUrl: model.baseUrl, toolUrl });
const waitStatus = (session: string, id: string, want: string, label: string, ms = 30_000) =>
  until(async () => ((await call(session, `status(${JSON.stringify(id)})`)) === want) || undefined, ms, label, 300);

/** 打断：先试扩展自重载；扩展 20 秒内没回来（Linux 无头 Chrome）就强杀浏览器、用同一配置目录重开（OPFS 在配置目录里）。 */
async function interrupt() {
  const reloadMs = await reloadExtension();
  const back = await until(workerOf, 20_000, "worker back after reload").catch(() => undefined);
  if (!back) {
    log("extension did not come back after chrome.runtime.reload(); killing Chrome (SIGKILL) and reopening the same profile");
    await rp.restart({ abrupt: true });
  }
  evidence.restartKind = back ? "chrome.runtime.reload" : "SIGKILL + same profile";
  log(`restart kind: ${evidence.restartKind}; reload call took ${reloadMs}ms`);
  const page = await openOffscreen();
  if (SCENARIO === "break") { await call(page, "wipe()"); log("BREAK: store wiped before reopening"); }
  await call(page, `open(${cfg})`);
  return page;
}

async function midtool() {
  let page = await openOffscreen();
  await call(page, "wipe()");
  await call(page, `open(${cfg})`);
  const subE = await call(page, `submit("e", "任务E：记一次访问", "e1")`);
  const subF = await call(page, `submit("f", "任务F：记一次访问", "f1")`);
  await until(async () => (hits.E && hits.F) || undefined, 20_000, "E and F tools started");
  await sleep(500);
  log(`midtool before interrupt: hits=${JSON.stringify(hits)} e=${JSON.stringify((await call(page, `snapshot("e")`)).entries)}`);
  page = await interrupt();
  await call(page, "resume()");
  await waitStatus(page, subE, "done", "E done after resume", 60_000);
  await waitStatus(page, subF, "done", "F done after resume", 60_000);
  const e = await call(page, `snapshot("e")`), f = await call(page, `snapshot("f")`);
  log(`midtool after: hits=${JSON.stringify(hits)}`);
  log(`e=${JSON.stringify(e.entries)}`);
  log(`f=${JSON.stringify(f.entries)}`);
  Object.assign(evidence, { midtool: { e, f }, hits });
  assert.equal(hits.E, 1, "不可重做的工具在中途打断后不应再执行");
  assert.ok(e.entries.some((x: string) => x.startsWith("pi.tool-result") && /interrupt/i.test(x)), "不可重做的工具应留下“被打断”的结果给模型");
  assert.ok(e.entries.at(-1)?.includes("任务E收尾"), "E 应在打断后答完");
  assert.equal(hits.F, 2, "可重做的工具在中途打断后应再执行一次");
  assert.ok(f.entries.at(-1)?.includes("任务F收尾"), "F 应在打断后答完");
}

let verdict = "FAIL";
try {
  if (SCENARIO === "midtool") { await midtool(); verdict = "PASS"; throw "done"; }
  let page = await openOffscreen();

  // ── A：存储一致性检查 ──
  const conf = await call(page, "conformance()", 600_000);
  evidence.A = conf;
  log(`A conformance: ${conf.passed}/${conf.total} passed in ${conf.ms}ms, failed=${JSON.stringify(conf.failed).slice(0, 600)}`);

  await call(page, "wipe()");
  await call(page, `open(${cfg})`);

  // ── B：工具结果已存、第二轮模型还没回时重载 ──
  const subB = await call(page, `submit("a", "任务B：记一次访问", "b-1")`);
  await until(async () => seen.some((s) => s.users.at(-1)?.includes("任务B") && s.toolResults === 1) || undefined, 30_000, "B second model request in flight");
  await sleep(500);
  const beforeB = await call(page, `snapshot("a")`);
  log(`B before reload: hits=${JSON.stringify(hits)} status=${await call(page, `status(${JSON.stringify(subB)})`)} entries=${JSON.stringify(beforeB.entries)}`);

  // ── C：同时在两个对话里跑；c 忙时提交 steer 和 follow-up ──
  const subC1 = await call(page, `submit("c", "任务C1：记一次访问", "c1")`);
  const subD = await call(page, `submit("d", "任务D：记一次访问", "d1")`);
  await until(async () => (hits.C1 && hits.D) || undefined, 20_000, "C1 and D tools running");
  const subSteer = await call(page, `submit("c", "补充：回答只要一句话", "c-steer", "steer")`);
  const subC2 = await call(page, `submit("c", "任务C2：再说一句", "c2", "follow-up")`);
  log(`C queued while busy: steer=${await call(page, `status(${JSON.stringify(subSteer)})`)} followUp=${await call(page, `status(${JSON.stringify(subC2)})`)}`);
  await until(async () => (seen.some((s) => s.users.includes("任务C1：记一次访问") && s.toolResults === 1) && seen.some((s) => s.users.at(-1)?.includes("任务D") && s.toolResults === 1)) || undefined, 30_000, "C1 and D second requests in flight");
  await sleep(500);
  const c1Second = seen.find((s) => s.users.includes("任务C1：记一次访问") && s.toolResults === 1)!;
  log(`C1 second request user messages: ${JSON.stringify(c1Second.users)}`);
  const beforeC = { c: await call(page, `snapshot("c")`), d: await call(page, `snapshot("d")`) };
  log(`C before reload: c=${JSON.stringify(beforeC.c.entries)} inbox=${JSON.stringify(beforeC.c.inbox).slice(0, 300)} d=${JSON.stringify(beforeC.d.entries)}`);
  const hitsBefore = { ...hits };
  const requestsBefore = model.requests.length;

  // ── 打断 ──
  answerB.delayMs = 0; answerC1.delayMs = 0; answerD.delayMs = 0;
  page = await interrupt();
  const again = await call(page, `submit("a", "任务B：记一次访问", "b-1")`);
  log(`B same requestId after reload -> same submission: ${again === subB}`);
  await call(page, "resume()");
  if (SCENARIO === "break") { await sleep(3_000); log(`BREAK: hits after resume=${JSON.stringify(hits)}`); }
  assert.equal(again, subB, "同一 requestId 重开后应找回原来的提交");
  await waitStatus(page, subB, "done", "B done after resume");
  assert.equal(hits.B, 1, "B 的工具在打断前已做完，重开后不应再执行");
  for (const [id, label] of [[subC1, "C1"], [subSteer, "steer"], [subC2, "C2"], [subD, "D"]] as const) await waitStatus(page, id, "done", `${label} done after resume`, 40_000);
  await call(page, "waitIdle()");

  const after = { a: await call(page, `snapshot("a")`), c: await call(page, `snapshot("c")`), d: await call(page, `snapshot("d")`) };
  log(`after resume: hits=${JSON.stringify(hits)} (before reload ${JSON.stringify(hitsBefore)})`);
  log(`a=${JSON.stringify(after.a.entries)}`);
  log(`c=${JSON.stringify(after.c.entries)}`);
  log(`d=${JSON.stringify(after.d.entries)}`);
  log(`model requests after reload: ${JSON.stringify(seen.slice(requestsBefore).map((s) => [s.users.at(-1)?.slice(0, 12), s.toolResults]))}`);
  Object.assign(evidence, { B: { beforeB, sameSubmission: again === subB }, C: { c1Second, beforeC }, after, hits, hitsBefore });
  assert.deepEqual(hits, { B: 1, C1: 1, D: 1 }, "每个工具只执行一次");
  assert.ok(after.a.entries.at(-1)?.includes("任务B完成"), "B 应答完");
  assert.deepEqual(c1Second.users.slice(-2), ["任务C1：记一次访问", "补充：回答只要一句话"], "steer 应在工具这一轮之后进入正在跑的那一轮");
  const c = after.c.entries.map((x: string) => x.split(": ")[1] ?? "");
  assert.deepEqual([c.indexOf("补充：回答只要一句话") < c.indexOf("任务C1完成。"), c.indexOf("任务C1完成。") < c.indexOf("任务C2：再说一句"), c.at(-1)], [true, true, "任务C2完成。"], "c：steer 在 C1 答完前，follow-up 在 C1 答完后开始并答完");
  assert.ok(after.d.entries.at(-1)?.includes("任务D完成"), "另一个对话 d 应独立答完");
  verdict = "PASS";
} catch (error) {
  if (error === "done") { /* midtool 走完 */ } else {
  evidence.error = String((error as Error)?.stack ?? error);
  console.error(error);
  }
} finally {
  evidence.verdict = verdict;
  await writeFile(join(OUT, "result.json"), JSON.stringify(evidence, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  toolServer.close();
  console.log(`VERDICT ${verdict}${evidence.error ? `: ${String(evidence.error).split("\n")[0]}` : ""}`);
  process.exit(verdict === "PASS" ? 0 : 1);
}
