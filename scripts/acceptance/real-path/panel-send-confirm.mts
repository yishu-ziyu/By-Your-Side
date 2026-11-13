import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const syncOnly = process.argv.includes("--case=sync");

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
  if (req.method === "POST") { req.setEncoding("utf8"); for await (const _ of req) {  } posts.push(req.url ?? ""); res.end("ok"); return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
});

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));

const sent = () => posts.filter(p => p === "/send").length;

const clickSend = { tool: { name: "click", args: { target: "#send", label: "发送" } } };

const ASK = { p1: "案例P1：把草稿发出去。", p2: "案例P2：把草稿发出去。", p3: "案例P3：把草稿发出去。", p4: "案例P4：把草稿发出去。", p5: "案例P5：把草稿发出去。", p6: "案例P6：把草稿发出去。" };

const model = await startScriptedModel([
  ...Object.values(ASK).map(message => ({ match: JSON.stringify({ message }).slice(0, -1) + ',"clauses":', steps: [{ text: JSON.stringify({ steps: [{ action: "start", taskId: null }] }) }] })),
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  ...Object.entries(ASK).map(([key, match]) => ({ match, steps: [clickSend, { text: `${key.toUpperCase()} 完成。` }] })),
]);

const hook = `(() => {
    const install = () => {
      if (!globalThis.chrome?.runtime?.connect) { setTimeout(install, 0); return; }
      const connect = chrome.runtime.connect.bind(chrome.runtime);
      window.__confirmationHook = true;
      chrome.runtime.connect = (...args) => {
        const port = connect(...args);
        if (port.name !== "send-confirm-panel") return port;
        window.__confirmationHookConnected = true;
        return {
          name: port.name,
          postMessage: message => { (window.__confirmationPosts ??= []).push(message); port.postMessage(message); },
          disconnect: port.disconnect.bind(port),
          onDisconnect: port.onDisconnect,
          onMessage: { addListener(listener) { port.onMessage.addListener(message => {
            window.__replayConfirmation = () => listener(message);
            window.__confirmationPending = message.pending;
            listener(message);
          }); } },
        };
      };
    };
    install();
  })()`;
const prepared = process.env.SIDEAGENT_ACCEPTANCE_DIST;
if (!prepared) throw new Error("请通过 npm run lab 运行确认验收，以复用冻结构建");
const instrumented = await mkdtemp(join(tmpdir(), "bys-confirmation-sync-"));
await cp(prepared, instrumented, { recursive: true });
const panelScript = join(instrumented, "sidepanel.js");
await writeFile(panelScript, `${hook};\n${await readFile(panelScript, "utf8")}`);
const rp = await launchRealPath({ dist: instrumented });

const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];

