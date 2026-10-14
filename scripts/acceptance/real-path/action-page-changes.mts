/**
 * 点击、填写之后，工具结果直接带回“页面上新出现了什么”，模型不用再读一次页（docs/evals/20261014-action-page-changes.md）。
 * 只装扩展、隔离构建、本机脚本模型、本机练习页；只有模型回复是脚本。
 *   npx tsx scripts/acceptance/real-path/action-page-changes.mts --headless
 * 练习页是一长页笔记（3000 段正文，约 1.5 万个无障碍节点），点「新建笔记」弹出对话框：
 *   标题框（原来写着草稿名）、口令框和提货码框（autocomplete=one-time-code，名字不像敏感栏；都原来有值）、「保存」。
 * 弹窗打开时页面像常见弹窗库那样给 body 加 modal-open、锁滚动（大元素只改了属性，不能盖住里面新出现的对话框）。
 * 页面上还有一个编辑器（contenteditable）。往标题框填字后，对话框里出现一行提示“原标题「草稿名」已替换”；点「保存」向服务器报标题并关掉对话框。
 * 脚本模型只在开头读一次页，之后的编号全部取自点击、填写的结果原文。判据只读回到模型的工具结果和服务器收到的保存。
 *   a 点击结果带回对话框里的标题框和「保存」的编号（读页时没有这两个编号），不带整页正文，不超过 2000 字。
 *   b 脚本模型照这两个编号填写、保存：服务器收到标题，对话框关掉；整轮只读了一次页。
 *   c 口令、提货码的值不出现在任何结果里；填写结果带回新出现的提示，但不带被替换掉的旧标题；往编辑器里填的字不当成新出现的内容。
 *   d 工具为此多花的时间（扩展后台记的毫秒数）中位数不超过 300 毫秒，带回了内容的那几步每一步也不超过 300 毫秒。
 * 失败方式：关掉变化摘要（pageChangesAfter 直接返回 undefined），a、b 失败；改回动作后读整页，d 失败。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-action-page-changes`);

await mkdir(out, { recursive: true });

const OLD_TITLE = "草稿-OLD7731";
const SECRET = "pw-SECRET9948";
const CODE = "PICKUP-CODE5521";
const NEW_TITLE = "周会纪要";
// 大页面（约 1.5 万个无障碍节点）：整页读一次要半秒以上，只读变过的几处才进得了时间预算。
// 再大（6000 段）时，机器忙的时候开头那次读页会超过 8 秒、退回简化快照，用例就测不到要测的东西了。
const LONG = Array.from({ length: 3000 }, (_, i) => `<p>第 ${i + 1} 段：这是一段很长的笔记正文，<a href="#p${i}">链接 ${i + 1}</a>。</p>`).join("");
const PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>笔记</title><body style="font:16px sans-serif;margin:40px">
<h1>我的笔记</h1>
<p><label>备注 <input id="memo" aria-label="备注"></label> <button id="new" type="button">新建笔记</button></p>
<div id="editor" contenteditable="true" role="textbox" aria-label="正文" style="border:1px solid #ccc;min-height:2em"></div>
${LONG}
<script>
document.getElementById("new").onclick = () => {
  const box = document.createElement("div");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "新建笔记");
  box.style.cssText = "position:fixed;top:80px;left:80px;padding:24px;background:#fff;border:1px solid #888";
  box.innerHTML = '<p><label>标题 <input id="title" aria-label="标题" value="${OLD_TITLE}"></label></p>'
    + '<p><label>口令 <input id="pw" type="password" aria-label="口令" value="${SECRET}"></label></p>'
    + '<p><label>提货 <input id="code" autocomplete="one-time-code" aria-label="提货" value="${CODE}"></label></p>'
    + '<p id="hint" role="status"></p><button id="save" type="button">保存</button>';
  document.body.append(box);
  // 和常见弹窗库一样，打开时锁住页面滚动：给 body 加类、改样式。
  document.body.classList.add("modal-open");
  document.body.style.overflow = "hidden";
  const title = box.querySelector("#title");
  title.addEventListener("input", () => { box.querySelector("#hint").textContent = "原标题「${OLD_TITLE}」已替换"; });
  box.querySelector("#save").onclick = () => { fetch("/save?title=" + encodeURIComponent(title.value)); box.remove(); };
};
</script></body></html>`;

const saves: string[] = [];
const site = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/save") { saves.push(url.searchParams.get("title") ?? ""); res.writeHead(204).end(); return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
});

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const ASK = "新建验收：新建一条笔记，标题写周会纪要，保存。";
const FINAL = "笔记已保存。";
// 编号在前一步的结果里才知道：onPayload 从结果原文里填进这些参数，模型服务在回复前才序列化它们。
const EDITOR_TEXT = "编辑器正文ECHO4417";
const steps = { memo: { target: "", value: "随手记" }, editor: { target: "", value: EDITOR_TEXT }, open: { target: "" }, title: { target: "", value: NEW_TITLE }, save: { target: "" } };

const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: ASK, steps: [
    { tool: { name: "snapshot", args: {} } },
    { tool: { name: "fill", args: steps.memo } },
    { tool: { name: "fill", args: steps.editor } },
    { tool: { name: "click", args: steps.open } },
    { tool: { name: "fill", args: steps.title } },
    { tool: { name: "click", args: steps.save } },
    { text: FINAL },
  ] },
], undefined, payload => onPayload(payload));

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

type Receipt = { name: string; args: string; text: string };
const receipts: Receipt[] = [];
const seenCalls = new Set<string>();
const timings: Array<{ ms: number; chars: number }> = [];

/** 回到模型的每个工具结果原文（每次请求带着全部历史，按调用编号去重）。 */
function onPayload(payload: { messages?: Array<{ role: string; content?: unknown; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }>; tools?: unknown[] }) {
  if (!payload.tools?.length) return;
  const calls = new Map<string, { name: string; arguments: string }>();
  for (const m of payload.messages ?? []) for (const call of m.tool_calls ?? []) calls.set(call.id, call.function);
  for (const m of payload.messages ?? []) {
    // SAFETY: OpenAI 兼容的 tool 消息带 tool_call_id。
    const id = String((m as { tool_call_id?: unknown }).tool_call_id ?? "");
    if (m.role !== "tool" || seenCalls.has(id)) continue;
    seenCalls.add(id);
    const call = calls.get(id);
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    receipts.push({ name: call?.name ?? "?", args: call?.arguments ?? "", text });
    if (call?.name === "snapshot") {
      steps.memo.target = `@${/\[ref=(\d+)\] textbox "备注"/.exec(text)?.[1] ?? ""}`;
      steps.open.target = `@${/\[ref=(\d+)\] button "新建笔记"/.exec(text)?.[1] ?? ""}`;
      steps.editor.target = `@${/\[ref=(\d+)\] textbox "正文"/.exec(text)?.[1] ?? ""}`;
    }
    // 标题框和「保存」只从点击结果里拿：读页时它们还不存在。
    if (call?.name === "click" && call.arguments.includes(steps.open.target)) {
      steps.title.target = `@${/\[ref=(\d+)\] textbox "标题"/.exec(text)?.[1] ?? ""}`;
      steps.save.target = `@${/\[ref=(\d+)\] button "保存"/.exec(text)?.[1] ?? ""}`;
    }
  }
}

