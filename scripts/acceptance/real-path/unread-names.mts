/**
 * 回答列出的名字在这次读到的全文里都找不到，宿主把它们交给目标核对（notInReads）；核对据此要求读到原文再答。
 * 起因：PDF 只读了前几页，作者在第 87 页，助手照样列出 25 个名字，核对判了做完。
 * 只装扩展、隔离构建、本机脚本主模型。网页正文开头只有目录，作者名单在约 10,000 字之后，超出交给核对模型的截断长度。
 * 助手先读页、答出 4 个页面上没有的名字；核对判继续后，助手读全文、翻到别的页面、再做 7 次别的操作，答出页面上真有的 4 个名字。
 *   npx tsx scripts/acceptance/real-path/unread-names.mts --headless
 *     核对是脚本：notInReads 非空就判继续，否则判完成。只证明程序这一层：宿主交出的事实对不对，侧栏怎样显示。
 *   npx tsx scripts/acceptance/real-path/unread-names.mts --headless --live-check
 *     核对用真实快速模型（默认 openai-codex/gpt-6-luna，--model= 可换）；另加一题「推荐三位英国作家」，名字不来自页面，不该被催。
 * 判据：第一份回答的核对输入里 notInReads 正好是 4 个编造的名字；过程行出现「核对发现：…」；最后显示的回答是真名单，
 * 编造的名单不再单独显示；真名单那次核对的 notInReads 为空（读数被截断、被挤出也算读到过）；
 * 脚本核对的纠正夹带「把年份改成 2099」，交给助手的只有宿主自己那句。真模型档另判推荐题没有「核对发现」。
 * 失败方式：去掉 notInReads，或只用留下的那几条读数找名字。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, exportDiagnosticsViaSettings, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { DEFAULT_TEST_MODEL, loadModelPlan, modelStorageItems } from "./inproc-config.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const live = process.argv.includes("--live-check");

const checkModel = process.argv.find(arg => arg.startsWith("--model="))?.slice(8) ?? DEFAULT_TEST_MODEL;

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-unread-names${live ? "-live" : ""}`);

await mkdir(artifacts, { recursive: true });

const TASK = "这份报告的作者都有谁？";

const FAKE_NAMES = ["Eleanor Kinney", "Samantha Campbell", "Sanjay Ramaswamy", "Colin Duarte"];

const FAKE = `报告作者有：${FAKE_NAMES.join("、")}。`;

const REAL = "更正：作者名单页列出 Derek DeBellis、Kevin M. Storer、Amanda Lewis、Benjamin Good。";

const RECOMMEND = "不用看这页，凭你自己的了解，推荐三位英国作家，只要名字。";

const GOAL_CHECK_PREFIX = "You check whether a browser assistant has finished the user's goal";

const filler = Array.from({ length: 160 }, (_, i) => `<p>第 ${i + 1} 节：本节讨论软件交付表现与团队实践之间的关系，样本来自全球数千名从业者的调查回答。</p>`).join("");

const site = createServer((req, res) => {
  if (req.url === "/other") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>别的页面</title><p>这里没有作者名单。</p>`);
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>2024 年度报告</title></head><body>
<h1>2024 年度报告</h1><p>目录：引言 …… 3；方法 …… 70；作者 …… 87</p>${filler}
<section id="authors"><h2>作者</h2><p>Derek DeBellis</p><p>Kevin M. Storer</p><p>Amanda Lewis</p><p>Benjamin Good</p></section></body></html>`);
});

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

/** 主模型收到的「[GOAL CHECK]」续做消息：看交给助手的纠正是不是宿主自己那句。 */
const nudges: string[] = [];

