/**
 * 按网址打开时撞上一次性网络错误，助手自动再开一次，不让模型直接告诉用户“连接被关闭，没能打开”。
 *   npx tsx scripts/acceptance/real-path/navigate-transient-retry.mts --headless
 * 本机四个网站：三个第一次请求不回任何内容就断开（Chrome 报 ERR_EMPTY_RESPONSE）、之后正常回页面；一个每次都这样断开。
 * 脚本模型依次：navigate 到第一个，等重试的那一秒里用例像用户一样把这个标签页换到本机另一页；tabs open 第二个（之后都在这个新标签页）；
 * navigate 到第三个；navigate 到一直断开的那个。
 * 判据：用户换了页的那次不重试，结果仍是 error_page 并写明页面变了、没重试，网站只收到 1 轮请求，标签页留在用户换到的页面；
 * tabs open 和第三个的结果是正常页面内容，写明第一次遇到 ERR_EMPTY_RESPONSE、已自动重试一次并成功，结果回来前网站各收到 2 轮打开请求；
 * 一直断开的那次结果仍是 document: error_page，写明重试过一次也失败，结果回来前网站正好收到 2 轮打开请求。
 * 失败方式：去掉重试，后两个能打开的结果是 error_page，网站各只收到 1 轮请求；重试前不核对标签页还在原错误页，用户换到的页面被重试盖掉。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer, type AddressInfo, type Server } from "node:net";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-navigate-transient-retry`);

await mkdir(out, { recursive: true });

const home = createHttpServer((req, res) => {
  const title = req.url === "/mine" ? "用户自己换到的页面" : "我的页面";
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><meta charset="utf-8"><title>${title}</title><h1>${title}</h1>`);
});
await new Promise<void>(done => home.listen(0, "127.0.0.1", done));

/**
 * Chrome 自己有时会在几十毫秒内补发同一个页面请求，所以按“轮”算：和上一个请求相隔不到 GAP_MS 的算同一轮。
 * 只看页面本身（GET /）：Chrome 会预先多开空连接，页面打开后还会另外要 favicon。
 */
const GAP_MS = 400;

