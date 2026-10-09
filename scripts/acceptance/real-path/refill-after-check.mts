/**
 * 核对发现填错之后，改正的重填能执行；下拉框按选项 value 填写不被报成问题（docs/evals/20261009-claim-after-check.md）。
 * 只装扩展、隔离构建、本机脚本模型、本机转发服务（扣住并换掉目标核对）、本机练习页。
 *   npx tsx scripts/acceptance/real-path/refill-after-check.mts --headless
 *   1) 填「Note」、核对判继续；续做不读页、直接对同一栏填对的句子：执行（草稿框最终是对的句子），回执里没有「不重复执行」。
 *   2) 填一句、核对判继续；续做直接再填同一句：仍被拒（回执含「不重复执行」）。
 *   3) 点提交按钮、核对判继续；续做直接再点：仍被拒（服务端 POST 计数停在 1）。按钮不叫「发送」：点「发送」会先停下等用户确认（docs/evals/20261009-send-confirm.md），那不是这里要测的。
 *   4) 下拉框 <option value="CN">中国</option> 按 value「CN」填：助手收到的回执没有「Problem」。
 *   5) 网页在输入时把手机号加空格，读回是「不一样」：同一个值的重填执行一次（网页共收到 2 次 input），第三次同值重填被拒（仍是 2 次）。
 *   6) 下拉框一选就被网页换成别的元素，读回读不到：换一个值再选被拒（回执含「不重复执行」）。
 * 失败方式：把 shared/task-next-step.ts 里「改正的重填不算重复」的放行去掉，用例 1 失败；
 * 把同值重填「每栏一次」的上限去掉，用例 5 失败（网页收到 3 次 input）；让读不到的下拉框也放行，用例 6 失败（反例结果见验收文件）。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-refill-after-check`);

await mkdir(artifacts, { recursive: true });

const SENTENCE = "Jev currently accepts text input only.";

const page = (title: string, body: string) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

let posts = 0;

const site = createServer((req, res) => {
  if (req.method === "POST") {
    posts += 1;
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");

    return;
  }

  const body = req.url === "/form"
    ? page("提交", `<main><h1>提交</h1><button id="send" type="button" onclick="fetch('/submit', { method: 'POST' })">提交</button></main>`)
    : req.url === "/mask"
    ? page("手机号", `<main><h1>手机号</h1><input id="phone" aria-label="手机号"><script>
window.inputEvents = 0;
const phone = document.getElementById("phone");
phone.addEventListener("input", () => { window.inputEvents += 1; const d = phone.value.replace(/\\D/g, ""); phone.value = d.replace(/^(\\d{3})(\\d{4})(\\d*)$/, "$1 $2 $3").trim(); });
</script></main>`)
    : req.url === "/vanish"
    ? page("套餐", `<main><h1>套餐</h1><select id="plan" aria-label="套餐"><option value="">请选择</option><option value="basic">基础</option><option value="pro">专业</option></select><script>
const plan = document.getElementById("plan");
plan.addEventListener("change", () => { const replacement = document.createElement("div"); replacement.id = "plan"; replacement.textContent = "已选"; plan.replaceWith(replacement); });
</script></main>`)
    : req.url === "/select"
    ? page("国家", `<main><h1>国家</h1><select id="country" aria-label="国家"><option value="">请选择</option><option value="US">美国</option><option value="CN">中国</option></select></main>`)
    : page("草稿", `<main><h1>System One</h1><div><strong>Note</strong></div><p>${SENTENCE} Image input is planned for a later release.</p><textarea id="draft" rows="4" cols="60" aria-label="草稿"></textarea></main>`);

  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
});

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const fill = (target: string, value: string) => ({ tool: { name: "fill", args: { target, value } } });

const CASES = {
  r1: { ask: "案例R1：把 Note 框里的第一句英文复制到草稿框里，不要保存。", path: "/note", first: "R1 第一轮：已填入。", final: "R1 最终：已改成第一句。" },
  r2: { ask: "案例R2：在草稿框里写第一句英文，不要保存。", path: "/note", first: "R2 第一轮：已填入。", final: "R2 最终：没有重复填写。" },
  r3: { ask: "案例R3：点页面上的提交按钮，只提交一次。", path: "/form", first: "R3 第一轮：已发送。", final: "R3 最终：没有重复发送。" },
  r4: { ask: "案例R4：国家选 CN。", path: "/select", first: "R4：国家已选好。", final: "" },
  r5: { ask: "案例R5：手机号填 13800138000。", path: "/mask", first: "R5 第一轮：已填入。", final: "R5 最终：没有再重复填。" },
  r6: { ask: "案例R6：套餐选基础。", path: "/vanish", first: "R6 第一轮：已选。", final: "R6 最终：没有再选。" },
};

const GOAL_CHECK_PREFIX = "You check whether a browser assistant has finished the user's goal";

const verdictJson = (remaining: string) => JSON.stringify({ status: "continue", remaining, correction: "草稿是「Note」，不是第一句" });

/** 助手（脚本模型）收到的全部工具回执原文。 */
const toolTexts: string[] = [];

