/**
 * 输入 @ 拉进别的标签页；改页面前先给三行计划，点开始才发，计划那一行随这一轮结束收掉；
 * 每个回答一个主动作，其余在 Ctrl/⌘+Shift+K 动作列表（docs/evals/20261013-uiux-a2-a3-a8.md）。
 *   npx tsx scripts/acceptance/real-path/mention-plan-actions.mts --headless
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-mention-plan-actions`);

await mkdir(out, { recursive: true });

const FORM = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>活动报名表</title><body><h1>活动报名表</h1><p>报名截止到本周五。</p>
<label>姓名 <input id="name"></label><label>城市 <input id="city"></label><button id="submit">提交</button></body></html>`;
const NOTES = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>会议笔记</title><body><h1>会议笔记</h1><p>周五前确认报名名单。</p></body></html>`;
const site = createServer((req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(req.url === "/notes" ? NOTES : FORM));

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const FILL = "把张三填进报名表，不要提交";
const FILLED = "填好了姓名，没有点提交。";
const TABLE = "把这页的报名信息整理成表格";
const model = await startScriptedModel([
  { match: FILL, steps: [{ tool: { name: "fill", args: { target: "#name", value: "张三", label: "姓名" } } }, { text: FILLED }] },
  { match: TABLE, steps: [{ text: "| 项目 | 内容 |\n| --- | --- |\n| 截止 | 本周五 |\n| 需填 | 姓名、城市 |" }] },
]);

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => {
  checks.push({ name, pass, actual });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual));
};

try {
  const port = siteAddress(site).port;
  await rp.cdp.send("Target.createTarget", { url: `http://127.0.0.1:${port}/notes` });
  const work = await rp.attach((await rp.targets()).find((t) => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/` }, work);
  await rp.cdp.send("Page.bringToFront", {}, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, `document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false`), 60_000, "侧栏就绪");
  const key = async (k: string, code: string, vk: number, modifiers = 0) => {
    await rp.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers }, panel);
    await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers }, panel);
  };
  const answers = async () => Number(await rp.evaluate(panel, `document.querySelectorAll("#messages .msg.assistant").length`));

  // (a) 写页任务：先出三行计划，模型没收到请求；点开始才发；这一轮结束后计划那一行收掉。
  const before = model.requests.length;
  await rp.click(panel, "#input");
  await rp.typeText(panel, FILL);
  await rp.pressEnter(panel);
  const plan = await until(async () => {
    const text = await rp.evaluate(panel, `document.querySelector(".task-plan")?.innerText.replace(/\\s+/g, " ") ?? ""`) as string;

    return text ? text : undefined;
  }, 5_000, "出现计划");
  await sleep(800);
  check("改页面前先出会去/会做/不会做，不会做是提交，模型还没收到请求", /会去/.test(plan) && /会做/.test(plan) && /不会做 提交/.test(plan) && model.requests.length === before, { plan, requests: model.requests.length - before });
  await rp.screenshot(panel, join(out, "plan.png"));
  await rp.click(panel, ".task-plan-start");
  await until(async () => (await rp.evaluate(panel, `document.body.innerText.includes(${JSON.stringify(FILLED)})`)) || undefined, 60_000, "填写回答");
  check("点开始后才发出任务", model.requests.length > before, model.requests.length - before);
  const goalLeft = await until(async () => (await rp.evaluate(panel, `!document.querySelector(".task-plan-goal")`)) || undefined, 3_000, "计划那一行收掉").catch(() => false);
  check("这一轮做完后计划那一行收掉", goalLeft === true, await rp.evaluate(panel, `document.querySelector(".task-plan-goal")?.textContent ?? null`));

  // (b) 只读的表格回答：没有计划卡；主动作是「复制为表格」；Ctrl+K 不开动作列表，⌘/Ctrl+Shift+K 开，Esc 关。
  const n = await answers();
  await rp.click(panel, "#input");
  await rp.typeText(panel, TABLE);
  await rp.pressEnter(panel);
  await sleep(600);
  check("只读、同一个站的任务不出计划卡", !(await rp.evaluate(panel, `!!document.querySelector(".task-plan")`)), null);
  await until(async () => (await answers()) > n && (await rp.evaluate(panel, `document.body.innerText.includes("姓名、城市")`)) || undefined, 60_000, "表格回答");
  await sleep(600);
  const primary = await rp.evaluate(panel, `[...document.querySelectorAll("#messages .answer-primary")].at(-1)?.textContent.trim() ?? ""`);
  check("表格回答的主动作是复制为表格", String(primary).replace("↵", "").trim() === "复制为表格", primary);
  await rp.click(panel, "#messages");
  await key("k", "KeyK", 75, 2);
  await sleep(300);
  const ctrlK = await rp.evaluate(panel, `!!document.querySelector("#answer-command-menu:not([hidden])")`);
  const mod = process.platform === "darwin" ? 4 : 2;
  await key("K", "KeyK", 75, mod | 8);
  const list = await until(async () => {
    const t = await rp.evaluate(panel, `document.querySelector("#answer-command-menu:not([hidden])")?.innerText.replace(/\\s+/g, " ") ?? ""`) as string;

    return t ? t : undefined;
  }, 3_000, "动作列表").catch(() => "");
  await rp.screenshot(panel, join(out, "actions.png"));
  await key("Escape", "Escape", 27);
  await sleep(300);
  const closed = await rp.evaluate(panel, `!document.querySelector("#answer-command-menu:not([hidden])")`);
  check("Ctrl+K 不开动作列表；Shift+K 组合键打开，有复制为 Markdown，Esc 关掉", !ctrlK && /复制为 Markdown/.test(list) && closed === true, { ctrlK, list, closed });

  // (c) 输入 @ 列出打开的标签页，当前页排第一；回车后变成页面胶囊，@ 从输入框消失。
  await rp.click(panel, "#input");
  await rp.typeText(panel, "@");
  const menu = await until(async () => {
    const rows = await rp.evaluate(panel, `[...document.querySelectorAll("#tab-mention-menu .tab-mention-item")].map(r => r.innerText.replace(/\\s+/g, " "))`) as string[];

    return rows.length ? rows : undefined;
  }, 5_000, "标签页列表").catch(() => [] as string[]);
  check("@ 列出两个标签页，当前页排第一", menu.length === 2 && menu[0]!.includes("活动报名表") && menu[0]!.includes("当前页") && menu[1]!.includes("会议笔记"), menu);
  await rp.screenshot(panel, join(out, "mention.png"));
  await rp.pressEnter(panel);
  await sleep(500);
  const chip = await rp.evaluate(panel, `({ chip: document.querySelector(".tab-mention-chip")?.innerText.replace(/\\s+/g, " ") ?? "", input: document.querySelector("#input").value })`) as { chip: string; input: string };
  check("回车后输入区出现页面胶囊，@ 从输入框消失", chip.chip.includes("活动报名表") && !chip.input.includes("@"), chip);
} catch (error) {
  check("流程完成", false, String(error));
} finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every((c) => c.pass) ? "PASS" : "FAIL", checks }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.close();
}

console.log(out);

if (!checks.length || checks.some((c) => !c.pass)) process.exitCode = 1;