/** 前 failRounds 轮打开请求读到请求后不回任何内容就断开（ERR_EMPTY_RESPONSE），之后回一页带 marker 的页面。 */
function flakySite(failRounds: number, marker: string, onRequest?: () => void) {
  const site = { at: [] as number[], server: null as unknown as Server };
  site.server = createServer(socket => socket.once("data", chunk => {
    if (!String(chunk).startsWith("GET / ")) { socket.end("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"); return; }
    site.at.push(Date.now());
    onRequest?.();
    if (roundsBefore(site, Date.now()) <= failRounds) { socket.end(); return; }
    const body = `<!doctype html><meta charset="utf-8"><title>${marker}</title><h1>${marker}</h1><p>重试之后打开的正常页面。</p>`;
    socket.end(`HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
  }));
  return site;
}

/** 到 until 为止网站收到过几轮打开请求。 */
function roundsBefore(site: { at: number[] }, until: number): number {
  return site.at.filter(t => t <= until).filter((t, i, all) => i === 0 || t - all[i - 1]! > GAP_MS).length;
}

/** 用户换页：第一次请求到达后 700 毫秒（助手已认出错误、还在等那一秒），用例把原标签页换到本机另一页。 */
let userNavigates = () => {};
const changedSite = flakySite(1, "不该被重试盖掉", () => { if (changedSite.at.length === 1) setTimeout(() => userNavigates(), 700); });
const navSite = flakySite(1, "导航重试成功页");
const tabSite = flakySite(1, "新标签重试成功页");
const deadSite = flakySite(Infinity, "不该出现");
for (const site of [changedSite, navSite, tabSite, deadSite]) await new Promise<void>(done => site.server.listen(0, "127.0.0.1", done));
const urlOf = (site: { server: Server }) => `http://127.0.0.1:${(site.server.address() as AddressInfo).port}/`;

const ASK = "一次性断连：打开四个网址。";
const FINAL = "四个网址都试过了。";
const receipts: Array<{ name: string; text: string; at: number }> = [];
const seen = new Set<string>();

const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: ASK, steps: [
    { tool: { name: "navigate", args: { url: urlOf(changedSite) } } },
    { tool: { name: "tabs", args: { action: "open", url: urlOf(tabSite) } } },
    { tool: { name: "navigate", args: { url: urlOf(navSite) } } },
    { tool: { name: "navigate", args: { url: urlOf(deadSite) } } },
    { text: FINAL },
  ] },
], undefined, (payload: { tools?: unknown[]; messages?: Array<{ role: string; content?: unknown; tool_call_id?: string; tool_calls?: Array<{ id: string; function: { name: string } }> }> }) => {
  if (!payload.tools?.length) return;
  const names = new Map<string, string>();

  for (const m of payload.messages ?? []) for (const call of m.tool_calls ?? []) names.set(call.id, call.function.name);

  for (const m of payload.messages ?? []) {
    if (m.role !== "tool" || !m.tool_call_id || seen.has(m.tool_call_id)) continue;
    seen.add(m.tool_call_id);
    receipts.push({ name: names.get(m.tool_call_id) ?? "?", text: typeof m.content === "string" ? m.content : JSON.stringify(m.content), at: Date.now() });
  }
});

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };
const brief = (r: { name: string; text: string; at: number } | undefined, site: { at: number[] }) => r ? { name: r.name, text: r.text.slice(0, 500), rounds: roundsBefore(site, r.at), requestsAtMs: site.at.map(t => t - site.at[0]!) } : null;

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(home).port}/` }, work);
  const mineUrl = `http://127.0.0.1:${siteAddress(home).port}/mine`;
  userNavigates = () => { void rp.cdp.send("Page.navigate", { url: mineUrl }, work); };
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);
  await rp.click(panel, "#input"); await rp.typeText(panel, ASK); await rp.pressEnter(panel);
  await until(async () => (await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes(${JSON.stringify(FINAL)}))`)) as boolean, 120_000, `回答「${FINAL}」`);

  const navs = receipts.filter(r => r.name === "navigate");
  const [changed, open, nav, dead] = [navs[0], receipts.find(r => r.name === "tabs"), navs[1], navs[2]];
  const userPage = await rp.evaluate(work, "({ url: location.href, title: document.title })") as { url: string; title: string };
  check("用户换了页：不重试，结果说页面变了，用户的新页面保留", !!changed && changed.text.includes("document: error_page") && /was not retried because the page changed while waiting/.test(changed.text) && changedSite.at.length === 1 && userPage.url === mineUrl, { ...brief(changed, changedSite), userPage });
  const succeeded = /first attempt hit ERR_EMPTY_RESPONSE.*retried once automatically; the retry succeeded/;
  check("打开网址：重试后是正常页面，并说明已自动重试一次", !!nav && nav.text.includes("导航重试成功页") && !nav.text.includes("document: error_page") && succeeded.test(nav.text) && roundsBefore(navSite, nav.at) === 2, brief(nav, navSite));
  check("新开标签页：重试后是正常页面，并说明已自动重试一次", !!open && open.text.includes("新标签重试成功页") && !open.text.includes("document: error_page") && succeeded.test(open.text) && roundsBefore(tabSite, open.at) === 2, brief(open, tabSite));
  check("一直断开：只重试一次，仍报错误页并说明重试过", !!dead && dead.text.includes("document: error_page") && /retried once automatically; the retry also failed/.test(dead.text) && roundsBefore(deadSite, dead.at) === 2, brief(dead, deadSite));
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.length && checks.every(c => c.pass) ? "PASS" : "FAIL", checks, receipts }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); home.closeAllConnections(); home.close();
  for (const site of [changedSite, navSite, tabSite, deadSite]) site.server.close();
}

console.log(`${checks.length && checks.every(c => c.pass) ? "PASS" : "FAIL"} navigate-transient-retry → ${out}`);
process.exit(checks.length && checks.every(c => c.pass) ? 0 : 1);
