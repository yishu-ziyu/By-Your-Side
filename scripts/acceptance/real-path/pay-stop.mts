/**
 * 付款按钮永远由用户自己点（docs/evals/20261009-pay-stop.md）。只装扩展、隔离构建、本机脚本模型、本机练习页。
 *   npx tsx scripts/acceptance/real-path/pay-stop.mts --headless
 * 练习页是报名表：选中「微信免密」，有「确认支付 ¥98.00 并报名」「下一步」「提交评论」三个按钮，各发一条 POST；还有一个「支付宝」单选项。
 *   a) 助手点付款按钮：服务器 /pay 收到 0 条；网页上有提示，写网站和按钮名；侧栏那一步写「停在付款前，等你自己点」，不标失败。
 *   b) 同一轮助手再点三次：仍是 0 条，不卡住，不被当成连续出错。
 *   e) 提示还在时，用户自己点付款按钮：/pay 恰好 1 条；用户点「知道了」，提示收起。
 *   c) 「下一步」「提交评论」照常点到（服务器各 1 条），「支付宝」单选项照常选中。
 *   d) 网页脚本程序（browser_run）去点付款按钮：被拒绝，/pay 不增加。
 * 失败方式：让 isPayLabel 永远返回 false，a 的服务器收到 /pay（反例结果见验收文件）。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-pay-stop`);

await mkdir(out, { recursive: true });

const PAY_LABEL = "确认支付 ¥98.00 并报名";

const PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>报名练习页</title><body style="font:16px sans-serif;margin:40px">
<h1>周末工作坊报名</h1>
<fieldset><legend>付款方式</legend>
<label><input type="radio" name="m" value="wx" checked> 微信免密</label>
<label id="alipay-label"><input type="radio" id="alipay" name="m" value="alipay"> 支付宝</label></fieldset>
<p><button id="pay" type="button" data-post="/pay">${PAY_LABEL}</button></p>
<p><button id="next" type="button" data-post="/next">下一步</button> <button id="comment" type="button" data-post="/comment">提交评论</button></p>
<output id="status"></output>
<script>document.querySelectorAll('[data-post]').forEach(b => b.addEventListener('click', async () => { await fetch(b.dataset.post, { method: 'POST', body: 'x' }); document.querySelector('#status').textContent = b.textContent; }));</script></body></html>`;

const posts: Array<{ path: string; at: number }> = [];

const site = createServer(async (req, res) => {
  if (req.method === "POST") { for await (const _ of req) { /* 读完请求体 */ } posts.push({ path: req.url ?? "", at: Date.now() }); res.end("ok"); return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
});

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));

const count = (path: string) => posts.filter(p => p.path === path).length;

const clickPay = { tool: { name: "click", args: { target: "#pay", label: PAY_LABEL } } };

const ASK = { a: "案例A：帮我报名并付款。", c: "案例C：下一步、提交评论，再选支付宝。", d: "案例D：用程序帮我付款。" };

const DONE = JSON.stringify({ status: "done", remaining: "", correction: "" });

/** 助手收到的工具结果，按调用编号去重（每次请求都带着全部历史）。 */
const toolTexts: string[] = [];

const toolIds = new Set<string>();

