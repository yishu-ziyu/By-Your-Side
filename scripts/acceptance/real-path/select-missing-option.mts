/**
 * 真扩展 + 隔离 Chrome + 脚本模型：在下拉框里选一个不存在的选项。
 * 判定：模型拿到的是「下拉框没有匹配选项」和可选项，而不是一句看不懂的脚本错误；网页上原来选中的值不变。
 * 失败方式：页面里抛出的错误被 executeScript 换成空结果，工具崩成 “Cannot read properties of undefined”；或先清空了原选中项。
 *   npx tsx scripts/acceptance/real-path/select-missing-option.mts --headless
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until, type Json } from "./harness.mts";
import { startScriptedModel, type TextStep } from "./scripted-model.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-select-missing-option`);
await mkdir(out, { recursive: true });
const TASK = "把城市选成火星";
const textOf = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value) ? value.map(part => typeof part?.text === "string" ? part.text : "").join("") : "";
const reply: TextStep = { text: "等待工具结果" };
const model = await startScriptedModel([{ match: TASK, steps: [{ tool: { name: "select_option", args: { target: "loc=css:#city", values: ["火星"] } } }, reply] }], undefined, payload => {
  const result = [...(payload.messages ?? [])].reverse().find(message => message.role === "tool");
  if (result) reply.text = `工具实际返回：${textOf(result.content)}。本次记录结束。`;
});
const site = createServer((_q, r) => r.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end('<!doctype html><meta charset=utf-8><title>收货信息</title><h1>收货信息</h1><label>城市 <select id="city"><option>北京</option><option selected>上海</option><option>广州</option></select></label>'));
await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };
try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(()=>true)`);
  await until(() => rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false'), 60000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);
  await rp.click(panel, "#input"); await rp.typeText(panel, TASK); await rp.pressEnter(panel);
  await until(() => rp.evaluate(panel, 'document.querySelector("#messages")?.textContent.includes("本次记录结束")'), 45000, "侧栏交付");
  const text = String(await rp.evaluate(panel, '[...document.querySelectorAll(".msg.assistant")].map(m=>m.textContent).join("\\n")'));
  check("模型拿到没有这个选项和可选项", text.includes("下拉框没有匹配选项") && text.includes("北京 / 上海 / 广州") && !text.includes("Cannot read properties"), text.slice(0, 400));
  check("原来选中的值不变", await rp.evaluate(work, 'document.querySelector("#city").value') === "上海", await rp.evaluate(work, 'document.querySelector("#city").value') as Json);
  await rp.screenshot(panel, join(out, "panel.png"));
} catch (error) { check("流程完成", false, String(error)); }
finally { await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.length && checks.every(c => c.pass) ? "PASS" : "FAIL", checks }, null, 2)); await rp.close(); await rp.remove(); await model.close(); site.close(); }
console.log(`证据：${out}`);
if (!checks.length || checks.some(c => !c.pass)) process.exitCode = 1;
