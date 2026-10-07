/**
 * R2–R4 驱动：构建实验扩展 → 无头 Chrome（--headless=new）加载 → 经 CDP 调页面里的 window.spike.*。
 * 用法：node drive.mjs --headless [r2] [r3] [steer] [r4] [faux] [r5] [r6]（不带阶段名时跑 r2–faux；r5、r6 要点名）。结果写 out/pi1-durable/。
 * 凭据：~/.pi/agent/auth.json["openai-codex"] 的访问令牌，剩余不足 3 小时就停（BLOCKED），从不刷新、从不打印。
 */
import * as esbuild from "esbuild";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (!process.argv.includes("--headless")) { console.error("只在无头模式下运行：加 --headless"); process.exit(2); }

const here = path.dirname(fileURLToPath(import.meta.url));

const out = path.join(here, "../../../out/pi1-durable");

const extDir = path.join(out, "ext");

mkdirSync(extDir, { recursive: true });

const phases = ["r2", "r3", "steer", "r4", "faux", "r5", "r6"].filter((p) => process.argv.includes(p));

const run = phases.length ? phases : ["r2", "r3", "steer", "r4", "faux"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 凭据（3 小时保护，不刷新） ----------
const login = JSON.parse(readFileSync(path.join(homedir(), ".pi/agent/auth.json"), "utf8"))["openai-codex"];

if (!login || login.expires - Date.now() < 3 * 3_600_000) { console.log("BLOCKED: openai-codex 令牌缺失或 3 小时内过期"); process.exit(3); }

const cred = JSON.stringify({ access: login.access, expires: login.expires, accountId: login.accountId });

// ---------- 构建扩展 ----------
const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "der" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });

const extId = Array.from(createHash("sha256").update(publicKey).digest("hex").slice(0, 32), (c) => String.fromCharCode(97 + parseInt(c, 16))).join("");

await esbuild.build({ entryPoints: [path.join(here, "ext-src/spike.ts"), path.join(here, "ext-src/r56.ts")], outdir: extDir, bundle: true, platform: "browser", target: "chrome120", format: "esm", external: ["node:*"], define: { "process.env": "{}" }, logLevel: "warning" });

copyFileSync(path.join(here, "ext-src/spike.html"), path.join(extDir, "spike.html"));

writeFileSync(path.join(extDir, "r56.html"), readFileSync(path.join(here, "ext-src/spike.html"), "utf8").replace("spike.js", "r56.js"));

writeFileSync(path.join(extDir, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "pi1-durable spike", version: "0.0.1", key: publicKey.toString("base64"), host_permissions: ["https://chatgpt.com/*"], permissions: ["unlimitedStorage"] }, null, 2));

// ---------- 无头 Chrome ----------
function chromePath() {
  if (process.env.EGO_ACCEPTANCE_CHROME) return process.env.EGO_ACCEPTANCE_CHROME;
  const root = path.join(homedir(), "Library/Caches/ms-playwright");
  const v = readdirSync(root).filter((n) => /^chromium-\d+$/.test(n)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));

  for (const n of v) {
    const p = path.join(root, n, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");

    if (existsSync(p)) return p;
  }

  throw new Error("找不到 Chrome for Testing");
}

const profile = mkdtempSync(path.join(tmpdir(), "pi1-spike-"));