const model = await startScriptedModel([
  // 续做消息带着核对结论里的 remaining（MARK-…）；它也带着用户原话，所以放在案例之前先认。
  { match: "MARK-R1", steps: [fill("#draft", SENTENCE), { text: CASES.r1.final }] },
  { match: "MARK-R2", steps: [fill("#draft", SENTENCE), { text: CASES.r2.final }] },
  { match: "MARK-R3", steps: [{ tool: { name: "click", args: { target: "#send" } } }, { text: CASES.r3.final }] },
  { match: "MARK-R5", steps: [fill("#phone", "13800138000"), fill("#phone", "13800138000"), { text: CASES.r5.final }] },
  { match: "MARK-R6", steps: [fill("#plan", "pro"), { text: CASES.r6.final }] },
  { match: CASES.r1.ask, steps: [fill("#draft", "Note"), { text: CASES.r1.first }] },
  { match: CASES.r2.ask, steps: [fill("#draft", SENTENCE), { text: CASES.r2.first }] },
  { match: CASES.r3.ask, steps: [{ tool: { name: "click", args: { target: "#send" } } }, { text: CASES.r3.first }] },
  { match: CASES.r4.ask, steps: [fill("#country", "CN"), { text: CASES.r4.first }] },
  { match: CASES.r5.ask, steps: [fill("#phone", "13800138000"), { text: CASES.r5.first }] },
  { match: CASES.r6.ask, steps: [fill("#plan", "basic"), { text: CASES.r6.first }] },
  { match: "PROBE-R5", steps: [{ text: verdictJson("MARK-R5") }] },
  { match: "PROBE-R6", steps: [{ text: verdictJson("MARK-R6") }] },
  { match: "PROBE-R1", steps: [{ text: verdictJson("MARK-R1") }] },
  { match: "PROBE-R2", steps: [{ text: verdictJson("MARK-R2") }] },
  { match: "PROBE-R3", steps: [{ text: verdictJson("MARK-R3") }] },
  { match: "VERDICT-DONE", steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
], undefined, payload => {
  for (const m of payload.messages ?? []) {
    const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map(p => p.text ?? "").join("") : "";

    if (m.role === "tool" && !toolTexts.includes(text)) toolTexts.push(text);
  }
});

/** 接下来的目标核对依次怎么回；没排上的判完成。 */
const verdicts: string[] = [];

const proxy = createServer(async (req, res) => {
  let body = "";

  for await (const chunk of req) body += String(chunk);
  let forward = body;

  if (req.method === "POST" && body.includes(GOAL_CHECK_PREFIX)) {
    // SAFETY: OpenAI 兼容请求体；只换 messages，保留 stream 等其余字段。
    const payload = JSON.parse(body) as Record<string, unknown>;
    forward = JSON.stringify({ ...payload, messages: [{ role: "user", content: verdicts.shift() ?? "VERDICT-DONE" }] });
  }

  try {
    const upstream = await fetch(`${model.baseUrl.replace(/\/$/, "")}${(req.url ?? "").replace(/^\/v1/, "")}`, { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "POST" ? forward : undefined });
    res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" }).end(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    res.writeHead(502).end();
  }
});

await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));

const rp = await launchRealPath();

let error: string | null = null;

const evidence: Record<string, unknown> = {};

