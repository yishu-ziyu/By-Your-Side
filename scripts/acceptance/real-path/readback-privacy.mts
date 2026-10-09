/**
 * 填写后的读回不能带出隐私（docs/evals/20261009-claim-after-check.md R1）。只装扩展、隔离构建、本机脚本模型、本机练习页。
 *   npx tsx scripts/acceptance/real-path/readback-privacy.mts --headless
 *   1) 普通文本框：侧栏显示读回的值；助手收到它；诊断记录导出里没有它。
 *   2) 标签「验证码」、name=otp、没有 autocomplete 的栏：侧栏、助手收到的回执、导出里都没有值。
 *   3) 密码栏先填一次，再点「显示密码」变成 type=text，换个标签叫「输入」再填：同上（靠「曾经是 password」的标记）。
 *   4) 同一类栏换个说法：type=text、name=password，没有任何先前读取：同上（靠字段名）。
 *   5) 标签中性、只有字段名 card_number、id cardNumber、name sms_code 的 input，和标签「身份证」的 textarea：同上（下划线、驼峰、多词、textarea）。
 *   6) 反例：name=shipping_address 的普通栏，侧栏和助手看得到值，导出里没有（不能把普通栏一起遮掉）。
 * 失败方式：去掉 shared/trace-sanitize.ts 里对读回值的遮挡，1 的导出检查失败；去掉 input.ts 的字段名判断，2 和 4 失败；
 * 把 SENSITIVE_FIELD_NAME 换回旧版正则（没有拆分下划线和驼峰的整词匹配），5 的 card_number 失败。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, exportDiagnosticsViaSettings, launchRealPath, requireHeadless, siteAddress, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-readback-privacy`);

await mkdir(artifacts, { recursive: true });

const MARK = { normal: "ZQMARK-normal-7431", otp: "ZQMARK-otp-5528", toggled: "ZQMARK-toggled-9042", named: "ZQMARK-named-1865", card: "ZQMARK-card-3317", camel: "ZQMARK-camel-6620", sms: "ZQMARK-sms-8841", idnote: "ZQMARK-idnote-2275", ship: "ZQMARK-ship-4096" };

const site = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>隐私读回练习页</title></head><body><main>
<h2>练习</h2>
<label>草稿 <textarea id="draft" rows="3" cols="40"></textarea></label><br>
<label>验证码 <input id="code" name="otp" type="text"></label><br>
<label>登录凭证 <input id="pw" type="password"></label> <button id="show" onclick="document.getElementById('pw').type='text';document.getElementById('pw').setAttribute('aria-label','输入');">显示密码</button><br>
<label>登录 <input id="acct" name="password" type="text"></label><br>
<label>字段甲 <input id="card" name="card_number" type="text"></label><br>
<label>字段乙 <input id="cardNumber" type="text"></label><br>
<label>字段丙 <input id="sms" name="sms_code" type="text"></label><br>
<label>身份证 <textarea id="idnote" rows="2" cols="40"></textarea></label><br>
<label>字段丁 <input id="ship" name="shipping_address" type="text"></label>
</main></body></html>`);
});

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const origin = `http://127.0.0.1:${siteAddress(site).port}/`;

const fill = (target: string, value: string) => ({ tool: { name: "fill", args: { target, value } } });

const ASK = { normal: "隐私案例一：在草稿框里写一句话。", otp: "隐私案例二：在验证码框里写一串字。", toggled: "隐私案例三：先在登录凭证框里写 warmup，再点显示密码，再在输入框里写一串字。", named: "隐私案例四：在登录框里写一串字。", card: "隐私案例五：在字段甲里写一串字。", camel: "隐私案例六：在字段乙里写一串字。", sms: "隐私案例七：在字段丙里写一串字。", idnote: "隐私案例八：在身份证框里写一串字。", ship: "隐私案例九：在字段丁里写一串字。" };

const DONE = { normal: "草稿写好了一。", otp: "验证码框写好了二。", toggled: "凭证框写好了三。", named: "登录框写好了四。", card: "字段甲写好了五。", camel: "字段乙写好了六。", sms: "字段丙写好了七。", idnote: "身份证框写好了八。", ship: "字段丁写好了九。" };

/** 助手（脚本模型）收到的 fill 回执原文。 */
const toolTexts: string[] = [];

