/**
 * 点「发送」前停下，等用户在网页上确认（docs/evals/20261009-send-confirm.md R1）。只装扩展、隔离构建、本机脚本模型、本机练习页。
 *   npx tsx scripts/acceptance/real-path/send-confirm.mts --headless
 * 练习页的「发送」「保存」都在表单里，点下去各发一条 POST；判据只看网页上的确认框、服务器收到的 POST、侧栏和助手收到的工具结果。
 *   a) 助手点「发送」：网页出现「要发送吗？」，用户决定前服务器收到 0 条。
 *   b) 用户点确认框上的「发送」：服务器恰好收到 1 条；助手收到的结果写明用户确认后才点。
 *   c) 用户点「不发」：0 条，结果写明用户没让发；同一轮助手再点同一个「发送」：仍是 0 条，不再出确认框。
 *   d) 用户 40 秒后才点「发送」：1 条，侧栏没有「结果未知」。
 *   e) 助手（并行的一段程序）去点确认框上的「发送」：被拒绝，0 条。
 *   f) 「保存」直接点，不出确认框。
 *   g) 等确认时用户点侧栏「停」：0 条，确认框和任务很快结束（记下耗时）。
 *   h) 助手点一个大容器（自己的名字不是发送），坐标落在里面的「发送」上：照样出确认框，用户决定前 0 条。
 *   i) 助手用 clickCount 2 点「发送」：不点、不出确认框，0 条，结果写明不能连点。
 *   j) 按钮 title 是「按 Ctrl+Enter 发送」、文字是「发送」：照样出确认框。
 * 2 分钟没理的情况没跑：产品没有缩短等待的开关，也不为测试加。
 * 失败方式：去掉 click 里的确认等待，a 的服务器在用户决定前就收到 POST；不读落点上的按钮，h 的 POST 在用户决定前就到（反例结果见验收文件）。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-send-confirm`);

await mkdir(out, { recursive: true });

const PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>留言练习页</title><body style="font:16px sans-serif;margin:40px">
<form id="f"><textarea id="draft" rows="3" cols="40" aria-label="留言">周五下午三点开会。</textarea><p><button id="save">保存</button> <button id="send">发送</button></p></form>
<form id="box" style="position:relative;width:320px;height:60px;border:1px solid #ccc"><span>回复框</span><button id="send-in-box" style="position:absolute;left:220px;top:10px;width:80px;height:40px">发送</button></form>
<form id="titled"><p><button id="send-titled" title="按 Ctrl+Enter 发送">发送</button></p></form>
<output id="status"></output>
<script>document.querySelectorAll('form').forEach(f => f.addEventListener('submit', async e => { e.preventDefault(); const what = e.submitter.id;
  await fetch('/' + what, { method: 'POST', body: document.querySelector('#draft').value }); document.querySelector('#status').textContent = what.startsWith('send') ? '已发送' : '已保存'; }));</script></body></html>`;

const posts: Array<{ path: string; at: number }> = [];

const site = createServer(async (req, res) => {
  if (req.method === "POST") { for await (const _ of req) { /* 读完请求体 */ } posts.push({ path: req.url ?? "", at: Date.now() }); res.end("ok"); return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
});

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));

const sent = () => posts.filter(p => p.path.startsWith("/send")).length;

const saved = () => posts.filter(p => p.path === "/save").length;

const clickSend = { tool: { name: "click", args: { target: "#send", label: "发送" } } };

/** 并行的程序：等确认框出来，再按它在网页上的位置去点确认框右边的「发送」。 */
const PROGRAM = `await browser.sleep({ ms: 2500 });
const at = (await browser.js({ code: "(() => { const r = document.querySelector('[data-sideagent-overlay=\\"send-confirm\\"]')?.getBoundingClientRect(); return r ? [r.right - 36, r.top + r.height / 2] : null; })()" })).value;
return await browser.click({ point: at });`;

const ASK = {
  a: "案例A：把草稿发出去。", c: "案例C：把草稿发出去。", d: "案例D：把草稿发出去。",
  e: "案例E：把草稿发出去。", f: "案例F：把草稿保存一下。", g: "案例G：把草稿发出去。",
  h: "案例H：把草稿发出去。", i: "案例I：把草稿发出去。", j: "案例J：把草稿发出去。",
};

const DONE = JSON.stringify({ status: "done", remaining: "", correction: "" });

/** 助手收到的工具结果，按调用编号去重（每次请求都带着全部历史）。 */
const toolTexts: string[] = [];

const toolIds = new Set<string>();