const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, work);
  let panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  const ready = (session: string) => until(async () => await rp.evaluate(session, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");
  await ready(panel);

  const firstPanelTarget = (await rp.targets()).find(t => t.url.includes("/sidepanel.html"))!.targetId;
  const firstWindow = Number(await rp.evaluate(panel, 'chrome.windows.getCurrent().then(w => w.id)'));
  const otherWindow = Number(await rp.evaluate(panel, 'chrome.windows.create({ url: "about:blank", focused: false }).then(w => w.id)'));
  const opened = await rp.evaluate(panel, `chrome.sidePanel.open({ windowId: ${otherWindow} }).then(() => "opened", e => "error: " + e.message)`, { userGesture: true });

  if (opened !== "opened") throw new Error(`二号侧栏没打开：${String(opened)}`);
  const panel2 = await rp.attach((await until(async () => (await rp.targets()).find(t => t.url.includes("/sidepanel.html") && t.targetId !== firstPanelTarget), 15_000, "二号侧栏出现")).targetId);
  await ready(panel2);
  await rp.cdp.send("Page.bringToFront", {}, work);
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);

  type DomNode = { nodeName: string; nodeValue?: string; backendNodeId: number; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] };

  const walk = (n: DomNode, hit: (n: DomNode) => boolean): DomNode | undefined => hit(n) ? n : [...(n.children ?? []), ...(n.shadowRoots ?? [])].map(c => walk(c, hit)).find(Boolean);

  const textOf = (n: DomNode): string => n.nodeName === "STYLE" ? "" : (n.nodeValue ?? "") + [...(n.children ?? []), ...(n.shadowRoots ?? [])].map(textOf).join("");

  const pageBox = async () => {
    const root = (await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, work)).root as DomNode;
    const host = walk(root, n => n.nodeName === "DIV" && (n.attributes ?? []).join("\u0000").includes("data-sideagent-overlay\u0000send-confirm") && textOf(n).trim().length > 0);
    if (!host) return null;
    return { text: textOf(host).replace(/\s+/g, " ").trim() };
  };

  const card = async (session: string) => (await rp.evaluate(session, `(() => { const c = [...document.querySelectorAll(".send-confirm")].at(-1); return c ? { id: c.dataset.sendConfirm, text: c.innerText.replace(/\\s+/g, " ").trim(), state: c.dataset.state, buttons: [...c.querySelectorAll("button")].map(b => b.textContent) } : null; })()`)) as { id: string; text: string; state: string; buttons: string[] } | null;

  const allCards = async (session: string) => (await rp.evaluate(session, `[...document.querySelectorAll(".send-confirm")].map(c => ({ text: c.innerText.replace(/\\s+/g, " ").trim(), buttons: c.querySelectorAll("button").length }))`)) as Array<{ text: string; buttons: number }>;

  const liveCard = (session: string) => until(async () => { const c = await card(session); return c?.buttons.includes("发送") && c.buttons.includes("先不发") ? c : null; }, 30_000, "侧栏出现能点的确认卡", 100);

  const settledCard = (session: string, text: string) => until(async () => { const c = await card(session); return c?.state === "done" && c.text === text && c.buttons.length === 0 ? c : null; }, 10_000, `侧栏的卡收成「${text}」`, 100).catch(async () => ({ timedOut: true, last: await card(session) }));

  const answered = (text: string) => until(async () => (await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes(${JSON.stringify(text)}))`)) as boolean, 60_000, `回答「${text}」`);

  const idle = async () => { await until(async () => !(await rp.evaluate(panel, 'document.querySelector("#send-btn")?.classList.contains("stopping")')), 15_000, "侧栏回到空闲", 50); await sleep(200); };

  const ask = async (text: string) => { await rp.click(panel, "#input"); await rp.typeText(panel, text); await rp.pressEnter(panel); };

  const press = (session: string, id: string, which: "yes" | "no") => rp.click(session, `[data-send-confirm="${id}"] .send-confirm-${which}`);

  const draft = async () => String(await rp.evaluate(work, 'document.querySelector("#draft").value'));

  const host = `127.0.0.1:${siteAddress(site).port}`;

  await ask(ASK.p1);
  await until(async () => await pageBox(), 30_000, "网页圈选提示", 100);
  await sleep(1200);
  panel = await until(async () => {
    for (const target of (await rp.targets()).filter(target => target.url.startsWith(`chrome-extension://${rp.extensionId}/sidepanel.html`))) {
      const session = await rp.attach(target.targetId);
      const windowId = await rp.evaluate(session, 'globalThis.chrome?.windows?.getCurrent().then(w => w.id)').catch(() => undefined);
      if (windowId === firstWindow) return session;
      await rp.detach(session);
    }
    return undefined;
  }, 15_000, "确认卡所在窗口的侧栏");
  await rp.screenshot(panel, join(out, "p1-panel-waiting.png"));
  const c1 = await liveCard(panel);
  const c1b = await liveCard(panel2);
  check("p1 两个侧栏都出卡，写网站、按钮、表单里的草稿，不写备忘", [c1, c1b].every(c => c.text.includes(host) && c.text.includes("留言练习页") && c.buttons.includes("发送") && c.text.includes(DRAFT) && !c.text.includes("备忘") && !/POST\s+\//.test(c.text)), { c1, c1b, host });
  const docked = await rp.evaluate(panel, `(() => { const dock = document.querySelector("#confirm-dock"); const card = dock?.querySelector(".send-confirm"); return { hidden: dock?.hidden ?? true, inDock: !!card, title: card?.querySelector(".send-confirm-title")?.textContent ?? "", wait: card?.querySelector(".send-confirm-wait")?.textContent ?? "" }; })()`) as { hidden: boolean; inDock: boolean; title: string; wait: string };
  check("p1 待确认钉在输入框上方，并显示倒计时", docked.inDock && !docked.hidden && docked.title === "留言练习页" && /\d{2}:\d{2} 后取消/.test(docked.wait), docked);
  const waitingTitle = await rp.evaluate(panel, `document.querySelector('.run:not(.done) .run-title')?.textContent ?? document.querySelector('[data-wait-user] .steps-title')?.textContent ?? ''`);
  const waitingText = await rp.evaluate(panel, `document.querySelector('[data-wait-user]')?.innerText ?? ''`);
  check("等待确认时不再声称正在点击发送", String(waitingText).includes("等你确认") && !String(waitingText).includes("正在：点「发送」"), { waitingTitle, waitingText });
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
  await idle();
  await rp.screenshot(panel, join(out, "p1-panel-done.png"));

  if (!syncOnly) {
  await ask(ASK.p2);
  const c2 = await liveCard(panel);
  await rp.screenshot(panel, join(out, "p2-panel-card.png"));
  await press(panel, c2.id, "no");
  const done2 = await settledCard(panel, DECLINED_LINE);
  await answered("P2 完成。");
  await idle();
  const box2 = await pageBox();
  check("p2 侧栏点「先不发」：0 条，草稿还在，网页圈选收起，卡收成一行", sent() === 1 && (await draft()) === DRAFT && !box2 && !("timedOut" in done2), { sent: sent(), draft: await draft(), pageBox: box2?.text ?? null, done2 } as Json);

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
  await idle();

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
  await idle().catch(() => {});
  check("p4 重开后在侧栏点「发送」：恰好 1 条", sent() === 2, { sent: sent() });
  await rp.cdp.send("Page.reload", {}, panel);
  await sleep(500);
  await ready(panel);
  const replay = await until(async () => { const all = await allCards(panel); return all.length === 4 ? all : null; }, 15_000, "回放出四张卡").catch(async () => allCards(panel));
  const expected = [SENT_LINE, DECLINED_LINE, DECLINED_LINE, SENT_LINE];
  check("p4 再重开：回放出来的卡都只有一行结果，没有按钮", replay.length === 4 && replay.every((c, i) => c.buttons === 0 && c.text === expected[i]), { replay });
  await rp.screenshot(panel, join(out, "p4-panel-replay.png"));

  await rp.evaluate(panel, `(() => { window.__arm = {}; window.__lines = {}; new MutationObserver(() => {
    for (const c of document.querySelectorAll(".send-confirm")) { const id = c.dataset.sendConfirm; if (c.querySelector(".send-confirm-yes")) window.__arm[id] ??= performance.now();
      const line = c.querySelector(".send-confirm-line")?.textContent; if (line) { const seen = (window.__lines[id] ??= []); if (seen.at(-1) !== line) seen.push(line); } }
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  document.addEventListener("click", e => { if (e.target.closest?.(".send-confirm-yes")) window.__yesClick = performance.now(); }, true); return true; })()`);
  const before5 = sent();
  await ask(ASK.p5);
  const c5 = await until(async () => await rp.evaluate(panel, `(() => {
    const card = [...document.querySelectorAll(".send-confirm")].at(-1);
    const button = card?.querySelector(".send-confirm-yes");
    if (!card || !button) return null;
    const rect = button.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? { id: card.dataset.sendConfirm, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
  })()`) as { id: string; x: number; y: number } | null, 30_000, "p5 卡出现", 20);
  await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c5.x, y: c5.y }, panel);
  await rp.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: c5.x, y: c5.y, button: "left", clickCount: 1 }, panel);
  await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: c5.x, y: c5.y, button: "left", clickCount: 1 }, panel);
  const early5 = Number(await rp.evaluate(panel, `window.__yesClick - window.__arm[${JSON.stringify(c5.id)}]`));
  await sleep(1200);
  check("p5 卡上「发送」露出来 300 毫秒内就点：不发，卡还能点", early5 < 300 && sent() === before5 && !!(await card(panel))?.buttons.includes("发送"), { early5, sentDelta: sent() - before5 });
  const focused = await rp.evaluate(panel, `(() => { const b = document.querySelector('[data-send-confirm="${c5.id}"] .send-confirm-yes'); b.focus(); return document.activeElement === b; })()`);
  await rp.pressEnter(panel);
  const space = { key: " ", code: "Space", windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 };
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", text: " ", ...space }, panel);
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...space }, panel);
  await until(async () => sent() >= before5 + 1, 5_000, "键盘确认后服务器收到发送").catch(() => {});
  await sleep(600);
  check("p5 明确聚焦确认后按回车：只发送一次，随后空格不重复发送", focused === true && sent() === before5 + 1, { focused: focused as Json, sentDelta: sent() - before5 });
  const done5 = await settledCard(panel, SENT_LINE);
  await answered("P5 完成。").catch(() => {});
  await idle().catch(() => {});
  const lines5 = (await rp.evaluate(panel, `window.__lines[${JSON.stringify(c5.id)}] ?? []`)) as string[];
  check("p5 键盘确认：恰好 1 条；执行以前卡上写「你确认了发送」，执行以后才写「已发送」", sent() - before5 === 1 && !("timedOut" in done5) && lines5[0] === "你确认了发送" && lines5.at(-1) === SENT_LINE, { sentDelta: sent() - before5, lines5, done5 } as Json);

  }
  const before6 = sent();
  await ask(ASK.p6);
  const c6 = await liveCard(panel);
  const original6 = String(await rp.evaluate(panel, 'document.querySelector("#conversation-menu [aria-checked=true]")?.dataset.conversationId ?? ""'));
  await rp.click(panel, "#conversation-new");
  await until(async () => await rp.evaluate(panel, `document.querySelector("#conversation-menu [aria-checked=true]")?.dataset.conversationId !== ${JSON.stringify(original6)}`), 10_000, "切到新会话");
  const away6 = await rp.evaluate(panel, `(() => ({ visible: [...document.querySelectorAll(".send-confirm")].filter(c => c.getClientRects().length > 0).length, dockHidden: document.querySelector("#confirm-dock")?.hidden ?? true }))()`) as { visible: number; dockHidden: boolean };
  await rp.screenshot(panel, join(out, "p6-other-conversation.png"));
  check("p6 等待确认时切到新会话：旧卡消失，确认区收起", away6.visible === 0 && away6.dockHidden, away6);
  await rp.click(panel, "#conversation-switcher");
  const other6 = await until(async () => await rp.evaluate(panel, `(() => { const r = document.querySelector("#conversation-other"); if (!r) return undefined; const p = r.querySelector("p").getBoundingClientRect(), b = r.querySelector("button").getBoundingClientRect(), row = r.getBoundingClientRect(); return { text: r.innerText.replace(/\\s+/g, " "), row: row.width, line: p.width, lineHeight: p.height, button: b.width, lineHeightPx: parseFloat(getComputedStyle(r.querySelector("p")).lineHeight) }; })()`), 5_000, "菜单顶部出现另一个任务") as { text: string; row: number; line: number; lineHeight: number; button: number; lineHeightPx: number };
  await rp.screenshot(panel, join(out, "p6-other-task-row.png"));
  check("p6 菜单顶部「另有 1 个任务还没做完」横排可读：文字占大半行、最多两行，「继续」按钮只占自身宽度", other6.line > other6.row * 0.5 && other6.lineHeight <= other6.lineHeightPx * 2 + 1 && other6.button < other6.row * 0.3, other6);
  const row6 = await rp.evaluate(panel, `document.querySelector('#conversation-menu [data-conversation-id="${original6}"] .conversation-menu-ending')?.textContent ?? null`);
  check("p6 等确认的那个会话在列表里不写「做完了」", typeof row6 === "string" && !/做完|完成/.test(row6), { row6 } as Json);
  const menu6 = await rp.evaluate(panel, `(() => { const b = document.querySelector('#conversation-menu [data-conversation-id="${original6}"]'); b?.scrollIntoView({ block: "nearest" }); return { found: !!b, ids: [...document.querySelectorAll("#conversation-menu [data-conversation-id]")].map(e => e.dataset.conversationId + ":" + e.getAttribute("aria-checked")) }; })()`) as Json;
  await rp.click(panel, `#conversation-menu [data-conversation-id="${original6}"]`);
  const selected6 = await until(async () => await rp.evaluate(panel, `document.querySelector("#conversation-menu [aria-checked=true]")?.dataset.conversationId === ${JSON.stringify(original6)} || undefined`), 10_000, "切回原会话").then(() => true, () => false);
  check("p6 点菜单切回原会话", selected6, menu6);
  await ready(panel);
  const back6 = await liveCard(panel);
  check("p6 切回原会话：恢复同一张待确认卡", back6.id === c6.id, { before: c6, after: back6 });
  await rp.evaluate(panel, `(() => { window.__confirmationEvents = []; for (const type of ['mousedown','mouseup','click']) document.addEventListener(type, event => { if (!window.__heldConfirmationButton) return; const target = event.target; window.__confirmationEvents.push({type,trusted:event.isTrusted,target:target.className,button:target.closest?.('.send-confirm-no')===window.__heldConfirmationButton}); }, true); return true; })()`);
  const heldButton = await rp.evaluate(panel, `(() => {
    const button = document.querySelector('[data-send-confirm="${back6.id}"] .send-confirm-no');
    window.__heldConfirmationButton = button;
    const r = button.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, transform: getComputedStyle(document.querySelector(".composer-dock-wrap")).transform, armed: typeof window.__replayConfirmation === 'function' && window.__confirmationPending.includes('${back6.id}') };
  })()`) as { x: number; y: number; armed: boolean };
  if (!heldButton.armed) throw new Error("确认同步实验没有收到真实待确认状态：" + JSON.stringify(await rp.evaluate(panel, "({installed:window.__confirmationHook,connected:window.__confirmationHookConnected,pending:window.__confirmationPending})")));
  await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: heldButton.x, y: heldButton.y }, panel);
  await rp.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: heldButton.x, y: heldButton.y, button: "left", clickCount: 1 }, panel);
  const keptButton = await rp.evaluate(panel, "window.__replayConfirmation(); window.__heldConfirmationButton.isConnected");
  await sleep(150);
  await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: heldButton.x, y: heldButton.y, button: "left", clickCount: 1 }, panel);
  const clickTrace = await rp.evaluate(panel, `({events:window.__confirmationEvents,posts:window.__confirmationPosts??[],connected:window.__heldConfirmationButton.isConnected,rect:window.__heldConfirmationButton.getBoundingClientRect().toJSON(),start:${JSON.stringify(heldButton)}})`) as { events: Array<{ type: string; trusted: boolean; button: boolean }>; posts: Array<{ id: string; choice: string }> };
  check("p6 按下和松开都命中取消，后台恰好收到一次取消", clickTrace.events.filter(event => event.button && event.trusted).map(event => event.type).join(",") === "mousedown,mouseup,click" && clickTrace.posts.filter(post => post.id === back6.id && post.choice === "decline").length === 1, clickTrace);
  check("p6 按住按钮时收到重复同步：保留按钮，不能吞掉这次点击", keptButton === true, { keptButton: keptButton as Json });
  const done6 = await settledCard(panel, DECLINED_LINE);
  check("p6 切回来后选择先不发：没有发送，原会话卡收成结果", sent() === before6 && !("timedOut" in done6), { sent: sent(), before: before6, done6 } as Json);
  await rp.screenshot(panel, join(out, "p6-result.png"));
  await sleep(300);
} catch (error) {
  check("流程完成", false, String(error));
  const target = (await rp.targets()).find(target => target.url.includes("/sidepanel.html"));
  if (target) {
    const session = await rp.attach(target.targetId);
    await rp.screenshot(session, join(out, "failure.png"));
    console.log("失败时侧栏", await rp.evaluate(session, 'document.body.innerText'));
  }
  console.log("模型请求", JSON.stringify(model.requests));
} finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ checks, posts, instrumentation: "实际待确认端口消息在按下和松开之间重放一次", notCovered: ["真实网站、真模型", "2 分钟没理（产品没有缩短等待的开关）", "扩展后台重启时卡收成「这次确认已经结束」"] }, null, 2));
  await rp.close(); await rp.remove(); await rm(instrumented, { recursive: true }); await model.close(); await new Promise<void>(done => site.close(() => done()));
}

console.log(`证据：${out}`);

if (checks.some(c => !c.pass)) process.exitCode = 1;