/** 结果里“新出现了什么”那一段（包在网页内容标记里）。 */
const appearedPart = (text: string) => /New on the page since you last read it[^\n]*\n(<page-content untrusted>[\s\S]*?<\/page-content>)/.exec(text)?.[1] ?? "";

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `${origin}/` }, work);
  const sw = await rp.attach((await until(() => rp.serviceWorker(), 15_000, "service worker")).targetId);
  await until(async () => await rp.evaluate(sw, "typeof chrome === 'object' && !!chrome.tabs").catch(() => false), 15_000, "扩展后台就绪");
  rp.cdp.onEvent("Runtime.consoleAPICalled", (message: { sessionId?: string; params: { args?: Array<{ value?: Json }> } }) => {
    const args = message.params.args ?? [];
    if (message.sessionId === sw && args[0]?.value === "[page-changes]") timings.push(JSON.parse(String(args[1]?.value)));
  });
  await rp.cdp.send("Runtime.enable", {}, sw);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);

  await rp.click(panel, "#input"); await rp.typeText(panel, ASK); await rp.pressEnter(panel);
  await until(async () => (await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes(${JSON.stringify(FINAL)}))`)) as boolean, 90_000, `回答「${FINAL}」`);
  await until(async () => saves.length > 0 || null, 3_000, "保存到达").catch(() => {});

  const snapshotText = receipts.find(r => r.name === "snapshot")?.text ?? "";
  const openReceipt = receipts.find(r => r.name === "click" && r.args.includes(steps.open.target))?.text ?? "";
  const shown = appearedPart(openReceipt);
  const refsNew = [steps.title.target, steps.save.target].every(t => /^@\d+$/.test(t) && !snapshotText.includes(`[ref=${t.slice(1)}]`));
  check("a 点击结果带回标题框和「保存」的编号（读页时没有），不带整页正文、不带读页时已有的「新建笔记」，不超过 2000 字", refsNew && shown.length > 0 && !/第 \d+ 段/.test(shown) && !shown.includes(`[ref=${steps.open.target.slice(1)}]`) && shown.length <= 2000 + 80, { title: steps.title.target, save: steps.save.target, chars: shown.length, shown });

  const dialogGone = await rp.evaluate(work, '!document.querySelector("[role=dialog]")');
  const snapshots = receipts.filter(r => r.name === "snapshot").length;
  check("b 照结果里的编号填写、保存：服务器收到标题，对话框关掉；整轮只读了一次页", saves.includes(NEW_TITLE) && dialogGone === true && snapshots === 1, { saves, dialogGone, snapshots, calls: receipts.map(r => r.name) });

  const titleReceipt = receipts.find(r => r.name === "fill" && r.args.includes(steps.title.target))?.text ?? "";
  const leaked = receipts.filter(r => r.text.includes("SECRET9948") || r.text.includes("CODE5521")).map(r => r.name);
  const editorReceipt = receipts.find(r => r.name === "fill" && r.args.includes(steps.editor.target))?.text ?? "";
  check("c 口令、提货码不出现在任何结果里；填写结果带回新提示，不带被替换的旧标题；编辑器里打的字不算新出现的", leaked.length === 0 && /已替换/.test(appearedPart(titleReceipt)) && !titleReceipt.includes("OLD7731") && /^@\d+$/.test(steps.editor.target) && !appearedPart(editorReceipt).includes("ECHO4417"), { leaked, titleReceipt, editorReceipt });

  const sorted = timings.map(t => t.ms).sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)]! : NaN;
  const brought = timings.filter(t => t.chars > 0).map(t => t.ms);
  check("d 工具为此多花的时间中位数不超过 300 毫秒，带回内容的每一步也不超过 300 毫秒", sorted.length >= 4 && median <= 300 && brought.length >= 2 && Math.max(...brought) <= 300, { median, brought, timings });
  await rp.screenshot(panel, join(out, "panel.png"));
  await rp.screenshot(work, join(out, "page.png"));
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", dependency: "isolated real extension/offscreen Agent/sidebar; scripted local model; local practice page", checks, saves, timings, receipts, modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.closeAllConnections(); site.close();
}

console.log(JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", out }, null, 2));
if (checks.some(c => !c.pass)) process.exitCode = 1;