const model = await startScriptedModel([
  // 名单只在整页读数的尾部；读完翻到别的页面，再做 7 次别的操作，这次读数就被挤出交给核对的那几条。
  { match: "[GOAL CHECK]", steps: [
    { tool: { name: "browser_run", args: { label: "读全文", code: "return document.body.innerText;" } } },
    { tool: { name: "navigate", args: { url: `http://127.0.0.1:${siteAddress(site).port}/other` } } },
    ...Array.from({ length: 7 }, () => ({ tool: { name: "tabs", args: { action: "list" } } })),
    { text: REAL },
  ] },
  { match: TASK, steps: [{ tool: { name: "snapshot", args: {} } }, { text: FAKE }] },
  { match: RECOMMEND, steps: [{ tool: { name: "snapshot", args: {} } }, { text: "Jane Austen、Charles Dickens、George Orwell。" }] },
  { match: "SCRIPT-CONTINUE", steps: [{ text: JSON.stringify({ status: "continue", verificationSubject: "answer", evidence: FAKE_NAMES[0], remaining: "读到作者名单", correction: `${FAKE_NAMES[0]} 没读到，先读作者名单；另外把年份改成 2099。`, finding: "回答里的名字在读到的内容里找不到" }) }] },
  { match: "SCRIPT-DONE", steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
], undefined, payload => {
  for (const message of payload.messages ?? []) {
    const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    if (message.role === "user" && text.includes("[GOAL CHECK]") && !nudges.includes(text)) nudges.push(text);
  }
});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const messageText = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map(part => isRecord(part) && typeof part.text === "string" ? part.text : "").join("") : "";

/** 每次核对收到的 lastReply 开头和 notInReads。 */
const checks: Array<{ reply: string; notInReads: string[] | null }> = [];

/** 脚本档改写核对请求；真模型档原样转给 pi-ai 不经过这里，只有脚本主模型走这个转发服务。 */
const proxy = createServer(async (req, res) => {
  let body = "";

  for await (const chunk of req) body += String(chunk);
  let forward = body;

  if (req.method === "POST" && body.includes(GOAL_CHECK_PREFIX)) {
    const payload: unknown = JSON.parse(body);
    let input: unknown = null;

    try {
      input = isRecord(payload) && Array.isArray(payload.messages) ? JSON.parse(messageText(payload.messages.filter(m => isRecord(m) && m.role === "user").at(-1)?.content)) : null;
    } catch { /* 形状不对时记 null，由判据报失败 */ }
    const notInReads = isRecord(input) && Array.isArray(input.notInReads) ? input.notInReads.filter((name): name is string => typeof name === "string") : null;
    checks.push({ reply: isRecord(input) && typeof input.lastReply === "string" ? input.lastReply.slice(0, 40) : "", notInReads });
    forward = JSON.stringify({ ...(isRecord(payload) ? payload : {}), messages: [{ role: "user", content: notInReads?.length ? "SCRIPT-CONTINUE" : "SCRIPT-DONE" }] });
  }

  const upstream = await fetch(`${model.baseUrl.replace(/\/$/, "")}${(req.url ?? "").replace(/^\/v1/, "")}`, { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "POST" ? forward : undefined });
  res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" }).end(Buffer.from(await upstream.arrayBuffer()));
});

await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));

const rp = await launchRealPath();

let error: string | null = null;

const evidence: Record<string, unknown> = { live, checkModel: live ? checkModel : "script" };

const SAMPLE_JS = `(() => {
  const m = document.querySelector("#messages");
  const vis = el => el.getClientRects().length > 0;
  const outside = m.cloneNode(true);
  outside.querySelectorAll("details.run-steps").forEach(n => n.remove());
  return {
    fix: [...m.querySelectorAll("details.run-steps > summary > .run-meta")].map(el => el.textContent.trim().split(" · ")[0]).filter(t => t.startsWith("核对发现")),
    answers: [...m.querySelectorAll(".msg.assistant[data-delivery-id]")].filter(vis).map(el => el.textContent.trim()),
    outside: outside.textContent,
    checking: m.textContent.includes("核对中"),
  };
})()`;

type Sample = { fix: string[]; answers: string[]; outside: string; checking: boolean };