const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: DONE }] },
  // 第 2–4 次点击：没有 heldReason 时，这几步在侧栏标成「没成功」。
  { match: ASK.a, steps: [clickPay, clickPay, clickPay, clickPay, { text: "A 完成。" }] },
  { match: ASK.c, steps: [
    { tool: { name: "click", args: { target: "#next", label: "下一步" } } },
    { tool: { name: "click", args: { target: "#comment", label: "提交评论" } } },
    { tool: { name: "click", args: { target: "#alipay-label", label: "支付宝" } } },
    { text: "C 完成。" },
  ] },
  { match: ASK.d, steps: [{ tool: { name: "browser_run", args: { label: "付款", code: 'return await browser.click({ target: "#pay" });' } } }, { text: "D 完成。" }] },
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

    return { x: (q[0]! + q[2]!) / 2, y: (q[1]! + q[5]!) / 2 };
  };

  /** 提示在 closed shadow 里：用 CDP 穿透读文字、「知道了」的位置，以及有没有圈出按钮的外圈。 */
  const payNote = async () => {
    // SAFETY: pierce 模式下 DOM.getDocument 的 root 就是 DomNode 树。
    const root = (await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, work)).root as DomNode;
    const host = walk(root, n => n.nodeName === "DIV" && (n.attributes ?? []).join("\u0000").includes("data-sideagent-overlay\u0000pay-stop"));

    if (!host) return null;
    const ok = walk(host, n => n.nodeName === "BUTTON" && textOf(n).trim() === "知道了");
    const ring = !!walk(host, n => n.nodeName === "DIV" && (n.attributes ?? []).join("\u0000").includes("class\u0000ring"));

    try {
      return { text: textOf(host).replace(/\s+/g, " ").trim(), ring, ok: ok ? await center(ok) : null };
    } catch { return null; }
  };

  const userClick = async (at: { x: number; y: number }) => {
    await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y }, work);

    for (const type of ["mousePressed", "mouseReleased"]) await rp.cdp.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 }, work);
  };

  const answered = (text: string) => until(async () => (await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes(${JSON.stringify(text)}))`)) as boolean, 60_000, `回答「${text}」`);

  const ask = async (text: string) => { await rp.click(panel, "#input"); await rp.typeText(panel, text); await rp.pressEnter(panel); };

  const idle = async () => { await until(async () => !(await rp.evaluate(panel, 'document.querySelector("#send-btn").classList.contains("stopping")')), 10_000, "侧栏回到空闲", 50); await sleep(1000); };

  const lastRun = async () => (await rp.evaluate(panel, `(() => { const run = [...document.querySelectorAll(".run-steps")].at(-1); return run ? { title: run.querySelector(".run-title")?.textContent ?? "", steps: [...run.querySelectorAll(".chip:not(.prep)")].map(c => ({ text: c.querySelector(".chip-label")?.textContent ?? "", error: c.classList.contains("error") || !!c.querySelector(".act-failed") })) } : null; })()`)) as { title: string; steps: Array<{ text: string; error: boolean }> } | null;

  const panelShot = async (name: string) => { await rp.evaluate(panel, 'void ([...document.querySelectorAll(".run-steps")].at(-1)?.setAttribute("open", "")); true'); await sleep(300); await rp.screenshot(panel, join(out, name)); };

  const STOPPED = "停在付款前，等你自己点";

  const siteHost = `127.0.0.1:${siteAddress(site).port}`;

  // ── a/b：助手点付款按钮，同一轮点四次 ──
  let from = toolTexts.length;
  await ask(ASK.a);
  // 提示或付款请求，先到哪个算哪个：不拦付款时，这里看到的是 /pay。
  await until(async () => count("/pay") > 0 || (await payNote()), 30_000, "提示或付款请求", 100);
  await sleep(1500);
  const noteA = await payNote();
  check("a 助手点付款按钮：服务器 /pay 0 条，网页提示写网站和按钮名、圈出按钮", count("/pay") === 0 && !!noteA?.text.includes(`${siteHost} · 「${PAY_LABEL}」 这一步要你自己点`) && !!noteA.ok && noteA.ring, { pay: count("/pay"), note: noteA });
  await rp.screenshot(work, join(out, "a-page.png"));
  await answered("A 完成。");
  await idle();
  const toolA = toolTexts.slice(from);
  const runA = await lastRun();
  const textA = String(await rp.evaluate(panel, 'document.querySelector("#messages").textContent'));
  check("a 侧栏：那一步写「停在付款前，等你自己点」，不标失败", !!runA?.steps.some(s => s.text.includes(STOPPED)) && runA.steps.every(s => !s.error) && !runA.title.includes("没成功"), { run: runA });
  check("a 助手收到的结果：扩展不点付款按钮，用户自己点，不要换办法", toolA.length > 0 && toolA.every(t => t.includes("does not click payment buttons") && t.includes("do not press Enter")), { tool: toolA });
  check("b 同一轮再点三次：仍 0 条，不当成连续出错", count("/pay") === 0 && toolA.length === 4 && !/连续三次/.test(textA), { pay: count("/pay"), tools: toolA.length, threeInRow: /连续三次/.test(textA) });
  await panelShot("a-panel.png");

  // ── e：用户自己点付款按钮，再点「知道了」──
  const payBox = await rp.evaluate(work, '(() => { const r = document.querySelector("#pay").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()') as { x: number; y: number };
  const noteBeforeUser = !!(await payNote());
  await userClick(payBox);
  await until(async () => count("/pay") > 0, 10_000, "用户点付款后服务器收到", 100).catch(() => null);
  check("e 提示还在时用户自己点付款按钮：/pay 恰好 1 条", noteBeforeUser && count("/pay") === 1, { noteBeforeUser, pay: count("/pay") });
  const noteE = await payNote();
  if (noteE?.ok) await userClick(noteE.ok);
  await sleep(500);
  check("e 用户点「知道了」：提示收起", !!noteE?.ok && !(await payNote()), { hadButton: !!noteE?.ok });

  // ── c：普通按钮和付款方式单选项照常 ──
  await ask(ASK.c);
  await answered("C 完成。");
  await idle();
  const alipay = await rp.evaluate(work, 'document.querySelector("#alipay").checked');
  check("c 「下一步」「提交评论」服务器各 1 条，「支付宝」选中，/pay 不变", count("/next") === 1 && count("/comment") === 1 && alipay === true && count("/pay") === 1, { next: count("/next"), comment: count("/comment"), alipay: alipay as Json, pay: count("/pay") });

  // ── d：browser_run 去点付款按钮 ──
  from = toolTexts.length;
  await ask(ASK.d);
  await answered("D 完成。");
  await idle();
  const toolD = toolTexts.slice(from);
  check("d browser_run 点付款按钮：被拒绝，/pay 不增加", count("/pay") === 1 && toolD.some(t => t.includes("does not click payment buttons")), { pay: count("/pay"), tool: toolD });
  await panelShot("d-panel.png");
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ checks, posts, toolTexts, notCovered: ["按回车提交付款表单", "iframe 里的付款按钮", "没有可读名字的付款按钮", "browser.js 里的脚本直接调用元素的 click()", "真实网站"], modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(done => site.close(() => done()));
}

console.log(`证据：${out}`);

if (checks.some(c => !c.pass)) process.exitCode = 1;
