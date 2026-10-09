/**
 * 改过网页的一轮：侧栏摆出填写后网页里的实际内容，核对判继续时说发现了什么（docs/evals/20261009-claim-after-check.md R1、R3）。
 * 10-10 起回答不再扣到核对出结论，也不标「结果还没确认」（docs/evals/20261010-drop-blocking-labels.md）。只装扩展、隔离构建、本机脚本模型。
 *   npx tsx scripts/acceptance/real-path/claim-after-check.mts --headless
 * 做法：模型地址指向本机转发服务；目标核对请求（系统提示词以核对说明开头）在这里按用例扣住，再换成脚本结论。
 * 每 50 毫秒读一次侧栏，记下什么时候出现了什么。
 *   a) 填错「Note」并说「已填入第一句」，核对扣 3 秒判继续：这句回答在核对结论前就显示；之后有「核对发现」；
 *      读回显示「草稿现在是：「Note」」；续做填对后第二次核对判完成，回答出现。
 *   b) 网页在输入时改成大写：读回显示大写值。
 *   e) 填对、核对马上判完成：读回显示对的句子。
 *   f) 网页把输入清空：读回显示空值。
 *   g) browser_run 程序里的 browser.fill：读回同样显示在侧栏。
 *   h) 填完不写回答，宿主在整轮结束后补交「助手没给出最后的回答就停了…」：补交的回答出现，下一轮开始后仍在。
 *   j) a 续做之后的顺序：「Note」读回 < 「核对发现」 < 第二次读回 < 最终回答（「核对发现」属于第一轮）。
 *   k) 第一次填写读回为空（网页第一次输入清空），模型读页后重填成功：读回显示重填的值。
 *   n) a 的核对结论带给用户的 finding 和带指令的 correction：「核对发现」显示 finding，不含「请」「please」。
 *   o) 判继续的结论没有 finding：「核对发现」写「还差：…」（remaining）。
 *   p) 同一页两栏都叫「地址」：读回显示两行。
 * 失败方式：恢复侧栏扣住回答，a 的回答要等到核对结论之后才出现（反例结果见 docs/evals/20261010-drop-blocking-labels.md）。
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
    : req.url === "/once"
    ? page("第一次留不住的草稿", `<main>${DRAFT}<script>let cleared = false; document.getElementById("draft").addEventListener("input", e => { if (!cleared) { cleared = true; e.target.value = ""; } });</script></main>`)
    : req.url === "/twin"
    ? page("两个地址", `<main><label>地址 <input id="addr1" aria-label="地址"></label><label>地址 <input id="addr2" aria-label="地址"></label><script>document.getElementById("addr1").addEventListener("input", e => { e.target.value = ""; });</script></main>`)
    : req.url === "/strip"
    ? page("留不住的草稿", `<main>${DRAFT}<script>document.getElementById("draft").addEventListener("input", e => { e.target.value = ""; });</script></main>`)
    : page("System One 与草稿", `<main><h1>System One</h1><div style="background:#e8f0ff;border:1px solid #6b8cff;padding:12px"><div><strong>Note</strong></div><p>${NOTE_FIRST} Image input is planned for a later release.</p></div>${DRAFT}</main>`);

  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
});

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const fill = (value: string, target = "#draft") => ({ tool: { name: "fill", args: { target, value } } });

const CASES = {
  a: { ask: "案例A：把蓝色 Note 框里的第一句英文原文复制到下面的草稿框里，不要保存。", claim: "已填入第一句。", path: "/note" },
  b: { ask: "案例B：在草稿框里写 hello world，不要保存。", claim: "草稿已写好 B。", path: "/upper" },
  e: { ask: "案例E：把蓝色 Note 框里的第一句英文复制到草稿框里，不要保存。", claim: "已把第一句填进草稿框 E。", path: "/note" },
  f: { ask: "案例F：在草稿框里写 keep me，不要保存。", claim: "草稿已写好 F。", path: "/strip" },
  g: { ask: "案例G：用一段程序在草稿框里写 from program，不要保存。", claim: "草稿已写好 G。", path: "/note" },
  // h 的回答由宿主补交：模型没写回答，宿主说没给出最后的回答、请用户看页面（conversation-manager 的兜底交付）。
  h: { ask: "案例H：在草稿框里写 late answer，不要保存。", claim: "助手没给出最后的回答就停了。页面上可能已经改了一部分，请看一下。", path: "/note" },
  k: { ask: "案例K：在草稿框里写 second try K，不要保存。", claim: "草稿已写好 K。", path: "/once" },
  o: { ask: "案例O：把蓝色 Note 框里的第一句英文复制到草稿框里，不要保存。", claim: "已填入 O。", path: "/note" },
  p: { ask: "案例P：在两个地址栏分别写 A road 和 B street，不要保存。", claim: "两个地址都写好了 P。", path: "/twin" },
};

const FIXED = "已把第一句英文填入草稿框，没有保存。";

/** 核对写给助手的话：诊断和指令连在一句里（10-09 实测的样子）。侧栏不该显示它。 */
const CORRECTION = "草稿框当前内容是“Note”，不是第一句；请改为只保留第一句：“Jev currently accepts text input only.”，且不要点击保存。Please do not save.";

