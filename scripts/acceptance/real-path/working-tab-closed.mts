/**
 * 工作标签页被关掉后，任何调用都不悄悄换到别的页上：不执行，报错写明它已关闭、用户正在看哪一页、怎样继续。
 * 只装扩展、隔离构建、本机脚本模型、本机练习页；只有模型回复是脚本。
 *   npx tsx scripts/acceptance/real-path/working-tab-closed.mts --headless
 * 用户停在「用户页」U 上（有一个输入框，提交会改页面标题）。助手 tabs open 一个后台页 A（成为工作标签页），
 * 用例从浏览器外部（CDP Target.closeTarget）关掉 A。接着脚本模型：
 *   不带 tabId 调 snapshot；browser_run 里依次 snapshot、fill、press_key（每步单独接住错误）；
 *   宿主在程序第一步失败时就停下整个程序，所以再各用一个只有 fill、只有 press_key 的程序，让这两步真的发到扩展；
 *   按报错里的页号 tabs switch 到 U；再不带 tabId 调 snapshot。
 * 判据只读回到模型的工具结果原文和用户页本身：
 *   读页：报错写明工作标签页 A 已关闭、没有执行、用户正在看的是 U、用 tabs switch 继续；
 *   程序：三步程序停在 snapshot 并报已关闭；单独的 fill、press_key 也报已关闭；用户页输入框仍为空、没有提交；
 *   切页后读页：读到 U 的内容。
 * 失败方式：报错是「No tab with id: A」，不说用户在哪一页；或程序里的写操作落到了用户页上。
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

const USER_PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>用户页</title><body style="font:16px sans-serif;margin:40px">
<h1>用户页</h1><p>${MARK.user}</p>
<form onsubmit="event.preventDefault();document.title='用户页 已提交'"><input id="q" aria-label="搜索" value=""></form>
</body></html>`;

const OLD_PAGE = `<!doctype html><meta charset="utf-8"><title>后台页 A</title><h1>后台页 A</h1><p>${MARK.old}</p>`;

const site = createServer((req, res) => {
  const html = req.url === "/a" ? OLD_PAGE : USER_PAGE;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
});

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const ASK = "工作页关闭：打开后台页，读页面，再在程序里填表。";
const FINAL = "关闭用例完成。";
const switchToUser = { tool: { name: "tabs", args: { action: "switch", tabId: 0 } } };

// 每步单独接住错误：就算程序自己吞掉错误，后面的写操作也不能落到用户页上。
const PROGRAM = `const out = {};
for (const [name, run] of [["snapshot", () => browser.snapshot({})], ["fill", () => browser.fill({ target: "#q", value: "不该出现的字" })], ["press_key", () => browser.press_key({ key: "Enter" })]]) {
  try { await run(); out[name] = "ran"; } catch (e) { out[name] = String(e && e.message || e); }
}
return out;`;

const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: ASK, steps: [
    { tool: { name: "tabs", args: { action: "open", url: `${origin}/a` } } },
    // 停一会儿，让用例在这次读页之前从外部关掉 A。
    { tool: { name: "snapshot", args: {} }, delayMs: 4000 },
    { tool: { name: "browser_run", args: { code: PROGRAM, label: "填表并提交" } } },
    { tool: { name: "browser_run", args: { code: 'await browser.fill({ target: "#q", value: "不该出现的字" }); return "filled";', label: "只填表" } } },
    { tool: { name: "browser_run", args: { code: 'await browser.press_key({ key: "Enter" }); return "pressed";', label: "只提交" } } },
    switchToUser,
    { tool: { name: "snapshot", args: {} } },
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
    // 模型照报错里给的页号切过去，和真实模型读到这句话后会做的一样。
    const named = call?.name === "snapshot" ? /用户正在看的是标签页 (\d+)/.exec(text)?.[1] : undefined;
    if (named) switchToUser.tool.args.tabId = Number(named);
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
  check("准备 A 打开过、已从外部关掉", oldTab !== null, { oldTab, userTab });

  await until(async () => (await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes(${JSON.stringify(FINAL)}))`)) as boolean, 90_000, `回答「${FINAL}」`);

  const snaps = receipts.filter(r => r.name === "snapshot");
  const [program, fillOnly, keyOnly] = receipts.filter(r => r.name === "browser_run");
  const switched = receipts.find(r => r.name === "tabs" && /"switch"/.test(r.args));
  const refused = `工作标签页 ${oldTab} 已关闭，这次没有执行。用户正在看的是标签页 ${userTab}。`;
  check("读页 不带 tabId：不执行，写明 A 已关闭、用户正在看 U、用 tabs switch 继续", !!snaps[0] && !/"tabId"/.test(snaps[0].args) && has(snaps[0].text, refused) && has(snaps[0].text, 'tabs action:"switch"') && !has(snaps[0].text, "No tab with id"), { text: snaps[0]?.text.slice(0, 400) ?? null, expected: refused });
  check("程序 三步程序在 snapshot 就停下，报已关闭、没有执行", has(program?.text, `工作标签页 ${oldTab} 已关闭，这次没有执行`), { result: program?.text.slice(0, 600) ?? null });
  check("程序 单独的 fill、press_key 也报已关闭、没有执行", [fillOnly, keyOnly].every(r => has(r?.text, `工作标签页 ${oldTab} 已关闭，这次没有执行`)), { fill: fillOnly?.text.slice(0, 400) ?? null, pressKey: keyOnly?.text.slice(0, 400) ?? null });
  const userPage = await rp.evaluate(work, `({ value: document.querySelector("#q").value, title: document.title })`) as { value: string; title: string };
  check("用户页 输入框仍为空、没有提交", userPage.value === "" && userPage.title === "用户页", userPage);
  check("切页 按报错里的页号切到 U", !!switched && /"tabId":(\d+)/.exec(switched.args)?.[1] === String(userTab) && has(switched.text, `Working tab is now ${userTab}`), { args: switched?.args ?? null, text: switched?.text.slice(0, 200) ?? null });
  check("切页后读页 读到 U 的内容", !!snaps[1] && tabOf(snaps[1].text) === userTab && has(snaps[1].text, MARK.user), { head: snaps[1]?.text.slice(0, 300) ?? null });
  await rp.screenshot(panel, join(out, "panel.png"));
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", dependency: "isolated real extension/offscreen Agent/sidebar; scripted local model; local practice pages", checks, receipts, modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.closeAllConnections(); site.close();
}

console.log(JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", out }, null, 2));
if (checks.some(c => !c.pass)) process.exitCode = 1;
