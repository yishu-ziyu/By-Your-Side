/**
 * 改过网页的一轮，先核对再说完成（docs/evals/20261009-claim-after-check.md R1、R2、R4）。只装扩展、隔离构建、本机脚本模型。
 *   npx tsx scripts/acceptance/real-path/claim-after-check.mts --headless
 * 做法：模型地址指向本机转发服务；目标核对请求（系统提示词以核对说明开头）在这里按用例扣住，再换成脚本结论。
 * 每 50 毫秒读一次侧栏，记下什么时候出现了什么。
 *   a) 填错「Note」并说「已填入第一句」，核对扣 3 秒判继续：结论前侧栏任何地方都没有这句话；之后它只在折叠的执行过程里；
 *      等待时有「正在核对结果」，之后有「核对发现」；读回显示「草稿现在是：「Note」」；续做填对后第二次核对判完成，回答出现。
 *   b) 网页在输入时改成大写：读回显示大写值。
 *   c) 核对扣 10 秒：回答在「正在核对结果」出现后 5–8 秒放出，并标「结果还没确认」。
 *   d) a 的第一轮没有「核对」一行（R4：没有适用的核对）。
 *   e) 填对、核对马上判完成：记下首个可见反馈和最终回答的耗时。
 *   f) 网页把输入清空，核对却判完成：读回对不上，回答只按「结果还没确认」放出。
 *   g) browser_run 程序里的 browser.fill：读回同样显示在侧栏。
 * 失败方式：去掉侧栏的扣住，a 的那句话在核对结论前出现（反例结果见验收文件）。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-claim-after-check`);

await mkdir(artifacts, { recursive: true });

const NOTE_FIRST = "Jev currently accepts text input only.";

const page = (title: string, body: string) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

const DRAFT = `<h2>我的草稿</h2><textarea id="draft" rows="4" cols="60" aria-label="草稿"></textarea>`;

const site = createServer((req, res) => {
  const body = req.url === "/upper"
    ? page("大写草稿", `<main>${DRAFT}<script>document.getElementById("draft").addEventListener("input", e => { e.target.value = e.target.value.toUpperCase(); });</script></main>`)
    : req.url === "/strip"
    ? page("留不住的草稿", `<main>${DRAFT}<script>document.getElementById("draft").addEventListener("input", e => { e.target.value = ""; });</script></main>`)
    : page("System One 与草稿", `<main><h1>System One</h1><div style="background:#e8f0ff;border:1px solid #6b8cff;padding:12px"><div><strong>Note</strong></div><p>${NOTE_FIRST} Image input is planned for a later release.</p></div>${DRAFT}</main>`);

  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
});

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const fill = (value: string) => ({ tool: { name: "fill", args: { target: "#draft", value } } });

const CASES = {
  a: { ask: "案例A：把蓝色 Note 框里的第一句英文原文复制到下面的草稿框里，不要保存。", claim: "已填入第一句。", path: "/note" },
  b: { ask: "案例B：在草稿框里写 hello world，不要保存。", claim: "草稿已写好 B。", path: "/upper" },
  c: { ask: "案例C：在草稿框里写 Note C，不要保存。", claim: "草稿已写好 C。", path: "/note" },
  e: { ask: "案例E：把蓝色 Note 框里的第一句英文复制到草稿框里，不要保存。", claim: "已把第一句填进草稿框 E。", path: "/note" },
  f: { ask: "案例F：在草稿框里写 keep me，不要保存。", claim: "草稿已写好 F。", path: "/strip" },
  g: { ask: "案例G：用一段程序在草稿框里写 from program，不要保存。", claim: "草稿已写好 G。", path: "/note" },
};

const FIXED = "已把第一句英文填入草稿框，没有保存。";

const CORRECTION = "「Note」是框的标题，不是第一句";

const GOAL_CHECK_PREFIX = "You check whether a browser assistant has finished the user's goal";

/** 助手（脚本模型）收到的填写回执原文：R1 要求读回的实际内容和对不上的问题写在里面。 */
const toolTexts = new Set<string>();