const chrome = spawn(chromePath(), ["--headless=new", "--use-mock-keychain", "--enable-unsafe-extension-debugging", `--user-data-dir=${profile}`, "--remote-debugging-port=0", `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--no-first-run", "--no-default-browser-check", "--window-size=1100,900", "about:blank"], { stdio: "ignore" });

let port;

for (let i = 0; i < 100 && !port; i++) { await sleep(200); port = existsSync(path.join(profile, "DevToolsActivePort")) && readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; }

const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();

const ws = new WebSocket(version.webSocketDebuggerUrl);

await new Promise((r) => ws.addEventListener("open", r, { once: true }));

let seq = 0;

const pending = new Map();

ws.addEventListener("message", (m) => {
  const msg = JSON.parse(m.data);

  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});

const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, (msg) => msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)); ws.send(JSON.stringify({ id, method, params, sessionId })); });

let session;

let api = "spike"; // 页面里的全局对象：spike.html 是 spike，r56.html 是 r56

async function openPage(page = "spike") {
  api = page;
  const { targetId } = await send("Target.createTarget", { url: `chrome-extension://${extId}/${page}.html` });
  session = (await send("Target.attachToTarget", { targetId, flatten: true })).sessionId;
  await send("Page.enable", {}, session);
  await waitReady();
}

async function waitReady() {
  for (let i = 0; i < 100; i++) {
    try { if (await evalRaw(`!!globalThis.${api}`)) return; } catch {}

    await sleep(100);
  }

  throw new Error("spike 页面没就绪");
}

async function evalRaw(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, session);

  if (r.exceptionDetails) throw new Error(`页面异常：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);

  return r.result.value;
}

const call = (fn, ...args) => evalRaw(`${api}.${fn}(${args.map((a) => JSON.stringify(a)).join(",")})`);

// 凭据单独注入：表达式里含令牌，出错时不把表达式带进报错。
const setup = async () => {
  const r = await send("Runtime.evaluate", { expression: `${api}.setup(${cred})`, awaitPromise: true, returnByValue: true }, session);

  if (r.exceptionDetails) throw new Error("setup 失败");

  return r.result.value;
};

const show = (text) => evalRaw(`document.getElementById("log").textContent = ${JSON.stringify(text.slice(0, 6000))}; true`);

const save = (name, obj) => { writeFileSync(path.join(out, name), JSON.stringify(obj, null, 2)); console.log(`→ out/pi1-durable/${name}`); };

async function waitFor(check, ms, what) {
  const end = Date.now() + ms;

  while (Date.now() < end) {
    const v = await check();

    if (v) return v;
    await sleep(150);
  }

  throw new Error(`超时：${what}`);
}

async function reloadPage() { await send("Page.reload", { ignoreCache: true }, session); await sleep(300); await waitReady(); await setup(); }

const results = {};

try {
  if (run.some((p) => !["r5", "r6"].includes(p))) {
    await openPage("spike");
    console.log("setup", await setup());
  }

  if (run.includes("r2")) {
    await call("resetCounters");
    const open = await call("openDurable", "r2");
    const ask = await call("durableAsk", "Use the page_title tool to get the title of the current page, then reply with exactly that title and nothing else.");
    await call("close");
    results.r2 = { open, ask };
    save("r2-result.json", results.r2);
    await show([`R2 status=${ask.status} firstDeltaMs=${ask.firstDeltaMs} totalMs=${ask.totalMs} writes=${ask.writes.txns} txns / ${ask.writes.bytes} B`, ...ask.entries.map((e) => `${e.kind}: ${e.model.map((m) => m.parts.join(" | ")).join(" ; ")}`)].join("\n"));
    const shot = await send("Page.captureScreenshot", { format: "png" }, session);
    writeFileSync(path.join(out, "r2-screenshot.png"), Buffer.from(shot.data, "base64"));
  }

  if (run.includes("r3")) {
    await call("resetCounters");
    await call("openDurable", "r3");
    const started = await call("durableStart", "Call slow_lookup with key \"alpha\" and ms 8000, then tell me the code word. If the tool returns an error, reply exactly TOOL FAILED and do not call any tool again.");

    const mid = await waitFor(async () => {
      const l = await call("liveTools");

      return l.execs.slow_lookup >= 1 && l;
    }, 60_000, "slow_lookup 开始执行");

    await sleep(1500);
    const reloadAt = Date.now();
    await send("Page.reload", { ignoreCache: true }, session);
    await sleep(300);
    await waitReady();
    await setup();
    const resumed = await call("durableResume", "r3");
    await call("close");
    results.r3 = { started, liveBeforeReload: mid, reloadAt, resumed };
    save("r3-result.json", results.r3);
  }

  if (run.includes("steer")) {
    await call("resetCounters");
    await call("openDurable", "steer");
    const first = await call("durableStart", "Call slow_lookup with key \"beta\" and ms 5000, then report the code word in one short sentence.");
    await waitFor(async () => (await call("liveTools")).execs.slow_lookup >= 1, 60_000, "slow_lookup 开始执行");
    const steer = await call("steer", "Also: end your final answer with the single word BANANA.");
    const firstStatus = await call("waitSubmission", first.submissionId);
    const steerStatus = await call("waitSubmission", steer.submissionId);
    const transcript = await call("transcript");
    const execs = (await call("liveTools")).execs;
    await call("close");
    results.steer = { firstStatus, steerStatus, execs, transcript };
    save("steer-result.json", results.steer);
  }

  if (run.includes("r4")) {
    const prompt = "Use the page_title tool to get the title of the current page, then reply with exactly that title and nothing else.";
    const rows = [];

    for (let i = 0; i < 3; i++) {
      const open = await call("openDurable", `r4-${Date.now()}`);
      const d = await call("durableAsk", prompt);
      await call("close");
      rows.push({ engine: "pi-durable", run: i + 1, status: d.status, firstDeltaMs: d.firstDeltaMs, firstTextMs: d.firstTextMs, totalMs: d.totalMs, assistantTurns: d.assistantTurns, writeTxns: d.writes.txns, writeBytes: d.writes.bytes, openWriteTxns: open.openWrites.txns, openMs: open.openMs });
      const b = await call("bareAsk", prompt);
      rows.push({ engine: "agent-core", run: i + 1, status: b.error ? `error: ${b.error}` : "done", startMs: b.startMs, firstDeltaMs: b.firstDeltaMs, totalMs: b.totalMs, assistantTurns: b.assistantTurns, writeTxns: 0, writeBytes: 0, answer: b.messages.at(-1)?.parts });
    }

    results.r4 = rows;
    save("r4-result.json", rows);
    console.table(rows.map(({ answer: _answer, ...r }) => r));
  }

  if (run.includes("faux")) {
    const rows = await call("overhead", 10);

    const stat = (engine) => {
      const t = rows.filter((r) => r.engine === engine).map((r) => r.totalMs).sort((a, b) => a - b);

      return { engine, n: t.length, medianMs: t[Math.floor(t.length / 2)], minMs: t[0], maxMs: t.at(-1), statuses: [...new Set(rows.filter((r) => r.engine === engine).map((r) => r.status))] };
    };

    results.faux = { summary: [stat("pi-durable"), stat("agent-core")], rows };
    save("r4-faux-result.json", results.faux);
    console.table(results.faux.summary);
  }

  // ---------- R5 接管→交还 ----------
  if (run.includes("r5")) {
    await openPage("r56");
    await setup();
    await call("reset");
    const db = `r5-${Date.now()}`;
    const { rootId } = await call("open", db);
    const USER_PHONE = "13912345678";
    const task = "Fill the form on this page with: name = Li Lei, phone = 13800000000, email = lilei@example.com, city = Hangzhou. Call fill_field once per field, in exactly that order, one call at a time. When all four fields are filled, reply DONE and a one-line summary.";
    const t0 = Date.now();
    const first = await call("start", rootId, task);
    // 接管点：电话这一格的 fill_field 正在执行。
    const inflight = await waitFor(async () => (await call("state")).execs.find((e) => e.arg.startsWith("phone=") && e.end === undefined), 90_000, "电话这一格开始填");
    await sleep(300);
    const takeAt = Date.now();
    const take = await call("takeover", rootId);
    const firstStatus = await call("waitSubmission", first.submissionId);
    const firstTokenMs = await call("firstToken", rootId);
    const transcriptAtTakeover = await call("transcript", rootId);
    // 用户接管期间改电话，然后页面重载（侧边栏关掉再打开），重开同一个库。
    const edited = await call("userEdit", "phone", USER_PHONE);
    await reloadPage();
    const reopened = await call("reopen", db);
    const handback = `交还：我接管期间把电话改成了 ${USER_PHONE}，这是我要的值，不要再改它。当前页面表单：${JSON.stringify(edited)}。其余你继续。`;
    const t1 = Date.now();
    const hb = await call("start", rootId, handback);
    const hbStatus = await call("waitSubmission", hb.submissionId);
    const handbackMs = Date.now() - t1;
    const handbackFirstTokenMs = await call("firstToken", rootId);
    const final = await call("state");
    // 再重载一次，读会话记录，看是不是一个连贯的任务。
    await reloadPage();
    const reopened2 = await call("reopen", db);
    const tr = await call("transcript", rootId);
    await call("close");
    const msgs = tr.flatMap((e) => e.model);
    const callIds = msgs.flatMap((m) => m.parts.filter((p) => p.startsWith("toolCall:")).map((p) => p.split("#").at(-1)));
    const resultIds = msgs.filter((m) => m.role === "toolResult").map((m) => m.callId);

    const checks = {
      a_interruptedCallRanOnce: final.execs.filter((e) => e.callId === inflight.callId).length === 1,
      a_phoneFilledByAgentOnce: final.execs.filter((e) => e.arg.startsWith("phone=")).length === 1,
      b_sameConversation: reopened.rootId === rootId && reopened2.rootId === rootId,
      b_handbackDone: hbStatus.status === "done",
      b_restFilled: final.form.name === "Li Lei" && final.form.email === "lilei@example.com" && final.form.city === "Hangzhou",
      c_userPhoneKept: final.form.phone === USER_PHONE,
      d_twoUserMessages: msgs.filter((m) => m.role === "user").length === 2,
      d_everyCallHasOneResult: callIds.length === new Set(callIds).size && callIds.every((id) => resultIds.filter((r) => r === id).length === 1),
      d_endsWithAssistantText: msgs.at(-1)?.role === "assistant" && msgs.at(-1).parts.some((p) => p.startsWith("text:")),
      d_nothingPendingAfterReload: reopened2.pendingAtOpen.tasks.length === 0 && reopened2.pendingAtOpen.submissions.length === 0,
    };

    results.r5 = {
      pass: Object.values(checks).every(Boolean), checks,
      timings: { firstTokenMs, untilTakeoverMs: takeAt - t0, abortMs: take.abortMs, handbackMs, handbackFirstTokenMs },
      firstStatus, inflight, atTakeover: { form: take.form, execs: take.execs, transcript: transcriptAtTakeover },
      reopened, handback, hbStatus, final, reopened2, transcript: tr,
    };
    save("r5-result.json", results.r5);
    console.log("R5", results.r5.pass ? "PASS" : "FAIL", checks, results.r5.timings);
  }

  // ---------- R6 两个任务同时跑 ----------
  if (run.includes("r6")) {
    await openPage("r56");
    await setup();
    await call("reset");
    const db = `r6-${Date.now()}`;
    const { rootId: aId } = await call("open", db);
    const bId = await call("newConversation");
    const prompt = (p) => `Call slow_word for key "${p}1", then "${p}2", then "${p}3", one call at a time, waiting for each result before the next call. Then reply with the three secret words separated by single spaces and nothing else.`;
    const t0 = Date.now();
    const [sa, sb] = await Promise.all([call("start", aId, prompt("a")), call("start", bId, prompt("b"))]);

    // 重载点：至少两次查询做完，且还有一次正在执行。
    const beforeReload = await waitFor(async () => {
      const s = await call("state");

      return s.execs.filter((e) => e.end).length >= 2 && s.execs.some((e) => !e.end) && s;
    }, 120_000, "两次查询做完且一次在跑");

    const firstTokenMs = { a: await call("firstToken", aId), b: await call("firstToken", bId) };
    const reloadAt = Date.now();
    await reloadPage();
    const reopened = await call("reopen", db);
    const [ra, rb] = await Promise.all([call("waitSubmission", sa.submissionId), call("waitSubmission", sb.submissionId)]);
    const wallMs = Date.now() - t0;
    const final = await call("state");
    const ta = await call("transcript", aId);
    const tb = await call("transcript", bId);
    await call("close");
    const A = ["PELICAN", "GRANITE", "SAFFRON"];
    const B = ["WALRUS", "COBALT", "TAMARIND"];
    const answer = (t) => t.flatMap((e) => e.model).filter((m) => m.role === "assistant").at(-1)?.parts.filter((p) => p.startsWith("text:")).join(" ") ?? "";
    const iv = (conv) => final.execs.filter((e) => e.conv === conv).map((e) => [e.start, e.end ?? reloadAt]);
    let overlapMs = 0;

    for (const [s1, e1] of iv(aId)) for (const [s2, e2] of iv(bId)) overlapMs += Math.max(0, Math.min(e1, e2) - Math.max(s1, s2));
    const finished = final.execs.filter((e) => e.end && !e.aborted);
    const rerunFinished = final.execs.filter((e, i) => final.execs.slice(0, i).some((f) => f.callId === e.callId && f.end));
    const keyCount = (conv, key) => finished.filter((e) => e.conv === conv && e.arg === key).length;

    const checks = {
      overlap: overlapMs > 0,
      bothDone: ra.status === "done" && rb.status === "done",
      aCorrect: A.every((w) => answer(ta).includes(w)) && !B.some((w) => answer(ta).includes(w)),
      bCorrect: B.every((w) => answer(tb).includes(w)) && !A.some((w) => answer(tb).includes(w)),
      aIsolated: !B.some((w) => JSON.stringify(ta).includes(w)) && !/"key":"b\d"/.test(JSON.stringify(ta)),
      bIsolated: !A.some((w) => JSON.stringify(tb).includes(w)) && !/"key":"a\d"/.test(JSON.stringify(tb)),
      noFinishedToolRerun: rerunFinished.length === 0,
      eachKeyFinishedOnce: ["1", "2", "3"].every((n) => keyCount(aId, `a${n}`) === 1 && keyCount(bId, `b${n}`) === 1),
    };

    results.r6 = {
      pass: Object.values(checks).every(Boolean), checks,
      timings: { wallMs, firstTokenMs, untilReloadMs: reloadAt - t0, overlapMs, afterReloadMs: Date.now() - reloadAt },
      ids: { aId, bId }, statuses: { a: ra, b: rb }, answers: { a: answer(ta), b: answer(tb) },
      execsBeforeReload: beforeReload.execs, execs: final.execs, modelRequests: final.reqs, reopened, transcripts: { a: ta, b: tb },
    };
    save("r6-result.json", results.r6);
    console.log("R6", results.r6.pass ? "PASS" : "FAIL", checks, results.r6.timings);
  }
} catch (e) {
  console.error("失败：", e.message);
  process.exitCode = 1;
} finally {
  ws.close();
  chrome.kill("SIGTERM");
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
}
