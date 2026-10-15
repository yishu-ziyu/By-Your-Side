/**
 * 工作标签页被关掉后，下一次工具调用接回到用户正在看的页，并在结果开头说一句；带旧页 ref 的点击不执行。
 * 只装扩展、隔离构建、本机脚本模型、本机练习页；只有模型回复是脚本。
 *   npx tsx scripts/acceptance/real-path/working-tab-closed.mts --headless
 * 用户停在「用户页」U 上。助手 tabs open 一个后台页 A（成为工作标签页，结果里带 A 的快照和按钮 ref）；
 * 用例从浏览器外部（CDP Target.closeTarget）关掉 A。接着脚本模型不带 tabId 调 snapshot，再用 A 快照里的 ref 调 click。
 * 两页上都有一个按钮，按下会把计数写进页面标题，这样能看出点击有没有落到用户页上。
 * 判据只读回到模型的工具结果原文、扩展后台的 chrome.tabs.query 和用户页的标题：
 *   读页：结果开头是「工作标签页 A 已关闭；已改为用户正在看的标签页 U」，正文是 U 的内容；
 *   点击：结果写明 ref 来自已关闭的标签页 A、工作标签页已接回到 U、这次未执行；用户页上的按钮没被按下。
 * 失败方式：Agent 一侧仍把关掉的 A 当缺省 tabId 补进来，读页和点击都报「No tab with id: A」。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-working-tab-closed`);

await mkdir(out, { recursive: true });

const MARK = { user: "用户页今天开门", old: "后台页今天开门" };

const page = (title: string, mark: string, button: string) => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${title}</title><body style="font:16px sans-serif;margin:40px">
<h1>${title}</h1><p>${mark}</p>
<p><button type="button" onclick="window.pressed=(window.pressed||0)+1;document.title='${title} 按下'+window.pressed">${button}</button></p>
</body></html>`;

const site = createServer((req, res) => {
  const html = req.url === "/a" ? page("后台页 A", MARK.old, "后台页按钮") : page("用户页", MARK.user, "用户页按钮");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
});

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const ASK = "工作页关闭：打开后台页，读页面，再点它的按钮。";
const FINAL = "关闭用例完成。";
const oldClick = { tool: { name: "click", args: { target: "@0", label: "后台页按钮" } } };

const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: ASK, steps: [
    { tool: { name: "tabs", args: { action: "open", url: `${origin}/a` } } },
    // 停一会儿，让用例在这次读页之前从外部关掉 A。
    { tool: { name: "snapshot", args: {} }, delayMs: 4000 },
    oldClick,
    { text: FINAL },
  ] },
], undefined, payload => onPayload(payload));

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

type Receipt = { name: string; args: string; text: string };
const receipts: Receipt[] = [];
const seenCalls = new Set<string>();

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
    const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map(part => (part as { text?: string }).text ?? "").join("\n") : JSON.stringify(m.content);
    receipts.push({ name: call?.name ?? "?", args: call?.arguments ?? "", text: text.slice(0, 4000) });
    // 点击用 A 快照里那颗按钮的 ref：模型此刻手里只有这个编号。
    const ref = call?.name === "tabs" ? /\[ref=(\d+)\] button "后台页按钮"/.exec(text)?.[1] : undefined;
    if (ref) oldClick.tool.args.target = `@${ref}`;
  }
}

const has = (text: string | undefined, mark: string) => (text ?? "").includes(mark);
const tabOf = (text: string | undefined) => Number(/<page-content untrusted tab=(\d+)/.exec(text ?? "")?.[1] ?? NaN);

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `${origin}/` }, work);
  const sw = await rp.attach((await until(() => rp.serviceWorker(), 15_000, "service worker")).targetId);
  await until(async () => await rp.evaluate(sw, "typeof chrome === 'object' && !!chrome.tabs").catch(() => false), 15_000, "扩展后台就绪");
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);
  const tabsNow = async () => (await rp.evaluate(sw, "chrome.tabs.query({}).then(ts => ts.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active })))")) as Array<{ id: number; url: string; title: string; active: boolean }>;
  const userTab = (await tabsNow()).find(t => t.url === `${origin}/`)!.id;

  await rp.click(panel, "#input"); await rp.typeText(panel, ASK); await rp.pressEnter(panel);

  // A 的打开结果回到模型后（脚本此时停在读页那一步），从外部关掉 A。
  await until(async () => receipts.some(r => r.name === "tabs"), 60_000, "tabs open 结果");
  const oldTab = (await tabsNow()).find(t => t.url === `${origin}/a`)?.id ?? null;
  const oldTarget = (await rp.targets()).find(t => t.type === "page" && t.url === `${origin}/a`);
  if (oldTarget) await rp.cdp.send("Target.closeTarget", { targetId: oldTarget.targetId });
  await until(async () => !(await tabsNow()).some(t => t.url === `${origin}/a`), 5_000, "A 已关闭");
  check("准备 A 打开过、已从外部关掉、点击用的是 A 快照里的 ref", oldTab !== null && /^@\d+$/.test(oldClick.tool.args.target), { oldTab, userTab, clickTarget: oldClick.tool.args.target });

  await until(async () => (await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes(${JSON.stringify(FINAL)}))`)) as boolean, 90_000, `回答「${FINAL}」`);

  const snap = receipts.find(r => r.name === "snapshot");
  const click = receipts.find(r => r.name === "click");
  const lead = `工作标签页 ${oldTab} 已关闭；已改为用户正在看的标签页 ${userTab}`;
  check("读页 不带 tabId、结果开头说明已接回到用户页、读到的是用户页", !!snap && !/"tabId"/.test(snap.args) && snap.text.trimStart().startsWith(lead) && tabOf(snap.text) === userTab && has(snap.text, MARK.user) && !has(snap.text, "No tab with id"), { args: snap?.args ?? null, head: snap?.text.slice(0, 400) ?? null, expectedLead: lead });
  check("点击 带 A 的旧 ref：未执行，写明 ref 来自已关闭的 A、已接回到用户页", !!click && has(click.text, `来自已关闭的标签页 ${oldTab}`) && has(click.text, `接回到标签页 ${userTab}`) && has(click.text, "未执行") && !has(click.text, "No tab with id"), { text: click?.text.slice(0, 400) ?? null });
  const userTitle = (await tabsNow()).find(t => t.id === userTab)?.title ?? null;
  check("用户页 按钮没有被按下", userTitle === "用户页", { userTitle });
  await rp.screenshot(panel, join(out, "panel.png"));
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", dependency: "isolated real extension/offscreen Agent/sidebar; scripted local model; local practice pages", checks, receipts, modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.closeAllConnections(); site.close();
}

console.log(JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", out }, null, 2));
if (checks.some(c => !c.pass)) process.exitCode = 1;