const model = await startScriptedModel([
  // 核对判继续后宿主发的续做消息：先看一眼页面（同一栏已有成功回执，产品要求重填前先读页），再填对、回答。
  // 放在最前，续做消息里带着用户原话也先认它。
  { match: "[GOAL CHECK]", steps: [{ tool: { name: "snapshot", args: {} } }, fill(NOTE_FIRST), { text: FIXED }] },
  { match: CASES.a.ask, steps: [fill("Note"), { text: CASES.a.claim }] },
  { match: CASES.b.ask, steps: [fill("hello world"), { text: CASES.b.claim }] },
  { match: CASES.c.ask, steps: [fill("Note C"), { text: CASES.c.claim }] },
  { match: CASES.e.ask, steps: [fill(NOTE_FIRST), { text: CASES.e.claim }] },
  { match: CASES.f.ask, steps: [fill("keep me"), { text: CASES.f.claim }] },
  { match: CASES.g.ask, steps: [{ tool: { name: "browser_run", args: { label: "写草稿", code: 'return await browser.fill({ target: "#draft", value: "from program" });' } } }, { text: CASES.g.claim }] },
  { match: "VERDICT-CONTINUE", steps: [{ text: JSON.stringify({ status: "continue", remaining: "填入第一句", correction: CORRECTION }) }] },
  { match: "VERDICT-DONE", steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
], undefined, payload => {
  for (const m of payload.messages ?? []) {
    const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map(p => p.text ?? "").join("") : "";

    if (m.role === "tool" && text.startsWith("Filled #draft")) toolTexts.add(text);
  }
});

/** 接下来的目标核对依次怎么回：扣多久、什么结论。没排上的马上判完成。 */
const verdicts: Array<{ holdMs: number; probe: "VERDICT-CONTINUE" | "VERDICT-DONE" }> = [];

const checks: Array<{ probe: string; receivedAt: number; releasedAt: number }> = [];

const proxy = createServer(async (req, res) => {
  let body = "";

  for await (const chunk of req) body += String(chunk);
  let forward = body;

  if (req.method === "POST" && body.includes(GOAL_CHECK_PREFIX)) {
    const receivedAt = Date.now();
    const next = verdicts.shift() ?? { holdMs: 0, probe: "VERDICT-DONE" as const };
    await sleep(next.holdMs);
    // SAFETY: OpenAI 兼容请求体；只换 messages，保留 stream 等其余字段。
    const payload = JSON.parse(body) as Record<string, unknown>;
    forward = JSON.stringify({ ...payload, messages: [{ role: "user", content: next.probe }] });
    checks.push({ probe: next.probe, receivedAt, releasedAt: Date.now() });
  }

  // 收尾时脚本模型先关了，扣着的核对再转发会连不上：回 502，不让进程崩掉。
  try {
    const upstream = await fetch(`${model.baseUrl.replace(/\/$/, "")}${(req.url ?? "").replace(/^\/v1/, "")}`, { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "POST" ? forward : undefined });
    res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" }).end(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    res.writeHead(502).end();
  }
});

await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));

const rp = await launchRealPath();

/** 侧栏一次读数（毫秒相对发出那一刻）。 */
type Sample = { t: number; evidenceBlocks: number; claimAnywhere: boolean; claimOutsideProcess: boolean; checking: boolean; fix: string[]; evidence: string[]; answers: string[]; unconfirmed: boolean; runChecks: string[] };

const SAMPLE_JS = (claim: string) => `(() => {
  const m = document.querySelector("#messages");
  const vis = el => el.getClientRects().length > 0;
  const texts = sel => [...m.querySelectorAll(sel)].filter(vis).map(el => el.textContent.trim());
  const outside = m.cloneNode(true);
  outside.querySelectorAll("details.run-steps").forEach(n => n.remove());
  const lastEvidence = [...m.querySelectorAll(".fill-evidence")].filter(vis).at(-1);
  return {
    evidenceBlocks: [...m.querySelectorAll(".fill-evidence")].filter(vis).length,
    claimAnywhere: m.textContent.includes(${JSON.stringify(claim)}),
    claimOutsideProcess: outside.textContent.includes(${JSON.stringify(claim)}),
    checking: texts(".claim-checking").some(t => t.includes("正在核对结果")),
    fix: texts(".claim-fix"),
    evidence: lastEvidence ? [...lastEvidence.querySelectorAll(".fill-evidence-line")].map(el => el.textContent.trim()) : [],
    answers: texts(".msg.assistant[data-delivery-id]"),
    unconfirmed: texts(".claim-unconfirmed").some(t => t === "结果还没确认"),
    runChecks: [...m.querySelectorAll(".run-check")].map(el => el.textContent.trim()),
  };
})()`;

