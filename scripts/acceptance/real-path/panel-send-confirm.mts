/**
 * 发送前在侧栏里确认。只装扩展、隔离构建、本机脚本模型、本机练习页。
 *   npx tsx scripts/acceptance/real-path/panel-send-confirm.mts --headless
 * 开两个窗口、各开一个侧栏；判据只看侧栏上的卡、网页上的圈选提示、服务器收到的 POST 和网页上的草稿。
 *   p1) 助手点「发送」：网页圈出按钮并写「等你在侧栏确认」，两个侧栏都出卡，写网站、「发送」、表单里的草稿，不写表单外的备忘；脚本合成的点击不放行；
 *       用户在一号侧栏点「发送」：恰好 1 条，网页圈选收起，两个侧栏的卡都收成「你确认过，已发送」。
 *   p2) 用户在侧栏点「先不发」：0 条，草稿还在，网页圈选收起，卡收成「你选择不发送：草稿留在页面上，不会发出，要发时再跟我说」。
 *   p3) 用户在网页上按 Esc 取消：0 条，网页圈选收起，两个侧栏的卡都收成一行、没有按钮。
 *   p4) 等确认时重开侧栏：卡还能点，点「发送」后 1 条；再重开，回放出来的卡都只有一行结果，没有按钮。
 *   p5) 卡上的「发送」露出来 300 毫秒内就点、聚焦后按回车和空格：都不发；1 秒后再点才发。点下去以前卡上只写「你确认了发送」。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-panel-send-confirm`);

await mkdir(out, { recursive: true });

const DRAFT = "周五下午三点开会。";
const DECLINED_LINE = "你选择不发送：草稿留在页面上，不会发出，要发时再跟我说";
const SENT_LINE = "你确认过，已发送";

const PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>留言练习页</title><body style="font:16px sans-serif;margin:40px">
<div id="memo"><textarea id="note" rows="1" cols="40" aria-label="备忘">备忘：不要发出去。</textarea></div>
<form id="f"><textarea id="draft" rows="3" cols="40" aria-label="留言">${DRAFT}</textarea><p><button id="send">发送</button></p></form>
<script>document.querySelector('#f').addEventListener('submit', async e => { e.preventDefault(); await fetch('/send', { method: 'POST', body: document.querySelector('#draft').value }); });</script></body></html>`;

const posts: string[] = [];

const site = createServer(async (req, res) => {
  if (req.method === "POST") { for await (const _ of req) { /* 读完请求体 */ } posts.push(req.url ?? ""); res.end("ok"); return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
});

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));

const sent = () => posts.filter(p => p === "/send").length;

const clickSend = { tool: { name: "click", args: { target: "#send", label: "发送" } } };

const ASK = { p1: "案例P1：把草稿发出去。", p2: "案例P2：把草稿发出去。", p3: "案例P3：把草稿发出去。", p4: "案例P4：把草稿发出去。", p5: "案例P5：把草稿发出去。" };

const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  ...Object.entries(ASK).map(([key, match]) => ({ match, steps: [clickSend, { text: `${key.toUpperCase()} 完成。` }] })),
]);

const rp = await launchRealPath();

const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];