const model = await startScriptedModel([
  // 目标核对的请求里带着用户原话：先认它，直接判完成，免得它匹配到下面的用例去点按钮。
  { match: '"goalPage"', steps: [{ text: DONE }] },
  { match: ASK.a, steps: [clickSend, { text: "A 完成。" }] },
  { match: ASK.c, steps: [clickSend, clickSend, { text: "C 完成。" }] },
  { match: ASK.d, steps: [clickSend, { text: "D 完成。" }] },
  // 两个工具结果把步数加 2：第 1 步是占位。
  { match: ASK.e, steps: [{ tools: [clickSend.tool, { name: "browser_run", args: { label: "点确认框", code: PROGRAM } }] }, { text: "E 完成。" }, { text: "E 完成。" }] },
  { match: ASK.f, steps: [{ tool: { name: "click", args: { target: "#save", label: "保存" } } }, { text: "F 完成。" }] },
  { match: ASK.g, steps: [clickSend, { text: "G 不该出现。" }] },
  // 容器 #box 自己的文字是「回复框 发送」，不以发送开头；坐标 (260, 30) 落在里面的「发送」上。
  { match: ASK.h, steps: [{ tool: { name: "click", args: { target: "#box", position: { x: 260, y: 30 }, label: "回复框" } } }, { text: "H 完成。" }] },
  { match: ASK.i, steps: [{ tool: { name: "click", args: { target: "#send", label: "发送", clickCount: 2 } } }, { text: "I 完成。" }] },
  { match: ASK.j, steps: [{ tool: { name: "click", args: { target: "#send-titled", label: "按钮" } } }, { text: "J 完成。" }] },
], undefined, payload => {
  for (const m of payload.messages ?? []) {
    const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map(p => p.text ?? "").join("") : "";

    // SAFETY: OpenAI 兼容的 tool 消息带 tool_call_id。
    const id = String((m as { tool_call_id?: unknown }).tool_call_id ?? "");

    if (m.role === "tool" && !toolIds.has(id)) { toolIds.add(id); toolTexts.push(text); }
  }
});

const rp = await launchRealPath();

const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];

const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

