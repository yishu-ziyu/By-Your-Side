/**
 * 输入 @ 拉进别的标签页；改页面时任务条上放一行计划，随这一轮结束收掉；
 * 每个回答一个主动作，其余在 Ctrl/⌘+Shift+K 动作列表（docs/evals/20261013-uiux-a2-a3-a8.md）。
 * 改页面的任务不等确认就开始，计划行的「不会做」不和用户的授权打架；任务运行中 @ 的页面模型读得到。
 *   npx tsx scripts/acceptance/real-path/mention-plan-actions.mts --headless
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, recordScreen, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
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
const SUBMIT = "把张三填进报名表并提交";
const SLOW = "慢慢介绍一下这个活动";
const STEER = "顺便核对一下我 @ 的笔记";
// 只有笔记页的正文进了模型的请求，脚本模型才会写这一句。
const NOTES_SEEN = "笔记要求周五前确认名单。";
const model = await startScriptedModel([
  { match: "周五前确认报名名单", steps: [{ text: NOTES_SEEN }] },
  { match: SLOW, steps: [{ text: Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 段：这个活动报名截止到本周五。`).join("\n\n"), chunkDelayMs: 300 }] },
  { match: FILL, steps: [{ tool: { name: "fill", args: { target: "#name", value: "张三", label: "姓名" } } }, { text: FILLED }] },
  { match: TABLE, steps: [{ text: "| 项目 | 内容 |\n| --- | --- |\n| 截止 | 本周五 |\n| 需填 | 姓名、城市 |" }] },
]);

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
let stopRecording: (() => Promise<string | null>) | null = null;
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
  stopRecording = await recordScreen(rp.cdp, panel, join(out, "run.mp4"));
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, `document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false`), 60_000, "侧栏就绪");
  const key = async (k: string, code: string, vk: number, modifiers = 0) => {
    await rp.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers }, panel);
    await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers }, panel);
  };
  const answers = async () => Number(await rp.evaluate(panel, `document.querySelectorAll("#messages .msg.assistant").length`));

  // (a) 写页任务：不停下来等确认，模型马上收到请求；任务条上放一行「会去 … · 不会做 …」；这一轮结束后收掉。
  const goalLine = async () => await rp.evaluate(panel, `document.querySelector(".task-plan-goal")?.textContent ?? ""`) as string;
  const before = model.requests.length;
  await rp.click(panel, "#input");
  await rp.typeText(panel, FILL);
  await rp.pressEnter(panel);
  const plan = await until(async () => (await goalLine()) || undefined, 5_000, "出现计划行").catch(() => "");
  const started = await until(async () => model.requests.length > before || undefined, 5_000, "模型收到请求").catch(() => false);
  await rp.screenshot(panel, join(out, "plan.png"));
  check("写页任务不等确认就发出，任务条上有会去/不会做，不会做是提交、付款", started === true && /会去 活动报名表/.test(plan) && /不会做 提交、付款/.test(plan), { plan, started });
  await until(async () => (await rp.evaluate(panel, `document.body.innerText.includes(${JSON.stringify(FILLED)})`)) || undefined, 60_000, "填写回答");
  const goalLeft = await until(async () => !(await goalLine()) || undefined, 3_000, "计划行收掉").catch(() => false);
  check("这一轮做完后计划行收掉", goalLeft === true, await goalLine());

  // (d) 用户明说「并提交」：计划行不能写「不会做 提交」。
  const beforeSubmit = model.requests.length;
  await rp.click(panel, "#input");
  await rp.typeText(panel, SUBMIT);
  await rp.pressEnter(panel);
  const submitPlan = await until(async () => (await goalLine()) || undefined, 5_000, "提交任务的计划行").catch(() => "");
  await rp.screenshot(panel, join(out, "plan-submit.png"));
  check("用户说了提交，计划行的不会做只剩付款", /不会做 付款$/.test(submitPlan), submitPlan);
  await until(async () => (model.requests.length > beforeSubmit && !(await goalLine())) || undefined, 60_000, "提交任务结束").catch(() => null);

  // (b) 只读的表格回答：没有计划行；主动作是「复制为表格」；Ctrl+K 不开动作列表，⌘/Ctrl+Shift+K 开，Esc 关。
  const n = await answers();
  await rp.click(panel, "#input");
  await rp.typeText(panel, TABLE);
  await rp.pressEnter(panel);
  await sleep(600);
  check("只读、同一个站的任务不出计划行", !(await rp.evaluate(panel, `!!document.querySelector(".task-plan-goal")`)), null);
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
  await rp.evaluate(panel, `document.querySelector(".tab-mention-remove")?.click() ?? true`);

  // (e) 任务运行中 @ 另一页再插话：模型真的读到那一页（脚本模型看到笔记正文才写 NOTES_SEEN），胶囊打勾。
  await rp.click(panel, "#input");
  await rp.typeText(panel, SLOW);
  await rp.pressEnter(panel);
  await until(async () => (await rp.evaluate(panel, `document.body.innerText.includes("第 2 段")`)) || undefined, 30_000, "慢回答开始");
  await rp.click(panel, "#input");
  await rp.typeText(panel, "@");
  await until(async () => (await rp.evaluate(panel, `document.querySelectorAll("#tab-mention-menu .tab-mention-item").length`)) as number > 1 || undefined, 5_000, "运行中的标签页列表");
  await rp.evaluate(panel, `(() => { [...document.querySelectorAll("#tab-mention-menu .tab-mention-item")].find(r => r.innerText.includes("会议笔记"))?.click(); return true; })()`);
  await sleep(300);
  await rp.typeText(panel, STEER);
  await rp.pressEnter(panel);
  const seen = await until(async () => (await rp.evaluate(panel, `document.body.innerText.includes(${JSON.stringify(NOTES_SEEN)})`)) || undefined, 60_000, "模型读到笔记").catch(() => false);
  await sleep(1_500);
  const steerChip = await rp.evaluate(panel, `(() => { const u = [...document.querySelectorAll("#messages .msg.user")].find(m => m.innerText.includes(${JSON.stringify(STEER)})); const row = u?.nextElementSibling; const c = row?.matches(".ctx-chips") ? row.querySelector(".ctx-chip[data-tab-id]") : null; return c ? { text: c.innerText, status: c.dataset.status } : null; })()`);
  await rp.screenshot(panel, join(out, "steer-mention.png"));
  check("运行中 @ 笔记页再插话：模型读到笔记正文，这条消息下的胶囊打勾", seen === true && (steerChip as { status?: string } | null)?.status === "read", { seen, steerChip });
} catch (error) {
  check("流程完成", false, String(error));
} finally {
  await stopRecording?.().catch(() => null);
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every((c) => c.pass) ? "PASS" : "FAIL", checks }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.close();
}

console.log(out);

if (!checks.length || checks.some((c) => !c.pass)) process.exitCode = 1;