/** 核对写给用户的一句诊断。 */
const FINDING = "草稿框里现在是“Note”，不是 Note 框里的第一句英文";

const GOAL_CHECK_PREFIX = "You check whether a browser assistant has finished the user's goal";

/** 助手（脚本模型）收到的填写回执原文：R1 要求读回的实际内容和对不上的问题写在里面。 */
const toolTexts = new Set<string>();

const model = await startScriptedModel([
  // 核对判继续后宿主发的续做消息：先看一眼页面（同一栏已有成功回执，产品要求重填前先读页），再填对、回答。
  // 放在最前，续做消息里带着用户原话也先认它。
  { match: "[GOAL CHECK]", steps: [{ tool: { name: "snapshot", args: {} } }, fill(NOTE_FIRST), { text: FIXED }] },
  { match: CASES.a.ask, steps: [fill("Note"), { text: CASES.a.claim }] },
  { match: CASES.b.ask, steps: [fill("hello world"), { text: CASES.b.claim }] },
  { match: CASES.e.ask, steps: [fill(NOTE_FIRST), { text: CASES.e.claim }] },
  { match: CASES.f.ask, steps: [fill("keep me"), { text: CASES.f.claim }] },
  { match: CASES.h.ask, steps: [fill("late answer"), { text: "" }] },
  { match: CASES.g.ask, steps: [{ tool: { name: "browser_run", args: { label: "写草稿", code: 'return await browser.fill({ target: "#draft", value: "from program" });' } } }, { text: CASES.g.claim }] },
  { match: CASES.k.ask, steps: [fill("second try K"), { tool: { name: "snapshot", args: {} } }, fill("second try K"), { text: CASES.k.claim }] },
  { match: CASES.o.ask, steps: [fill("Note O"), { text: CASES.o.claim }] },
  { match: CASES.p.ask, steps: [fill("A road", "#addr1"), fill("B street", "#addr2"), { text: CASES.p.claim }] },
  // 不带 finding 的放前面：脚本模型按包含匹配，「VERDICT-CONTINUE」也包含在它里面。
  { match: "VERDICT-CONTINUE-BARE", steps: [{ text: JSON.stringify({ status: "continue", remaining: "填入第一句", correction: CORRECTION }) }] },
  { match: "VERDICT-CONTINUE", steps: [{ text: JSON.stringify({ status: "continue", remaining: "填入第一句", correction: CORRECTION, finding: FINDING }) }] },
  { match: "VERDICT-DONE", steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
], undefined, payload => {
  for (const m of payload.messages ?? []) {
    const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map(p => p.text ?? "").join("") : "";

    if (m.role === "tool" && text.startsWith("Filled #draft")) toolTexts.add(text);
  }
});

/** 接下来的目标核对依次怎么回：扣多久、什么结论。没排上的马上判完成。 */
const verdicts: Array<{ holdMs: number; probe: "VERDICT-CONTINUE" | "VERDICT-CONTINUE-BARE" | "VERDICT-DONE" }> = [];

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
type Sample = { t: number; claimOutsideProcess: boolean; fix: string[]; evidence: string[]; answers: string[] };

const SAMPLE_JS = (claim: string) => `(() => {
  const m = document.querySelector("#messages");
  const vis = el => el.getClientRects().length > 0;
  const texts = sel => [...m.querySelectorAll(sel)].filter(vis).map(el => el.textContent.trim());
  const outside = m.cloneNode(true);
  outside.querySelectorAll("details.run-steps").forEach(n => n.remove());
  const lastEvidence = [...m.querySelectorAll(".fill-evidence")].filter(vis).at(-1);
  return {
    claimOutsideProcess: outside.textContent.includes(${JSON.stringify(claim)}),
    fix: texts(".claim-fix"),
    evidence: lastEvidence ? [...lastEvidence.querySelectorAll(".fill-evidence-line")].map(el => el.textContent.trim()) : [],
    answers: texts(".msg.assistant[data-delivery-id]"),
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

    return { sentAt, samples };
  }

  const first = (samples: Sample[], pred: (s: Sample) => boolean) => samples.find(pred)?.t ?? null;

  // a) 填错并说已填入；第一次核对扣 3 秒判继续，续做之后第二次核对判完成。
  verdicts.push({ holdMs: 3_000, probe: "VERDICT-CONTINUE" }, { holdMs: 0, probe: "VERDICT-DONE" });
  const checksBeforeA = checks.length;
  const a = await runCase("a", s => s.answers.some(t => t.includes(FIXED)) && s.evidence.some(t => t.includes(NOTE_FIRST)), {
    claim: s => s.claimOutsideProcess,
    fix: s => s.fix.length > 0,
    final: s => s.answers.some(t => t.includes(FIXED)),
  });
  const firstCheck = checks[checksBeforeA]!;
  const releaseMs = firstCheck.releasedAt - a.sentAt;
  const caseA = {
    goalCheckReceivedMs: firstCheck.receivedAt - a.sentAt,
    goalCheckReleasedMs: releaseMs,
    claimFirstShownMs: first(a.samples, s => s.claimOutsideProcess),
    noteEvidenceFirstMs: first(a.samples, s => s.evidence.includes("草稿现在是：「Note」")),
    fixFirstMs: first(a.samples, s => s.fix.some(t => t.startsWith("核对发现"))),
    fixText: a.samples.at(-1)!.fix,
    finalAnswerMs: a.samples.at(-1)!.t,
    finalEvidence: a.samples.at(-1)!.evidence,
    samples: a.samples.length,
  };
  evidence.a = caseA;

  assert.ok(caseA.claimFirstShownMs !== null && caseA.claimFirstShownMs < releaseMs, `a: the answer is shown before the verdict (${releaseMs} ms); first shown ${caseA.claimFirstShownMs} ms`);
  assert.ok(caseA.fixFirstMs !== null && caseA.fixFirstMs >= releaseMs, `a: 「核对发现」 visible after the verdict (${caseA.fixFirstMs} ms)`);
  // n) 显示核对写给用户的 finding，不显示写给助手的 correction。
  assert.ok(caseA.fixText.includes(`核对发现：${FINDING}。正在改…`), `n: the fix line shows the finding: ${JSON.stringify(caseA.fixText)}`);
  assert.ok(caseA.fixText.every(t => !t.includes("请") && !/please/i.test(t)), `n: the fix line has no instruction to the assistant: ${JSON.stringify(caseA.fixText)}`);
  assert.ok(caseA.noteEvidenceFirstMs !== null, "a: 「草稿现在是：「Note」」 visible");
  assert.ok(caseA.finalEvidence.includes(`草稿现在是：「${NOTE_FIRST}」`), `a: final evidence shows the right sentence: ${JSON.stringify(caseA.finalEvidence)}`);

  // j) 续做之后的顺序：「核对发现」属于第一轮，排在续做的过程和读回之前。
  const orderA = await rp.evaluate(panel, `(() => {
    const nodes = [...document.querySelectorAll("#messages > *")];
    const at = pred => nodes.findIndex(pred);
    return {
      noteEvidence: at(n => n.matches(".fill-evidence") && n.textContent.includes("草稿现在是：「Note」")),
      fix: at(n => n.matches(".claim-fix")),
      secondProcess: nodes.findLastIndex(n => n.matches("details.run-steps")),
      secondEvidence: at(n => n.matches(".fill-evidence") && n.textContent.includes(${JSON.stringify(NOTE_FIRST)})),
      finalAnswer: at(n => n.matches(".msg.assistant[data-delivery-id]") && n.textContent.includes(${JSON.stringify(FIXED)})),
      outline: nodes.map(n => n.className.split(" ")[0] + ":" + n.textContent.trim().slice(0, 24)),
    };
  })()`) as { noteEvidence: number; fix: number; secondProcess: number; secondEvidence: number; finalAnswer: number; outline: string[] };
  evidence.j = orderA;
  assert.ok(orderA.noteEvidence >= 0 && orderA.noteEvidence < orderA.fix && orderA.fix < orderA.secondProcess && orderA.secondProcess < orderA.secondEvidence && orderA.secondEvidence < orderA.finalAnswer,
    `j: order 「Note」 evidence < 核对发现 < second process < second evidence < final answer: ${JSON.stringify(orderA)}`);

  // b) 网页在输入时改成大写：读回的是网页里的值。
  const b = await runCase("b", s => s.answers.some(t => t.includes(CASES.b.claim)), { final: s => s.answers.some(t => t.includes(CASES.b.claim)) });
  evidence.b = { evidence: b.samples.at(-1)!.evidence, finalAnswerMs: b.samples.at(-1)!.t };
  assert.ok(b.samples.at(-1)!.evidence.includes("草稿现在是：「HELLO WORLD」"), `b: evidence shows the page's uppercased value: ${JSON.stringify(b.samples.at(-1)!.evidence)}`);

  // e) 填对：读回显示对的句子。
  const e = await runCase("e", s => s.answers.some(t => t.includes(CASES.e.claim)), { final: s => s.answers.some(t => t.includes(CASES.e.claim)) });
  evidence.e = { finalAnswerMs: e.samples.at(-1)!.t, evidence: e.samples.at(-1)!.evidence };
  assert.ok(e.samples.at(-1)!.evidence.includes(`草稿现在是：「${NOTE_FIRST}」`), "e: evidence shows the right sentence");

  // f) 网页留不住输入：读回显示空值。
  const f = await runCase("f", s => s.answers.some(t => t.includes(CASES.f.claim)), { final: s => s.answers.some(t => t.includes(CASES.f.claim)) });
  await sleep(500);
  const fEnd = await rp.evaluate(panel, SAMPLE_JS(CASES.f.claim)) as Omit<Sample, "t">;
  evidence.f = { evidence: fEnd.evidence, finalAnswerMs: f.samples.at(-1)!.t };
  assert.ok(fEnd.evidence.includes("草稿现在是：「」"), `f: evidence shows the empty field: ${JSON.stringify(fEnd.evidence)}`);

  // R1：助手收到的回执写着网页里的实际内容；对不上时直接写成问题。
  evidence.modelReceipts = [...toolTexts];
  assert.ok(toolTexts.has("Filled #draft. The field now contains: «Note»."), `a: receipt carries the read-back value: ${JSON.stringify([...toolTexts])}`);
  assert.ok([...toolTexts].some(t => t.includes("«HELLO WORLD»") && t.includes("changed spacing or letter case")), "b: receipt says the page reformatted the value");
  assert.ok([...toolTexts].some(t => t.includes("Problem: the field is empty")), "f: receipt states the empty field as a problem");

  /** 某条用户消息之后、下一条用户消息之前的回答（不含「收到」），以及它们是否排在下一条用户消息之前。 */
  const turnAnswers = (ask: string) => rp.evaluate(panel, `(() => {
    const users = [...document.querySelectorAll("#messages .msg.user")];
    const user = users.find(u => u.textContent.includes(${JSON.stringify(ask)}));
    if (!user) return [];
    const out = [];
    for (let n = user.nextElementSibling; n && !n.matches(".msg.user"); n = n.nextElementSibling) {
      if (n.matches(".msg.assistant[data-delivery-id]") && n.dataset.deliveryKind !== "ack") out.push(n.textContent.trim());
    }
    return out;
  })()`) as Promise<string[]>;

  // h) 填完不写回答：宿主在整轮结束后补交回答。
  verdicts.push({ holdMs: 1_500, probe: "VERDICT-DONE" });
  const checksBeforeH = checks.length;
  const h = await runCase("h", s => s.answers.some(t => t.includes(CASES.h.claim)), { released: s => s.answers.some(t => t.includes(CASES.h.claim)) }, 20_000);
  const checkH = checks[checksBeforeH];
  evidence.h = {
    answerFirstMs: first(h.samples, s => s.answers.some(t => t.includes(CASES.h.claim))),
    goalCheckReleasedMs: checkH ? checkH.releasedAt - h.sentAt : null,
    answers: await turnAnswers(CASES.h.ask),
  };

  // h 的补交回答在下一轮（g）开始之后仍在。
  const g = await runCase("g", s => s.answers.some(t => t.includes(CASES.g.claim)), { final: s => s.answers.some(t => t.includes(CASES.g.claim)) });
  evidence.g = { evidence: g.samples.at(-1)!.evidence, finalAnswerMs: g.samples.at(-1)!.t };
  assert.ok(g.samples.at(-1)!.evidence.includes("草稿现在是：「from program」"), `g: program fill reaches the evidence line: ${JSON.stringify(g.samples.at(-1)!.evidence)}`);
  const hAfter = await turnAnswers(CASES.h.ask);
  (evidence.h as Record<string, unknown>).answersAfterNextRuns = hAfter;
  assert.ok(hAfter.some(text => text.includes(CASES.h.claim)), `h: the host's late answer survives the next run: ${JSON.stringify(hAfter)}`);

  /** 跑一个用例到回答出现，等 0.5 秒后读侧栏。 */
  async function finalRead(key: "k" | "p") {
    await runCase(key, s => s.answers.some(t => t.includes(CASES[key].claim)), { final: s => s.answers.some(t => t.includes(CASES[key].claim)) }, 30_000);
    await sleep(500);
    const end = await rp.evaluate(panel, SAMPLE_JS(CASES[key].claim)) as Omit<Sample, "t">;
    await rp.screenshot(panel, join(artifacts, `${key}-final.png`));

    return end;
  }

  // k) 第一次读回为空，模型读页后重填成功：读回显示最新一次的值。
  const k = await finalRead("k");
  evidence.k = { evidence: k.evidence, receipts: [...toolTexts].filter(t => t.includes("second try K")) };
  assert.ok(k.evidence.includes("草稿现在是：「second try K」"), `k: the latest readback is the refilled value: ${JSON.stringify(k.evidence)}`);

  // o) 判继续的结论没有 finding：退回「还差：remaining」。续做照 a 的路填对，第二次核对判完成。
  verdicts.push({ holdMs: 0, probe: "VERDICT-CONTINUE-BARE" }, { holdMs: 0, probe: "VERDICT-DONE" });
  const fixedBefore = Number(await rp.evaluate(panel, `[...document.querySelectorAll("#messages .msg.assistant[data-delivery-id]")].filter(m => m.textContent.includes(${JSON.stringify(FIXED)})).length`));
  const o = await runCase("o", s => s.fix.some(t => t.includes("还差")) && s.answers.filter(t => t.includes(FIXED)).length > fixedBefore, {}, 30_000);
  const fixO = o.samples.at(-1)!.fix.filter(t => t.includes("还差"));
  evidence.o = { fix: fixO };
  assert.deepEqual(fixO, ["核对发现：还差：填入第一句。正在改…"], `o: without a finding the fix line says what is still missing: ${JSON.stringify(fixO)}`);

  // p) 两栏同名：第一栏没留住，第二栏一致。两栏各有一行读回，第一栏不被第二栏盖掉。
  const p = await finalRead("p");
  evidence.p = { evidence: p.evidence };
  assert.deepEqual(p.evidence, ["地址现在是：「」", "地址现在是：「B street」"], `p: both same-named fields have their own evidence line: ${JSON.stringify(p.evidence)}`);
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