const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  const ready = (session: string) => until(async () => await rp.evaluate(session, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");
  await ready(panel);

  // 二号窗口和它的侧栏：从一号侧栏（扩展页面，带用户手势）打开。
  const firstPanelTarget = (await rp.targets()).find(t => t.url.includes("/sidepanel.html"))!.targetId;
  const otherWindow = Number(await rp.evaluate(panel, 'chrome.windows.create({ url: "about:blank", focused: false }).then(w => w.id)'));
  const opened = await rp.evaluate(panel, `chrome.sidePanel.open({ windowId: ${otherWindow} }).then(() => "opened", e => "error: " + e.message)`, { userGesture: true });

  if (opened !== "opened") throw new Error(`二号侧栏没打开：${String(opened)}`);
  const panel2 = await rp.attach((await until(async () => (await rp.targets()).find(t => t.url.includes("/sidepanel.html") && t.targetId !== firstPanelTarget), 15_000, "二号侧栏出现")).targetId);
  await ready(panel2);
  await rp.cdp.send("Page.bringToFront", {}, work);

  type DomNode = { nodeName: string; nodeValue?: string; backendNodeId: number; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] };

  const walk = (n: DomNode, hit: (n: DomNode) => boolean): DomNode | undefined => hit(n) ? n : [...(n.children ?? []), ...(n.shadowRoots ?? [])].map(c => walk(c, hit)).find(Boolean);

  const textOf = (n: DomNode): string => n.nodeName === "STYLE" ? "" : (n.nodeValue ?? "") + [...(n.children ?? []), ...(n.shadowRoots ?? [])].map(textOf).join("");

  /** 网页上的圈选提示（「等你在侧栏确认」）。 */
  const pageBox = async () => {
    const root = (await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, work)).root as DomNode;
    const host = walk(root, n => n.nodeName === "DIV" && (n.attributes ?? []).join("\u0000").includes("data-sideagent-overlay\u0000send-confirm") && textOf(n).trim().length > 0);
    if (!host) return null;
    return { text: textOf(host).replace(/\s+/g, " ").trim() };
  };

  /** 侧栏里最后一张发送确认卡：文字、状态、有哪些按钮。 */
  const card = async (session: string) => (await rp.evaluate(session, `(() => { const c = [...document.querySelectorAll(".send-confirm")].at(-1); return c ? { id: c.dataset.sendConfirm, text: c.innerText.replace(/\\s+/g, " ").trim(), state: c.dataset.state, buttons: [...c.querySelectorAll("button")].map(b => b.textContent) } : null; })()`)) as { id: string; text: string; state: string; buttons: string[] } | null;

  const allCards = async (session: string) => (await rp.evaluate(session, `[...document.querySelectorAll(".send-confirm")].map(c => ({ text: c.innerText.replace(/\\s+/g, " ").trim(), buttons: c.querySelectorAll("button").length }))`)) as Array<{ text: string; buttons: number }>;

  const liveCard = (session: string) => until(async () => { const c = await card(session); return c?.buttons.includes("发送") && c.buttons.includes("先不发") ? c : null; }, 30_000, "侧栏出现能点的确认卡", 100);

  const settledCard = (session: string, text: string) => until(async () => { const c = await card(session); return c?.state === "done" && c.text === text && c.buttons.length === 0 ? c : null; }, 10_000, `侧栏的卡收成「${text}」`, 100).catch(async () => ({ timedOut: true, last: await card(session) }));

  const answered = (text: string) => until(async () => (await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes(${JSON.stringify(text)}))`)) as boolean, 60_000, `回答「${text}」`);

  const ask = async (text: string) => { await rp.click(panel, "#input"); await rp.typeText(panel, text); await rp.pressEnter(panel); };

  const press = (session: string, id: string, which: "yes" | "no") => rp.click(session, `[data-send-confirm="${id}"] .send-confirm-${which}`);

  const draft = async () => String(await rp.evaluate(work, 'document.querySelector("#draft").value'));

  const host = `127.0.0.1:${siteAddress(site).port}`;

  // ── p1：侧栏上点「发送」 ──
  await ask(ASK.p1);
  await until(async () => await pageBox(), 30_000, "网页圈选提示", 100);
  await sleep(1200);
  await rp.screenshot(panel, join(out, "p1-panel-waiting.png"));
  const c1 = await liveCard(panel);
  const c1b = await liveCard(panel2);
  check("p1 两个侧栏都出卡，写网站、按钮、表单里的草稿，不写备忘", [c1, c1b].every(c => c.text.includes(host) && c.text.includes("「发送」") && c.text.includes(DRAFT) && !c.text.includes("备忘") && !/POST\s+\//.test(c.text)), { c1, c1b, host });
  const docked = await rp.evaluate(panel, `(() => { const dock = document.querySelector("#confirm-dock"); const card = dock?.querySelector(".send-confirm"); return { hidden: dock?.hidden ?? true, inDock: !!card, title: card?.querySelector(".send-confirm-title")?.textContent ?? "", wait: card?.querySelector(".send-confirm-wait")?.textContent ?? "" }; })()`) as { hidden: boolean; inDock: boolean; title: string; wait: string };
  check("p1 待确认钉在输入框上方，并显示倒计时", docked.inDock && !docked.hidden && /要在/.test(docked.title) && /已等/.test(docked.wait), docked);
  // 脚本合成的点击（isTrusted 为 false）不算用户点的。
  await rp.evaluate(panel, '[...document.querySelectorAll(".send-confirm")].at(-1).querySelector(".send-confirm-yes").click(); true');
  await sleep(1500);
  check("p1 脚本合成的点击不放行：0 条，卡和网页圈选提示都还在", sent() === 0 && !!(await pageBox()) && !!(await card(panel))?.buttons.includes("发送"), { sent: sent() });
  await press(panel, c1.id, "yes");
  await until(async () => sent() >= 1, 10_000, "侧栏确认后服务器收到发送").catch(() => {});
  const done1 = await settledCard(panel, SENT_LINE);
  const done1b = await settledCard(panel2, SENT_LINE);
  const box1 = await pageBox();
  check("p1 侧栏点「发送」：恰好 1 条，网页圈选收起，两个侧栏的卡都收成「你确认过，已发送」", sent() === 1 && !box1 && !("timedOut" in done1) && !("timedOut" in done1b), { sent: sent(), pageBox: box1?.text ?? null, done1, done1b } as Json);
  await answered("P1 完成。");
  await rp.screenshot(panel, join(out, "p1-panel-done.png"));

  // ── p2：侧栏上点「先不发」 ──
  await ask(ASK.p2);
  const c2 = await liveCard(panel);
  await rp.screenshot(panel, join(out, "p2-panel-card.png"));
  await press(panel, c2.id, "no");
  const done2 = await settledCard(panel, DECLINED_LINE);
  await answered("P2 完成。");
  const box2 = await pageBox();
  check("p2 侧栏点「先不发」：0 条，草稿还在，网页圈选收起，卡收成一行", sent() === 1 && (await draft()) === DRAFT && !box2 && !("timedOut" in done2), { sent: sent(), draft: await draft(), pageBox: box2?.text ?? null, done2 } as Json);

  // ── p3：网页上按 Esc 取消发送 ──
  await ask(ASK.p3);
  await liveCard(panel);
  await until(async () => await pageBox(), 30_000, "网页圈选提示", 100);
  const esc = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...esc }, work);
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...esc }, work);
  const done3 = await settledCard(panel, DECLINED_LINE);
  const done3b = await settledCard(panel2, DECLINED_LINE);
  const box3 = await pageBox();
  check("p3 网页上按 Esc：不发送，网页圈选收起，两个侧栏的卡都收成一行、没有按钮", sent() === 1 && !box3 && !("timedOut" in done3) && !("timedOut" in done3b), { sent: sent(), done3, done3b } as Json);
  await answered("P3 完成。");

  // ── p4：等确认时重开侧栏 ──
  await ask(ASK.p4);
  await liveCard(panel);
  await rp.cdp.send("Page.reload", {}, panel);
  await sleep(500);
  await ready(panel);
  const c4 = await liveCard(panel).catch(async () => null);
  const before4 = await allCards(panel);
  await rp.screenshot(panel, join(out, "p4-panel-reopened.png"));
  check("p4 重开侧栏：还在等的那张卡能点，之前答过的卡只有一行、没有按钮", !!c4 && before4.slice(0, -1).every(c => c.buttons === 0) && before4.length === 4, { c4, before4 });

  if (c4) { await sleep(1000); await press(panel, c4.id, "yes"); }
  await until(async () => sent() >= 2, 10_000, "重开后确认，服务器收到发送").catch(() => {});
  await answered("P4 完成。").catch(() => {});
  check("p4 重开后在侧栏点「发送」：恰好 1 条", sent() === 2, { sent: sent() });
  await rp.cdp.send("Page.reload", {}, panel);
  await sleep(500);
  await ready(panel);
  const replay = await until(async () => { const all = await allCards(panel); return all.length === 4 ? all : null; }, 15_000, "回放出四张卡").catch(async () => allCards(panel));
  const expected = [SENT_LINE, DECLINED_LINE, DECLINED_LINE, SENT_LINE];
  check("p4 再重开：回放出来的卡都只有一行结果，没有按钮", replay.length === 4 && replay.every((c, i) => c.buttons === 0 && c.text === expected[i]), { replay });
  await rp.screenshot(panel, join(out, "p4-panel-replay.png"));

  // ── p5：卡上的「发送」刚露出来就点、键盘按：都不算 ──
  await rp.evaluate(panel, `(() => { window.__arm = {}; window.__lines = {}; new MutationObserver(() => {
    for (const c of document.querySelectorAll(".send-confirm")) { const id = c.dataset.sendConfirm; if (c.querySelector(".send-confirm-yes")) window.__arm[id] ??= performance.now();
      const line = c.querySelector(".send-confirm-line")?.textContent; if (line) { const seen = (window.__lines[id] ??= []); if (seen.at(-1) !== line) seen.push(line); } }
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  document.addEventListener("click", e => { if (e.target.closest?.(".send-confirm-yes")) window.__yesClick = performance.now(); }, true); return true; })()`);
  const before5 = sent();
  await ask(ASK.p5);
  const c5 = await until(async () => { const c = await card(panel); return c?.buttons.includes("发送") ? c : null; }, 30_000, "p5 卡出现", 20);
  await press(panel, c5.id, "yes");
  const early5 = Number(await rp.evaluate(panel, `window.__yesClick - window.__arm[${JSON.stringify(c5.id)}]`));
  await sleep(1200);
  check("p5 卡上「发送」露出来 300 毫秒内就点：不发，卡还能点", early5 < 300 && sent() === before5 && !!(await card(panel))?.buttons.includes("发送"), { early5, sentDelta: sent() - before5 });
  const focused = await rp.evaluate(panel, `(() => { const b = document.querySelector('[data-send-confirm="${c5.id}"] .send-confirm-yes'); b.focus(); return document.activeElement === b; })()`);
  await rp.pressEnter(panel);
  const space = { key: " ", code: "Space", windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 };
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", text: " ", ...space }, panel);
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...space }, panel);
  await sleep(1200);
  check("p5 聚焦卡上的「发送」按回车、空格：不发，卡还能点", focused === true && sent() === before5 && !!(await card(panel))?.buttons.includes("发送"), { focused: focused as Json, sentDelta: sent() - before5 });
  await press(panel, c5.id, "yes");
  await until(async () => sent() > before5, 10_000, "p5 一秒后再点，服务器收到发送").catch(() => {});
  const done5 = await settledCard(panel, SENT_LINE);
  await answered("P5 完成。").catch(() => {});
  const lines5 = (await rp.evaluate(panel, `window.__lines[${JSON.stringify(c5.id)}] ?? []`)) as string[];
  check("p5 一秒后再点：恰好 1 条；点下去以前卡上写「你确认了发送」，点下去以后才写「已发送」", sent() - before5 === 1 && !("timedOut" in done5) && lines5[0] === "你确认了发送" && lines5.at(-1) === SENT_LINE, { sentDelta: sent() - before5, lines5, done5 } as Json);
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ checks, posts, notCovered: ["真实网站、真模型", "2 分钟没理（产品没有缩短等待的开关）", "扩展后台重启时卡收成「这次确认已经结束」"] }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(done => site.close(() => done()));
}

console.log(`证据：${out}`);

if (checks.some(c => !c.pass)) process.exitCode = 1;