const measured: Record<string, Json> = {};

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);

  type DomNode = { nodeName: string; nodeValue?: string; backendNodeId: number; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] };

  const walk = (n: DomNode, hit: (n: DomNode) => boolean): DomNode | undefined => hit(n) ? n : [...(n.children ?? []), ...(n.shadowRoots ?? [])].map(c => walk(c, hit)).find(Boolean);

  const textOf = (n: DomNode): string => n.nodeName === "STYLE" ? "" : (n.nodeValue ?? "") + [...(n.children ?? []), ...(n.shadowRoots ?? [])].map(textOf).join("");

  const center = async (n: DomNode) => {
    // SAFETY: DOM.getBoxModel 的 model.border 是 8 个数的四边形（x1,y1,…,x4,y4）。
    const q = (await rp.cdp.send("DOM.getBoxModel", { backendNodeId: n.backendNodeId }, work)).model.border as number[];

    return { x: (q[0]! + q[2]!) / 2, y: (q[1]! + q[5]!) / 2, left: q[0]!, right: q[2]!, top: q[1]!, bottom: q[5]! };
  };

  /** 确认框在 closed shadow 里：用 CDP 穿透读文字和两个按钮的位置。 */
  const confirmBox = async () => {
    // SAFETY: pierce 模式下 DOM.getDocument 的 root 就是 DomNode 树。
    const root = (await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, work)).root as DomNode;
    const host = walk(root, n => n.nodeName === "DIV" && (n.attributes ?? []).join("\u0000").includes("data-sideagent-overlay\u0000send-confirm"));

    if (!host) return null;
    const no = walk(host, n => n.nodeName === "BUTTON" && textOf(n).trim() === "不发");
    const yes = walk(host, n => n.nodeName === "BUTTON" && textOf(n).trim() === "发送");

    // 确认框正在收起时，节点可能在两次 CDP 调用之间被移走：当作已经没有确认框。
    try {
      return { text: textOf(host).replace(/\s+/g, " ").trim(), host: await center(host), no: no ? await center(no) : null, yes: yes ? await center(yes) : null };
    } catch { return null; }
  };

  const userClick = async (at: { x: number; y: number }) => {
    await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y }, work);

    for (const type of ["mousePressed", "mouseReleased"]) await rp.cdp.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 }, work);
  };

  const panelText = async () => String(await rp.evaluate(panel, 'document.querySelector("#messages").innerText'));

  const answered = (text: string) => until(async () => (await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes(${JSON.stringify(text)}))`)) as boolean, 60_000, `回答「${text}」`);

  const ask = async (text: string) => { await rp.click(panel, "#input"); await rp.typeText(panel, text); await rp.pressEnter(panel); };

  const confirmShown = () => until(async () => { const box = await confirmBox(); return box?.yes && box.no ? box : null; }, 30_000, "网页上出现确认框", 100);

  const toolsSince = (from: number) => toolTexts.slice(from);

  // ── a/b：确认后发送 ──
  let from = toolTexts.length;
  await ask(ASK.a);
  // 确认框或发送请求，先到哪个算哪个：去掉停住这一步时，这里看到的是没经确认就发出的 POST。
  await until(async () => sent() > 0 || (await confirmBox())?.yes, 30_000, "确认框或发送请求", 100);
  await sleep(1500);
  const boxA = await confirmBox();
  check("a 助手点「发送」：网页出现「要发送吗？」，用户决定前服务器 0 条", !!boxA?.text.includes("要发送吗？") && sent() === 0, { text: boxA?.text ?? null, sent: sent() });

  if (!boxA?.yes) throw new Error("没有确认框，后面的用例无从做起");
  await rp.screenshot(work, join(out, "a-confirm.png"));
  await userClick(boxA.yes!);
  await until(async () => sent() >= 1, 10_000, "确认后服务器收到发送");
  await answered("A 完成。");
  const toolA = toolsSince(from);
  check("b 用户点「发送」：服务器恰好 1 条，结果写明用户确认后才点", sent() === 1 && toolA.some(t => t.includes("The user confirmed sending on the page")), { sent: sent(), tool: toolA });
  check("b 确认框已收起", !(await confirmBox()), null);

  // ── c：不发，同一轮再点不再问 ──
  from = toolTexts.length;
  const sentBeforeC = sent();
  await ask(ASK.c);
  const boxC = await confirmShown();
  await userClick(boxC.no!);
  const declinedAt = Date.now();
  let reappeared = false;
  const watching = (async () => { while (Date.now() - declinedAt < 60_000) { if (await confirmBox()) { reappeared = true; return; } await sleep(100); } })();
  await answered("C 完成。");
  const secondClickMs = Date.now() - declinedAt;
  void watching;
  const toolC = toolsSince(from);
  check("c 用户点「不发」：服务器 0 条，结果写明用户没让发", sent() === sentBeforeC && toolC.some(t => t.includes("用户在网页上选了「不发」")), { sentDelta: sent() - sentBeforeC, tool: toolC });
  check("c 同一轮再点同一个「发送」：仍 0 条，没有第二个确认框，直接说用户已选不发", !reappeared && sent() === sentBeforeC && toolC.some(t => t.includes("这一轮已经在网页上选了「不发」")), { reappeared, secondClickMs });
  check("c 没有被当成连续出错停下", !/连续三次/.test(await panelText()), null);

  // ── d：40 秒后才确认 ──
  from = toolTexts.length;
  const sentBeforeD = sent();
  await ask(ASK.d);
  const boxD = await confirmShown();
  const shownAt = Date.now();
  await sleep(41_000);
  const waitedMs = Date.now() - shownAt;
  const stillShown = !!(await confirmBox());
  await userClick(boxD.yes!);
  await until(async () => sent() > sentBeforeD, 10_000, "40 秒后确认，服务器收到发送");
  await answered("D 完成。");
  const toolD = toolsSince(from);
  const textD = await panelText();
  measured.dWaitedMs = waitedMs;
  check("d 用户 40 秒后点「发送」：服务器 1 条，侧栏没有「结果未知」", stillShown && sent() - sentBeforeD === 1 && !textD.includes("结果未知") && toolD.some(t => t.includes("The user confirmed sending on the page")), { waitedMs, stillShown, sentDelta: sent() - sentBeforeD, unknownInPanel: textD.includes("结果未知"), tool: toolD });
  await rp.screenshot(panel, join(out, "d-panel.png"));

  // ── e：助手去点确认框上的「发送」──
  from = toolTexts.length;
  const sentBeforeE = sent();
  await ask(ASK.e);
  const boxE = await confirmShown();
  // 程序的落点：确认框右边 36 像素处，要正好在「发送」上，这一项才有意义。
  const programPoint = { x: boxE.host.right - 36, y: (boxE.host.top + boxE.host.bottom) / 2 };
  const onYes = programPoint.x > boxE.yes!.left && programPoint.x < boxE.yes!.right && programPoint.y > boxE.yes!.top && programPoint.y < boxE.yes!.bottom;
  await sleep(6000);
  const stillE = !!(await confirmBox());
  const sentDuringE = sent() - sentBeforeE;
  await userClick((await confirmBox())?.no ?? boxE.no!);
  await answered("E 完成。");
  const toolE = toolsSince(from);
  check("e 助手去点确认框上的「发送」：被拒绝，服务器 0 条", onYes && stillE && sentDuringE === 0 && sent() === sentBeforeE && toolE.some(t => t.includes("助手自己在页面上画")) && toolE.some(t => t.includes("用户在网页上选了「不发」")), { programPoint, yes: boxE.yes, stillE, sentDuringE, tool: toolE });

  // ── f：「保存」照旧直接点 ──
  const savedBefore = saved();
  const requestsBefore = model.requests.length;
  await ask(ASK.f);
  let confirmSeen = false;
  const watchF = (async () => { while (saved() === savedBefore) { if (await confirmBox()) confirmSeen = true; await sleep(100); } })();
  await until(async () => saved() > savedBefore, 30_000, "保存的 POST");
  await watchF;
  await answered("F 完成。");
  const fRequests = model.requests.slice(requestsBefore).filter(r => r.rule === ASK.f);
  const saveToolMs = fRequests.length >= 2 ? fRequests[1]!.atMs - fRequests[0]!.atMs : null;
  measured.saveClickRoundTripMs = saveToolMs;
  check("f 「保存」直接点，不出确认框", !confirmSeen && saved() === savedBefore + 1, { confirmSeen, saved: saved() - savedBefore, saveToolMs });

  // ── g：等确认时点「停」──
  const sentBeforeG = sent();
  await ask(ASK.g);
  await confirmShown();
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn").classList.contains("stopping")'), 10_000, "侧栏出现停止按钮");
  const stopAt = Date.now();
  await rp.click(panel, "#send-btn");
  await until(async () => !(await confirmBox()), 10_000, "停下后确认框收起", 50);
  const confirmGoneMs = Date.now() - stopAt;
  await until(async () => !(await rp.evaluate(panel, 'document.querySelector("#send-btn").classList.contains("stopping")')), 10_000, "侧栏回到空闲", 50);
  const idleMs = Date.now() - stopAt;
  await sleep(2000);
  measured.stopConfirmGoneMs = confirmGoneMs; measured.stopPanelIdleMs = idleMs;
  check("g 等确认时点「停」：服务器 0 条，确认框和任务 2 秒内结束", sent() === sentBeforeG && confirmGoneMs <= 2000 && idleMs <= 2000 && !(await panelText()).includes("G 不该出现。"), { sentDelta: sent() - sentBeforeG, confirmGoneMs, idleMs });
  await rp.screenshot(panel, join(out, "g-panel.png"));

  /** 助手点下去以后：确认框或发送请求先到哪个算哪个；有确认框就停 1.5 秒看服务器，再由用户点「不发」。 */
  const confirmThenDecline = async (key: "h" | "j", text: string) => {
    from = toolTexts.length;
    const before = sent();
    await ask(ASK[key]);
    await until(async () => sent() > before || (await confirmBox())?.yes, 30_000, "确认框或发送请求", 100);
    await sleep(1500);
    const box = await confirmBox();
    const sentBeforeDecision = sent() - before;

    if (box?.no) { await rp.screenshot(work, join(out, `${key}-confirm.png`)); await userClick(box.no); }
    await answered(text);

    return { box: box?.text ?? null, sentBeforeDecision, sentDelta: sent() - before, tool: toolsSince(from) };
  };

  // ── h：点容器，落点在「发送」上 ──
  const h = await confirmThenDecline("h", "H 完成。");
  check("h 点容器、落点在「发送」上：出确认框，用户决定前 0 条", !!h.box?.includes("要发送吗？") && h.sentBeforeDecision === 0 && h.sentDelta === 0, h);

  // ── i：clickCount 2 点「发送」──
  from = toolTexts.length;
  const sentBeforeI = sent();
  let confirmI = false;
  await ask(ASK.i);
  let doneI = false;
  const watchI = (async () => { while (!doneI) { if (await confirmBox()) confirmI = true; await sleep(100); } })();
  await answered("I 完成。");
  await sleep(1000);
  doneI = true;
  await watchI;
  const toolI = toolsSince(from);
  check("i clickCount 2 点「发送」：不点，不出确认框，0 条", !confirmI && sent() === sentBeforeI && toolI.some(t => t.includes("不能连点")), { confirmI, sentDelta: sent() - sentBeforeI, tool: toolI });

  // ── j：title 不以发送开头、文字是「发送」──
  const j = await confirmThenDecline("j", "J 完成。");
  check("j title「按 Ctrl+Enter 发送」、文字「发送」：出确认框，用户决定前 0 条", !!j.box?.includes("要发送吗？") && j.sentBeforeDecision === 0 && j.sentDelta === 0, j);
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ checks, measured, posts, toolTexts, notCovered: ["2 分钟没理自动不发（产品没有缩短等待的开关）", "真实网站", "按回车发送（第一版不拦）"], modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(done => site.close(() => done()));
}

console.log(`证据：${out}`);

if (checks.some(c => !c.pass)) process.exitCode = 1;
