/**
 * 发送前在侧栏里确认（docs/evals/20261015-panel-send-confirm.md）。只装扩展、隔离构建、本机脚本模型、本机练习页。
 *   npx tsx scripts/acceptance/real-path/panel-send-confirm.mts --headless
 * 开两个窗口、各开一个侧栏；判据只看侧栏上的卡、网页上的确认框、服务器收到的 POST 和网页上的草稿。
 *   p1) 助手点「发送」：两个侧栏都出卡，写网站、「发送」、表单里的草稿，不写表单外的备忘；脚本合成的点击不放行；
 *       用户在一号侧栏点「发送」：恰好 1 条，网页确认框收起，两个侧栏的卡都收成「你确认过，已发送」。
 *   p2) 用户在侧栏点「先不发」：0 条，草稿还在，网页确认框收起，卡收成「你没让发，草稿还在」。
 *   p3) 用户在网页确认框上点「发送」：1 条，侧栏的卡收成一行、没有按钮。
 *   p4) 等确认时重开侧栏：卡还能点，点「发送」后 1 条；再重开，回放出来的卡都只有一行结果，没有按钮。
 * 失败方式：卡上不出按钮或按钮不连后台，p1 等不到 POST；不验 isTrusted，合成点击就发了；回放不问后台还等不等，p4 重开后的旧卡还有按钮；
 * 只收起回答的那个侧栏，二号侧栏的卡还留着按钮。
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

const ASK = { p1: "案例P1：把草稿发出去。", p2: "案例P2：把草稿发出去。", p3: "案例P3：把草稿发出去。", p4: "案例P4：把草稿发出去。" };

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

  /** 网页上的确认框在 closed shadow 里：用 CDP 穿透读出它和「发送」的位置。 */
  const pageBox = async () => {
    // SAFETY: pierce 模式下 DOM.getDocument 的 root 就是 DomNode 树。
    const root = (await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, work)).root as DomNode;
    const host = walk(root, n => n.nodeName === "DIV" && (n.attributes ?? []).join("\u0000").includes("data-sideagent-overlay\u0000send-confirm"));

    if (!host) return null;
    const yes = walk(host, n => n.nodeName === "BUTTON" && textOf(n).trim() === "发送");

    try {
      // SAFETY: DOM.getBoxModel 的 model.border 是 8 个数的四边形（x1,y1,…,x4,y4）。
      const q = yes ? (await rp.cdp.send("DOM.getBoxModel", { backendNodeId: yes.backendNodeId }, work)).model.border as number[] : null;

      return { text: textOf(host).replace(/\s+/g, " ").trim(), yes: q ? { x: (q[0]! + q[2]!) / 2, y: (q[1]! + q[5]!) / 2 } : null };
    } catch { return null; }
  };

  const pageClick = async (at: { x: number; y: number }) => {
    await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y }, work);

    for (const type of ["mousePressed", "mouseReleased"]) await rp.cdp.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 }, work);
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
  // 截图在判据前：旧版没有卡时，这张图就是「改前」。
  await until(async () => await pageBox(), 30_000, "网页确认框", 100);
  await sleep(1200);
  await rp.screenshot(panel, join(out, "p1-panel-waiting.png"));
  const c1 = await liveCard(panel);
  const c1b = await liveCard(panel2);
  check("p1 两个侧栏都出卡，写网站、按钮、表单里的草稿，不写备忘", [c1, c1b].every(c => c.text.includes(host) && c.text.includes("「发送」") && c.text.includes(`「${DRAFT}」`) && !c.text.includes("备忘")), { c1, c1b, host });
  const runTitle = String(await rp.evaluate(panel, '[...document.querySelectorAll(".run-steps")].at(-1)?.querySelector(".run-title")?.textContent ?? ""'));
  check("p1 过程行标题写「等你确认发送」", runTitle.includes("等你确认发送"), { runTitle });
  // 脚本合成的点击（isTrusted 为 false）不算用户点的。
  await rp.evaluate(panel, '[...document.querySelectorAll(".send-confirm")].at(-1).querySelector(".send-confirm-yes").click(); true');
  await sleep(1500);
  check("p1 脚本合成的点击不放行：0 条，卡和网页确认框都还在", sent() === 0 && !!(await pageBox()) && !!(await card(panel))?.buttons.includes("发送"), { sent: sent() });
  await press(panel, c1.id, "yes");
  await until(async () => sent() >= 1, 10_000, "侧栏确认后服务器收到发送").catch(() => {});
  const done1 = await settledCard(panel, "你确认过，已发送");
  const done1b = await settledCard(panel2, "你确认过，已发送");
  const box1 = await pageBox();
  check("p1 侧栏点「发送」：恰好 1 条，网页确认框收起，两个侧栏的卡都收成「你确认过，已发送」", sent() === 1 && !box1 && !("timedOut" in done1) && !("timedOut" in done1b), { sent: sent(), pageBox: box1?.text ?? null, done1, done1b } as Json);
  await answered("P1 完成。");
  await rp.screenshot(panel, join(out, "p1-panel-done.png"));

  // ── p2：侧栏上点「先不发」 ──
  await ask(ASK.p2);
  const c2 = await liveCard(panel);
  await rp.screenshot(panel, join(out, "p2-panel-card.png"));
  await press(panel, c2.id, "no");
  const done2 = await settledCard(panel, "你没让发，草稿还在");
  await answered("P2 完成。");
  const box2 = await pageBox();
  check("p2 侧栏点「先不发」：0 条，草稿还在，网页确认框收起，卡收成一行", sent() === 1 && (await draft()) === DRAFT && !box2 && !("timedOut" in done2), { sent: sent(), draft: await draft(), pageBox: box2?.text ?? null, done2 } as Json);

  // ── p3：网页确认框上点「发送」 ──
  await ask(ASK.p3);
  await liveCard(panel);
  const box3 = await until(async () => { const b = await pageBox(); return b?.yes ? b : null; }, 30_000, "网页确认框", 100);
  await pageClick(box3.yes!);
  await until(async () => sent() >= 2, 10_000, "网页确认后服务器收到发送").catch(() => {});
  const done3 = await settledCard(panel, "你确认过，已发送");
  const done3b = await settledCard(panel2, "你确认过，已发送");
  check("p3 网页上点「发送」：1 条，两个侧栏的卡都收成一行、没有按钮", sent() === 2 && !("timedOut" in done3) && !("timedOut" in done3b), { sent: sent(), done3, done3b } as Json);
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

  if (c4) await press(panel, c4.id, "yes");
  await until(async () => sent() >= 3, 10_000, "重开后确认，服务器收到发送").catch(() => {});
  await answered("P4 完成。").catch(() => {});
  check("p4 重开后在侧栏点「发送」：恰好 1 条", sent() === 3, { sent: sent() });
  await rp.cdp.send("Page.reload", {}, panel);
  await sleep(500);
  await ready(panel);
  const replay = await until(async () => { const all = await allCards(panel); return all.length === 4 ? all : null; }, 15_000, "回放出四张卡").catch(async () => allCards(panel));
  const expected = ["你确认过，已发送", "你没让发，草稿还在", "你确认过，已发送", "你确认过，已发送"];
  check("p4 再重开：回放出来的卡都只有一行结果，没有按钮", replay.length === 4 && replay.every((c, i) => c.buttons === 0 && c.text === expected[i]), { replay });
  await rp.screenshot(panel, join(out, "p4-panel-replay.png"));
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ checks, posts, notCovered: ["真实网站、真模型", "2 分钟没理（产品没有缩短等待的开关）", "扩展后台重启时卡收成「这次确认已经结束」"] }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(done => site.close(() => done()));
}

console.log(`证据：${out}`);

if (checks.some(c => !c.pass)) process.exitCode = 1;