let error: string | null = null;

const evidence: Record<string, unknown> = {};

/** 失败时存下侧栏消息区的 HTML，便于复查。 */
let panelForDump: string | null = null;

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "fixture tab");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: `${origin}/note` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  panelForDump = panel;

  const items = {
    inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: `http://127.0.0.1:${siteAddress(proxy).port}/v1` },
    "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" },
  };

  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");

  const settled = () => until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")') || undefined, 60_000, "previous turn settled", 100);

  /** 发出一条，每 50 毫秒读一次侧栏，直到 done 返回 true 或超时。 */
  async function runCase(key: keyof typeof CASES, done: (s: Sample) => boolean, shots: Record<string, (s: Sample) => boolean> = {}, limitMs = 60_000) {
    const c = CASES[key];
    await settled();
    await rp.cdp.send("Page.navigate", { url: `${origin}${c.path}` }, work);
    await sleep(500);
    await rp.click(panel, "#input");
    await rp.typeText(panel, c.ask);
    /** 发出前已有的读回块数：首个反馈只算这一轮新出现的。 */
    const evidenceBefore = Number(await rp.evaluate(panel, '[...document.querySelectorAll("#messages .fill-evidence")].filter(el => el.getClientRects().length > 0).length'));
    const sentAt = Date.now();
    await rp.pressEnter(panel);
    const samples: Sample[] = [];
    const taken = new Set<string>();

    for (;;) {
      const s = { t: Date.now() - sentAt, ...(await rp.evaluate(panel, SAMPLE_JS(c.claim)) as Omit<Sample, "t">) };
      samples.push(s);

      for (const [name, when] of Object.entries(shots)) {
        if (!taken.has(name) && when(s)) { taken.add(name); await rp.screenshot(panel, join(artifacts, `${key}-${name}.png`)); }
      }

      if (done(s)) break;

      if (s.t > limitMs) await writeFile(join(artifacts, `samples-${key}.json`), JSON.stringify(samples, null, 2));

      if (s.t > limitMs) throw new Error(`case ${key} did not finish in ${limitMs} ms; last sample ${JSON.stringify(s)}`);
      await sleep(50);
    }

    await writeFile(join(artifacts, `samples-${key}.json`), JSON.stringify(samples, null, 2));

    return { sentAt, samples, fresh: (s: Sample) => s.checking || s.evidenceBlocks > evidenceBefore };
  }

  const first = (samples: Sample[], pred: (s: Sample) => boolean) => samples.find(pred)?.t ?? null;

  // a) 填错并说已填入；第一次核对扣 3 秒判继续，续做之后第二次核对判完成。
  verdicts.push({ holdMs: 3_000, probe: "VERDICT-CONTINUE" }, { holdMs: 0, probe: "VERDICT-DONE" });
  const checksBeforeA = checks.length;
  const a = await runCase("a", s => s.answers.some(t => t.includes(FIXED)) && s.evidence.some(t => t.includes(NOTE_FIRST)), {
    checking: s => s.checking,
    fix: s => s.fix.length > 0,
    final: s => s.answers.some(t => t.includes(FIXED)),
  });
  const firstCheck = checks[checksBeforeA]!;
  const releaseMs = firstCheck.releasedAt - a.sentAt;
  const caseA = {
    goalCheckReceivedMs: firstCheck.receivedAt - a.sentAt,
    goalCheckReleasedMs: releaseMs,
    claimFirstSeenAnywhereMs: first(a.samples, s => s.claimAnywhere),
    claimEverOutsideProcess: a.samples.some(s => s.claimOutsideProcess),
    firstFeedbackMs: first(a.samples, a.fresh),
    checkingFirstMs: first(a.samples, s => s.checking),
    noteEvidenceFirstMs: first(a.samples, s => s.evidence.includes("草稿现在是：「Note」")),
    fixFirstMs: first(a.samples, s => s.fix.some(t => t.startsWith("核对发现"))),
    fixText: a.samples.at(-1)!.fix,
    finalAnswerMs: a.samples.at(-1)!.t,
    finalEvidence: a.samples.at(-1)!.evidence,
    runChecksAfterFirstRun: a.samples.find(s => s.fix.length > 0)?.runChecks ?? null,
    runChecksAtEnd: a.samples.at(-1)!.runChecks,
    samples: a.samples.length,
  };
  evidence.a = caseA;

  assert.ok(a.samples.filter(s => s.t < releaseMs).every(s => !s.claimAnywhere), `a: the claim never appears in the sidebar before the verdict (${releaseMs} ms); first seen ${caseA.claimFirstSeenAnywhereMs} ms`);
  assert.equal(caseA.claimEverOutsideProcess, false, "a: after the continue verdict the claim is only inside the collapsed process section");
  assert.ok(caseA.checkingFirstMs !== null && caseA.checkingFirstMs < releaseMs, `a: 「正在核对结果」 visible during the hold (${caseA.checkingFirstMs} ms)`);
  assert.ok(caseA.fixFirstMs !== null && caseA.fixFirstMs >= releaseMs, `a: 「核对发现」 visible after the verdict (${caseA.fixFirstMs} ms)`);
  assert.ok(caseA.fixText.some(t => t.includes(CORRECTION)), `a: the fix line carries the checker's correction: ${JSON.stringify(caseA.fixText)}`);
  assert.ok(caseA.noteEvidenceFirstMs !== null, "a: 「草稿现在是：「Note」」 visible");
  assert.ok(caseA.finalEvidence.includes(`草稿现在是：「${NOTE_FIRST}」`), `a: final evidence shows the right sentence: ${JSON.stringify(caseA.finalEvidence)}`);
  // d) R4：只填写、没失败、没说数、没要求保存，第一轮没有「核对」一行。
  assert.deepEqual(caseA.runChecksAfterFirstRun, [], "d: no 「核对」 line for case a's first run");
  assert.deepEqual(caseA.runChecksAtEnd, [], "d: no 「核对」 line after the continuation either");

  // b) 网页在输入时改成大写：读回的是网页里的值。
  const b = await runCase("b", s => s.answers.some(t => t.includes(CASES.b.claim)), { final: s => s.answers.some(t => t.includes(CASES.b.claim)) });
  evidence.b = { evidence: b.samples.at(-1)!.evidence, finalAnswerMs: b.samples.at(-1)!.t };
  assert.ok(b.samples.at(-1)!.evidence.includes("草稿现在是：「HELLO WORLD」"), `b: evidence shows the page's uppercased value: ${JSON.stringify(b.samples.at(-1)!.evidence)}`);

  // e) 填对、核对不另外扣：记首个反馈和最终回答的耗时。
  const checksBeforeE = checks.length;
  const e = await runCase("e", s => s.answers.some(t => t.includes(CASES.e.claim)), { final: s => s.answers.some(t => t.includes(CASES.e.claim)) });
  const checkE = checks[checksBeforeE];
  evidence.e = {
    firstFeedbackMs: first(e.samples, e.fresh),
    checkingFirstMs: first(e.samples, s => s.checking),
    finalAnswerMs: e.samples.at(-1)!.t,
    goalCheckReceivedMs: checkE ? checkE.receivedAt - e.sentAt : null,
    goalCheckReleasedMs: checkE ? checkE.releasedAt - e.sentAt : null,
    unconfirmed: e.samples.at(-1)!.unconfirmed,
    evidence: e.samples.at(-1)!.evidence,
  };
  assert.ok(e.samples.at(-1)!.evidence.includes(`草稿现在是：「${NOTE_FIRST}」`), "e: evidence shows the right sentence");
  assert.equal(e.samples.at(-1)!.unconfirmed, false, "e: a done verdict leaves no 「结果还没确认」 tag");

  // f) 网页留不住输入，核对（脚本）判完成：读回对不上，回答标「结果还没确认」。
  const checksBeforeF = checks.length;
  const f = await runCase("f", s => s.answers.some(t => t.includes(CASES.f.claim)), { final: s => s.answers.some(t => t.includes(CASES.f.claim)) });
  await sleep(500);
  const fEnd = { t: f.samples.at(-1)!.t, ...(await rp.evaluate(panel, SAMPLE_JS(CASES.f.claim)) as Omit<Sample, "t">) };
  evidence.f = { evidence: fEnd.evidence, unconfirmed: fEnd.unconfirmed, verdict: checks[checksBeforeF]?.probe ?? null, finalAnswerMs: f.samples.at(-1)!.t };
  assert.equal(checks[checksBeforeF]?.probe, "VERDICT-DONE", "f: the scripted goal check said done");
  assert.ok(fEnd.evidence.includes("草稿现在是：「」"), `f: evidence shows the empty field: ${JSON.stringify(fEnd.evidence)}`);
  assert.equal(fEnd.unconfirmed, true, "f: answer carries 「结果还没确认」 although the verdict was done");
  await rp.screenshot(panel, join(artifacts, "f-unconfirmed.png"));

  // g) 程序里的填写也走同一个执行器：读回照样到侧栏。
  const g = await runCase("g", s => s.answers.some(t => t.includes(CASES.g.claim)), { final: s => s.answers.some(t => t.includes(CASES.g.claim)) });
  evidence.g = { evidence: g.samples.at(-1)!.evidence, finalAnswerMs: g.samples.at(-1)!.t };
  assert.ok(g.samples.at(-1)!.evidence.includes("草稿现在是：「from program」"), `g: program fill reaches the evidence line: ${JSON.stringify(g.samples.at(-1)!.evidence)}`);

  // R1：助手收到的回执写着网页里的实际内容；对不上时直接写成问题。
  evidence.modelReceipts = [...toolTexts];
  assert.ok(toolTexts.has("Filled #draft. The field now contains: «Note»."), `a: receipt carries the read-back value: ${JSON.stringify([...toolTexts])}`);
  assert.ok([...toolTexts].some(t => t.includes("«HELLO WORLD»") && t.includes("changed spacing or letter case")), "b: receipt says the page reformatted the value");
  assert.ok([...toolTexts].some(t => t.includes("Problem: the field is empty")), "f: receipt states the empty field as a problem");

  // c) 核对扣 10 秒：约 6 秒先放出回答，标「结果还没确认」。
  verdicts.push({ holdMs: 10_000, probe: "VERDICT-DONE" });
  const c = await runCase("c", s => s.answers.some(t => t.includes(CASES.c.claim)) && s.unconfirmed, { released: s => s.answers.some(t => t.includes(CASES.c.claim)) });
  const checkingC = first(c.samples, s => s.checking);
  // 放出的时刻：「正在核对结果」消失的那一次读数；回答随后逐段写出。
  const releasedC = checkingC === null ? null : first(c.samples, s => s.t > checkingC && !s.checking);
  const answerC = first(c.samples, s => s.answers.some(t => t.includes(CASES.c.claim)));
  evidence.c = { checkingFirstMs: checkingC, releasedMs: releasedC, answerFullyVisibleMs: answerC, heldForMs: checkingC !== null && releasedC !== null ? releasedC - checkingC : null, unconfirmed: c.samples.at(-1)!.unconfirmed };
  assert.ok(checkingC !== null && releasedC !== null && answerC !== null, "c: checking line, then release, then answer");
  assert.ok(releasedC! - checkingC! >= 5_000 && releasedC! - checkingC! <= 8_000, `c: answer released 5–8 s after 「正在核对结果」 appeared (${releasedC! - checkingC!} ms)`);
  assert.ok(c.samples.filter(s => s.t < releasedC!).every(s => !s.claimAnywhere), "c: the claim stays hidden until the cap");
  // 迟到的「做完」结论摘掉标签（只记录，不判）。
  await until(async () => checks.length > checksBeforeF + 2 || undefined, 15_000, "late verdict released");
  await sleep(1_000);
  (evidence.c as Record<string, unknown>).tagAfterLateDone = await rp.evaluate(panel, `[...document.querySelectorAll("#messages .msg.assistant[data-delivery-id]")].find(m => m.textContent.includes(${JSON.stringify(CASES.c.claim)}))?.nextElementSibling?.classList.contains("claim-unconfirmed") ?? null`);
  await rp.screenshot(panel, join(artifacts, "c-after-late-verdict.png"));
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  if (panelForDump) await writeFile(join(artifacts, "messages.html"), String(await rp.evaluate(panelForDump, 'document.querySelector("#messages")?.outerHTML ?? ""').catch(() => ""))).catch(() => {});
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", dependency: "isolated real extension/offscreen Agent/sidebar; scripted local model; local proxy holds goal checks; local practice pages", evidence, checks, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  proxy.closeAllConnections();
  proxy.close();
  site.closeAllConnections();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, evidence, error: error?.split("\n")[0] ?? null }, null, 2));

if (error) process.exitCode = 1;
