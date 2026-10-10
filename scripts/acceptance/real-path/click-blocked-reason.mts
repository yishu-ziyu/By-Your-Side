/**
 * 点不了时，回执说清是被谁挡住、还是按钮不可用（docs/evals/20261011-click-blocked-reason.md）。
 * 只装扩展、隔离构建、本机脚本模型、本机练习页；只有模型回复是脚本。
 *   npx tsx scripts/acceptance/real-path/click-blocked-reason.mts --headless
 * 练习页有四个按钮，每次被点到都向服务器报一次：
 *   「保存设置」被「Cookie 设置」弹层盖住（弹层被点到也报）；「提交」带 disabled；「下一步」带 aria-disabled="true"；「普通按钮」正常。
 * 脚本模型先读页，再按读到的编号逐个点。判据只读回到模型的工具结果原文和服务器收到的点击。
 *   a 被挡：回执写出挡住它的 dialog 和名字「Cookie 设置」，名字包在网页内容标记里；服务器收不到保存，也收不到弹层。
 *   b 不可用：两次回执都写「不可用」，不写「页面没有变化」；服务器收不到「下一步」（aria-disabled 不拦事件，点到就会报）。
 *   c 普通按钮：照常点到，服务器恰好 1 次。
 * 失败方式：去掉写名字的代码，a 失败；去掉不可用检查，b 失败。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-click-blocked-reason`);

await mkdir(out, { recursive: true });

const hit = (name: string) => `fetch('/hit?b=${name}')`;
const PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>设置页</title><body style="font:16px sans-serif;margin:40px">
<h1>设置页</h1>
<div style="position:relative;width:320px;padding:24px;border:1px solid #ccc">
  <button id="save" type="button" onclick="${hit("save")}">保存设置</button>
  <div role="dialog" aria-label="Cookie 设置" onclick="${hit("overlay")}" style="position:absolute;inset:0;background:rgba(0,0,0,.2)"><p>本站使用 Cookie</p></div>
</div>
<p><button id="submit" type="button" disabled onclick="${hit("submit")}">提交</button></p>
<p><span id="next" role="button" tabindex="0" aria-disabled="true" style="padding:6px 12px;border:1px solid #888" onclick="${hit("next")}">下一步</span></p>
<p><button id="plain" type="button" onclick="${hit("plain")}">普通按钮</button></p>
</body></html>`;

const hits: string[] = [];
const site = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/hit") { hits.push(url.searchParams.get("b") ?? "?"); res.writeHead(204).end(); return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
});

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const ASK = "点不了验收：读页面，然后依次点保存设置、提交、下一步、普通按钮。";
const FINAL = "四个按钮都试过了。";
// 编号在读页后才知道：onPayload 从读页结果里填进这些参数，模型服务在回复前才序列化它们。
const clicks = { save: { target: "" }, submit: { target: "" }, next: { target: "" }, plain: { target: "" } };
const NAMES = { save: "保存设置", submit: "提交", next: "下一步", plain: "普通按钮" } as const;

const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: ASK, steps: [
    { tool: { name: "snapshot", args: {} } },
    { tool: { name: "click", args: clicks.save } },
    { tool: { name: "click", args: clicks.submit } },
    { tool: { name: "click", args: clicks.next } },
    { tool: { name: "click", args: clicks.plain } },
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
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    receipts.push({ name: call?.name ?? "?", args: call?.arguments ?? "", text: text.slice(0, 4000) });
    if (call?.name !== "snapshot") continue;
    for (const [key, label] of Object.entries(NAMES)) {
      const ref = new RegExp(`\\[ref=(\\d+)\\] (?:button|generic) "${label}"`).exec(text)?.[1];
      if (ref) clicks[key as keyof typeof clicks].target = `@${ref}`;
    }
  }
}

const clickReceipt = (key: keyof typeof clicks) => receipts.find(r => r.name === "click" && clicks[key].target && r.args.includes(`"${clicks[key].target}"`))?.text ?? "";
const count = (name: string) => hits.filter(h => h === name).length;

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

  await rp.click(panel, "#input"); await rp.typeText(panel, ASK); await rp.pressEnter(panel);
  await until(async () => (await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes(${JSON.stringify(FINAL)}))`)) as boolean, 90_000, `回答「${FINAL}」`);
  await until(async () => count("plain") > 0 || null, 3_000, "普通按钮的点击到达").catch(() => {});

  check("读页给出了四个按钮的编号", Object.values(clicks).every(c => c.target.startsWith("@")), clicks);
  const save = clickReceipt("save");
  check("a 被挡：回执写出挡住它的 dialog「Cookie 设置」，名字包在网页内容标记里；保存和弹层都没被点", /挡住/.test(save) && /dialog/.test(save) && /<page-content untrusted>\s*Cookie 设置\s*<\/page-content>/.test(save) && count("save") === 0 && count("overlay") === 0, { receipt: save, save: count("save"), overlay: count("overlay") });
  const submit = clickReceipt("submit"), next = clickReceipt("next");
  check("b 不可用：两次回执都写不可用，不写页面没有变化；下一步没被点", [submit, next].every(t => /不可用/.test(t) && !/Nothing on the page changed/.test(t)) && count("next") === 0, { submit, next, nextHits: count("next") });
  const plain = clickReceipt("plain");
  check("c 普通按钮照常点到，服务器恰好 1 次", /Clicked/.test(plain) && count("plain") === 1, { receipt: plain, plain: count("plain") });
  await rp.screenshot(panel, join(out, "panel.png"));
  await rp.screenshot(work, join(out, "page.png"));
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", dependency: "isolated real extension/offscreen Agent/sidebar; scripted local model; local practice page", checks, hits, receipts, modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.closeAllConnections(); site.close();
}

console.log(JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", out }, null, 2));
if (checks.some(c => !c.pass)) process.exitCode = 1;