let panelForDump: string | null = null;

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "fixture tab");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  const panel = await rp.attach(await rp.openSidePanel());
  panelForDump = panel;

  const items = {
    inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: `http://127.0.0.1:${siteAddress(proxy).port}/v1` },
    "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" },
  };

  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");

  const settled = () => until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")') || undefined, 60_000, "turn settled", 100);

  /** 发出一条，等 waitFor 的字出现在侧栏，再等这一轮（含续做）停稳。 */
  async function runCase(key: keyof typeof CASES, waitFor: string) {
    const c = CASES[key];
    await settled();
    await rp.cdp.send("Page.navigate", { url: `${origin}${c.path}` }, work);
    await sleep(600);
    await rp.click(panel, "#input");
    await rp.typeText(panel, c.ask);
    await rp.pressEnter(panel);
    await until(async () => await rp.evaluate(panel, `document.querySelector("#messages").textContent.includes(${JSON.stringify(waitFor)})`) || undefined, 60_000, `${key}: ${waitFor}`, 100);
    await settled();
    await sleep(800);
    await rp.screenshot(panel, join(artifacts, `${key}.png`));
  }

  const draft = () => rp.evaluate(work, 'document.getElementById("draft").value') as Promise<string>;

  const REFUSED = "不重复执行";

  // 1) 改正的重填：不读页，直接对同一栏填对的句子。
  verdicts.push("PROBE-R1");
  await runCase("r1", CASES.r1.final);
  const draft1 = await draft();
  const fills1 = toolTexts.filter(t => t.startsWith("Filled #draft"));
  evidence.r1 = { draft: draft1, fillReceipts: fills1, refused: toolTexts.filter(t => t.includes(REFUSED)) };
  assert.equal(draft1, SENTENCE, `1: the corrected fill ran; textarea is ${JSON.stringify(draft1)}`);
  assert.ok(!toolTexts.some(t => t.includes(REFUSED)), `1: no 「${REFUSED}」 in any tool result: ${JSON.stringify(toolTexts)}`);
  assert.ok(fills1.some(t => t.includes(`«${SENTENCE}»`)), `1: the model saw the right sentence read back: ${JSON.stringify(fills1)}`);

  // 2) 同一句重填：仍被拒。
  const before2 = toolTexts.length;
  verdicts.push("PROBE-R2");
  await runCase("r2", CASES.r2.final);
  const after2 = toolTexts.slice(before2);
  evidence.r2 = { draft: await draft(), toolTexts: after2 };
  assert.ok(after2.some(t => t.includes(REFUSED)), `2: the same-value refill was refused: ${JSON.stringify(after2)}`);
  assert.equal(await draft(), SENTENCE, "2: textarea unchanged");

  // 3) 点击不放行：同一按钮再点仍被拒，服务端只收到一次。
  const before3 = toolTexts.length;
  verdicts.push("PROBE-R3");
  await runCase("r3", CASES.r3.final);
  const after3 = toolTexts.slice(before3);
  evidence.r3 = { posts, toolTexts: after3 };
  assert.ok(after3.some(t => t.includes(REFUSED)), `3: the repeated click was refused: ${JSON.stringify(after3)}`);
  assert.equal(posts, 1, "3: the server received exactly one POST");

  // 4) 下拉框按 value 填：回执没有问题。
  const before4 = toolTexts.length;
  await runCase("r4", CASES.r4.first);
  const after4 = toolTexts.slice(before4);
  const selected = await rp.evaluate(work, 'document.getElementById("country").value');
  evidence.r4 = { selected, toolTexts: after4 };
  assert.equal(selected, "CN", "4: the select holds CN");
  assert.ok(after4.some(t => t.startsWith("Filled #country")), `4: the fill returned a receipt: ${JSON.stringify(after4)}`);
  assert.ok(!after4.some(t => t.includes("Problem")), `4: no mismatch problem in the select receipt: ${JSON.stringify(after4)}`);

  // 5) 网页给手机号加空格，读回「不一样」：同值重填执行一次，再重填被拒。
  const before5 = toolTexts.length;
  verdicts.push("PROBE-R5");
  await runCase("r5", CASES.r5.final);
  const after5 = toolTexts.slice(before5);
  const inputs5 = await rp.evaluate(work, "window.inputEvents");
  evidence.r5 = { inputs: inputs5, phone: await rp.evaluate(work, 'document.getElementById("phone").value'), toolTexts: after5 };
  assert.equal(inputs5, 2, `5: the page saw 2 input events (first fill + one refill; the third attempt refused): ${JSON.stringify(after5)}`);
  assert.ok(after5.some(t => t.includes(REFUSED)), `5: the second same-value refill was refused: ${JSON.stringify(after5)}`);

  // 6) 下拉框被网页换掉、读回读不到：换值重选被拒。
  const before6 = toolTexts.length;
  verdicts.push("PROBE-R6");
  await runCase("r6", CASES.r6.final);
  const after6 = toolTexts.slice(before6);
  evidence.r6 = { toolTexts: after6 };
  assert.ok(after6.some(t => t.includes(REFUSED)), `6: the different-value select refill was refused: ${JSON.stringify(after6)}`);
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  if (panelForDump) await writeFile(join(artifacts, "messages.html"), String(await rp.evaluate(panelForDump, 'document.querySelector("#messages")?.outerHTML ?? ""').catch(() => ""))).catch(() => {});
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", dependency: "isolated real extension/offscreen Agent/sidebar; scripted local model; local proxy swaps goal checks; local practice pages", evidence, allToolTexts: toolTexts, error }, null, 2));
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