const model = await startScriptedModel([
  { match: ASK.normal, steps: [fill("#draft", MARK.normal), { text: DONE.normal }] },
  { match: ASK.otp, steps: [fill("#code", MARK.otp), { text: DONE.otp }] },
  { match: ASK.toggled, steps: [fill("#pw", "warmup"), { tool: { name: "click", args: { target: "#show" } } }, { tool: { name: "snapshot", args: {} } }, fill("#pw", MARK.toggled), { text: DONE.toggled }] },
  { match: ASK.named, steps: [fill("#acct", MARK.named), { text: DONE.named }] },
  { match: ASK.card, steps: [fill("#card", MARK.card), { text: DONE.card }] },
  { match: ASK.camel, steps: [fill("#cardNumber", MARK.camel), { text: DONE.camel }] },
  { match: ASK.sms, steps: [fill("#sms", MARK.sms), { text: DONE.sms }] },
  { match: ASK.idnote, steps: [fill("#idnote", MARK.idnote), { text: DONE.idnote }] },
  { match: ASK.ship, steps: [fill("#ship", MARK.ship), { text: DONE.ship }] },
], undefined, payload => {
  for (const m of payload.messages ?? []) {
    const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map(p => p.text ?? "").join("") : "";

    if (m.role === "tool" && text.startsWith("Filled") && !toolTexts.includes(text)) toolTexts.push(text);
  }
});

const rp = await launchRealPath();

let error: string | null = null;

const evidence: Record<string, unknown> = {};

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "fixture tab");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  const panel = await rp.attach(await rp.openSidePanel());

  const items = {
    inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: `${model.baseUrl}` },
    "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" },
  };

  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");

  const messages = async () => String(await rp.evaluate(panel, 'document.querySelector("#messages")?.textContent ?? ""'));

  /** 发一个案例，等回答出现，返回侧栏全文。 */
  async function run(key: keyof typeof ASK): Promise<string> {
    await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")') || undefined, 60_000, "previous turn settled", 100);
    await rp.cdp.send("Page.navigate", { url: origin }, work);
    await until(async () => await rp.evaluate(work, 'document.readyState==="complete"') || undefined, 10_000, "page loaded");
    await rp.click(panel, "#input");
    await rp.typeText(panel, ASK[key]);
    await rp.pressEnter(panel);
    await until(async () => (await messages()).includes(DONE[key]) || undefined, 60_000, `case ${key} answer`, 100);
    await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")') || undefined, 60_000, `case ${key} settled`, 100);
    const text = await messages();
    await rp.screenshot(panel, join(artifacts, `${key}.png`));

    return text;
  }

  const sidebar = { normal: await run("normal"), otp: await run("otp"), toggled: await run("toggled"), named: await run("named"), card: await run("card"), camel: await run("camel"), sms: await run("sms"), idnote: await run("idnote"), ship: await run("ship") };
  const { traces } = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(artifacts, "downloads"));
  await writeFile(join(artifacts, "export.jsonl"), traces);
  const receipts = (mark: string) => toolTexts.filter(t => t.includes(mark));

  evidence.toolTexts = toolTexts;
  evidence.exportChars = traces.length;
  assert.ok(traces.includes('"readback"'), "export carries the readback entries (so the absence checks below are not vacuous)");

  // 1) 普通栏：侧栏和助手看得到，导出里没有。
  assert.ok(sidebar.normal.includes(MARK.normal), "1: sidebar shows the read-back value");
  assert.ok(receipts(MARK.normal).length > 0, `1: the model receipt carries the value: ${JSON.stringify(toolTexts)}`);
  assert.ok(!traces.includes(MARK.normal), "1: the diagnostic export does not contain the value");

  // 2、3、4、5) 敏感栏：哪里都没有；助手被告知没有读回。
  const sensitiveKeys = ["otp", "toggled", "named", "card", "camel", "sms", "idnote"] as const;

  for (const key of sensitiveKeys) {
    assert.ok(!sidebar[key].includes(MARK[key]), `${key}: sidebar does not show the value`);
    assert.equal(receipts(MARK[key]).length, 0, `${key}: no model receipt carries the value`);
    assert.ok(!traces.includes(MARK[key]), `${key}: the diagnostic export does not contain the value`);
  }

  // 6) 反例：shipping_address 是普通栏，值照常显示。
  assert.ok(sidebar.ship.includes(MARK.ship), "6: sidebar shows the shipping_address value");
  assert.ok(receipts(MARK.ship).length > 0, `6: the model receipt carries the shipping_address value: ${JSON.stringify(toolTexts)}`);
  assert.ok(!traces.includes(MARK.ship), "6: the diagnostic export does not contain the value");

  assert.ok(toolTexts.filter(t => t.includes("value was not read back")).length >= sensitiveKeys.length, `sensitive receipts say the value was not read back: ${JSON.stringify(toolTexts)}`);
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", dependency: "isolated real extension/offscreen Agent/sidebar; scripted local model; local practice page", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.closeAllConnections();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, error: error?.split("\n")[0] ?? null }, null, 2));

if (error) process.exitCode = 1;