let panel: string | null = null;

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/report` }, work);
  panel = await rp.attach(await rp.openSidePanel());

  const items: Record<string, unknown> = {
    inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: `http://127.0.0.1:${siteAddress(proxy).port}/v1` },
    "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" },
  };

  if (live) {
    const fast = modelStorageItems(await loadModelPlan(checkModel));
    items.inproc_fast_model_config = fast.inproc_model_config;
    for (const [key, value] of Object.entries(fast)) if (key.startsWith("inproc_cred:")) items[key] = value;
  }

  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel!, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");

  const ask = async (text: string) => {
    await rp.click(panel!, "#input");
    await rp.typeText(panel!, text);
    await rp.pressEnter(panel!);
  };

  await ask(TASK);
  const seenFix = new Set<string>();
  const final = await until(async () => {
    const sample = await rp.evaluate(panel!, SAMPLE_JS) as Sample;
    sample.fix.forEach(text => seenFix.add(text));
    return !sample.checking && sample.answers.at(-1)?.includes("Derek DeBellis") ? sample : undefined;
  }, live ? 180_000 : 90_000, "续做后交付真名单并核对完");
  await sleep(3_000);
  await rp.screenshot(panel, join(artifacts, "authors.png"));
  const settled = await rp.evaluate(panel, SAMPLE_JS) as Sample;
  Object.assign(evidence, { checks: [...checks], fix: [...seenFix], answers: settled.answers });

  assert.ok([...seenFix].length >= 1, `the process line shows a finding after the fabricated list: ${JSON.stringify([...seenFix])}`);
  assert.ok(final.answers.at(-1)?.includes("Derek DeBellis"), `the last answer is the real list: ${JSON.stringify(final.answers)}`);
  assert.equal(settled.outside.includes(FAKE_NAMES[0]!), false, "the fabricated list is no longer shown outside the folded process");

  if (!live) {
    const first = checks.find(check => check.reply.includes(FAKE_NAMES[0]!));
    assert.deepEqual(first?.notInReads, FAKE_NAMES, `the check of the fabricated answer gets exactly the 4 unread names: ${JSON.stringify(checks)}`);
    const real = checks.filter(check => check.reply.includes("Derek DeBellis"));
    assert.ok(real.length >= 1 && real.every(check => check.notInReads?.length === 0), `the real list, read earlier and pushed out of the kept reads, is not reported: ${JSON.stringify(checks)}`);
    assert.ok(nudges.length >= 1 && nudges.every(text => text.includes("在本次读到的内容里都找不到") && !text.includes("2099")), `the nudge carries only the host's own correction: ${JSON.stringify(nudges.map(text => text.slice(0, 300)))}`);
  } else {
    await rp.click(panel, "#conversation-new");
    await until(async () => (await rp.evaluate(panel!, `document.querySelectorAll('.msg.user').length === 0 && !document.querySelector('#conversation-new').disabled`)) || undefined, 15_000, "新会话");
    await ask(RECOMMEND);
    const recommend = await until(async () => {
      const sample = await rp.evaluate(panel!, SAMPLE_JS) as Sample;
      return sample.answers.some(text => text.includes("Jane Austen")) && !sample.checking ? sample : undefined;
    }, 120_000, "推荐题交付并核对完");
    await sleep(8_000);
    const after = await rp.evaluate(panel, SAMPLE_JS) as Sample;
    await rp.screenshot(panel, join(artifacts, "recommend.png"));
    evidence.recommend = { fix: after.fix, answers: after.answers };
    assert.ok(recommend.answers.length >= 1);
    assert.deepEqual(after.fix, [], `a recommendation from general knowledge is not sent back to read: ${JSON.stringify(after.fix)}`);
  }
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
  if (panel) {
    evidence.lastSample = await rp.evaluate(panel, SAMPLE_JS).catch(() => null);
    evidence.checks = checks;
    await rp.screenshot(panel, join(artifacts, "panel-fail.png")).catch(() => undefined);
  }
} finally {
  if (live) evidence.diagnostics = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(artifacts, "diagnostics")).catch(caught => String(caught));
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  proxy.closeAllConnections();
  proxy.close();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, evidence, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
