/**
 * 这一轮读过一个地址很长的网页（B 站播放器接口那种带签名的长参数）：最后的回答照常交付成回答，不被收进折叠的过程里。
 * 回答的出处有长度规则（地址不超过 500 字、不含空白，标题不超过 160 字）；一条不合规的出处曾让整份回答格式校验失败、
 * 只在控制台留一句「最终正文交付失败」，用户只看到开场白。
 * 只装扩展、隔离构建、本机脚本模型。
 *   npx tsx scripts/acceptance/real-path/long-source-answer.mts --headless
 *   a) 打开一个地址 700 多字的页面后用普通正文作答：回答出现在回答位置（不在过程里）。
 * 失败方式：出处不过滤就整份校验，a 失败（回答只在折叠的过程里）。
 */
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-long-source-answer`);

await mkdir(out, { recursive: true });

const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>播放器接口</title><body><main><p>subtitles: []</p></main></body></html>`));

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
const longUrl = `http://127.0.0.1:${siteAddress(site).port}/x/player/wbi/v2?aid=1&cid=2&dm_img_str=${"V2ViR0wgMS4w".repeat(60)}&w_rid=signed`;

const TASK = "长地址核对：这个视频有没有字幕";
const ANSWER = "这个视频没有字幕：播放器自己的字幕清单是空的。";
const model = await startScriptedModel([{ match: TASK, steps: [{ tool: { name: "navigate", args: { url: longUrl } } }, { text: ANSWER }] }]);

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

try {
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(() => true)`);
  const ready = 'document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")';
  await until(async () => await rp.evaluate(panel, ready), 60_000, "侧栏就绪");
  await rp.click(panel, "#input");
  await rp.typeText(panel, TASK);
  await rp.pressEnter(panel);
  await until(async () => await rp.evaluate(panel, `document.querySelector("#messages").textContent.includes(${JSON.stringify(ANSWER)})`) || undefined, 60_000, "回答文字出现");
  await until(async () => await rp.evaluate(panel, ready), 60_000, "这一轮结束");
  await sleep(2_000);
  const where = await rp.evaluate(panel, `[...document.querySelectorAll("#messages *")].filter(e => e.childElementCount === 0 && e.textContent.includes(${JSON.stringify(ANSWER)})).map(e => e.closest("details.run-steps") ? "过程里" : e.closest(".msg.assistant") ? "回答位置" : "别处")`) as string[];
  await rp.screenshot(panel, join(out, "panel.png"));
  check("a 读过长地址后，最后的回答出现在回答位置", where.includes("回答位置") && !where.includes("过程里"), { where, urlLength: longUrl.length });
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.length > 0 && checks.every(c => c.pass) ? "PASS" : "FAIL", checks }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.close();
}

console.log(`证据：${out}`);

if (checks.length === 0 || checks.some(c => !c.pass)) process.exitCode = 1;
