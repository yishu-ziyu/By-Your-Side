import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-memory-forget-windows`);
await mkdir(out, { recursive: true });
const email = "demo@example.test", text = `邮箱：${email}`, id = "memory-window-email";
const asks = ["练习一：用我的邮箱填写注册表单。", "练习二：用我的邮箱填写注册表单。"];
const model = await startScriptedModel(asks.map(ask => ({
  match: ask, steps: [{ tool: { name: "fill", args: { target: "#email", value: email } } }, { text: `已按照你说过的邮箱 ${email} 填写。` }],
})));
const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end('<!doctype html><title>注册练习</title><h1>注册练习</h1><p>这是本机练习页面，请填写邮箱。</p><label>邮箱 <input id="email" type="email" style="width:300px;height:40px"></label>'));
await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${siteAddress(site).port}`;
const rp = await launchRealPath();
const result: Record<string, unknown> = {};
let ext = "", panel1 = "", panel2 = "", work1 = "", work2 = "";
let stage = "初始化";
const trace: unknown[] = [];
const checkpoint = async (label: string) => {
  const panels = (await rp.targets()).filter(t => t.url.startsWith(`chrome-extension://${rp.extensionId}/sidepanel.html`)).map(t => t.targetId);
  const windowOf = async (session: string) => session ? await rp.evaluate(session, "chrome.windows.getCurrent().then(w => w.id)").catch(error => String(error)) : null;
  trace.push({ label, panels, first: await windowOf(panel1), second: await windowOf(panel2) });
};
const idbOpen = `async () => {
  const exists = (await indexedDB.databases()).some(d => d.name === "sideagent-memory");
  return await new Promise((res, rej) => { const r = exists ? indexedDB.open("sideagent-memory") : indexedDB.open("sideagent-memory", 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains("kv")) r.result.createObjectStore("kv"); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}`;
const readMemories = `(async () => { const db = await (${idbOpen})(); const r = await new Promise((ok, no) => { const q = db.transaction("kv").objectStore("kv").get("memories"); q.onsuccess = () => ok(q.result ?? null); q.onerror = () => no(q.error); }); db.close(); return r; })()`;
const ready = 'document.querySelector("#conversation-new")?.disabled === false && document.querySelector("#send-btn")?.disabled === false && !document.querySelector("#send-btn")?.classList.contains("stopping")';
try {
  const blank = (await rp.targets()).find(t => t.url === "about:blank")!;
  work1 = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.navigate", { url: `${url}/one` }, work1);
  const helper = (await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/voice-permission.html`, background: true })).targetId;
  ext = await rp.attach(helper);
  await until(() => rp.evaluate(ext, 'document.readyState === "complete" && !!chrome.windows && !!chrome.storage?.local'), 10_000, "扩展页就绪");
  const now = Date.now();
  const memory = { id, factId: id, version: 1, text, scope: { kind: "all" }, sourceConversationId: "seed", createdAt: now - 60000, updatedAt: now - 60000, kind: "profile", status: "active", sourceQuote: text, useCount: 0, formatVersion: 3 };
  const docs = { memories: { format: 3, rev: 1, entries: [memory] }, tasks: { format: 1, tasks: [] } };
  await rp.evaluate(ext, `(async () => { const db = await (${idbOpen})(); const tx = db.transaction("kv", "readwrite"); const data = ${JSON.stringify(docs)}; for (const [k,v] of Object.entries(data)) tx.objectStore("kv").put(JSON.stringify(v)+"\\n", k); await new Promise((ok,no) => { tx.oncomplete = ok; tx.onerror = no; }); db.close(); return true; })()`);
  await rp.evaluate(ext, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(() => true)`);
  const win1 = Number(await rp.evaluate(ext, "chrome.windows.getCurrent().then(w => w.id)"));
  panel1 = await rp.attach(await rp.openSidePanel(win1));
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel1);
  await until(() => rp.evaluate(panel1, ready), 60_000, "第一个侧栏就绪");
  const win2 = Number(await rp.evaluate(ext, `chrome.windows.create({url:${JSON.stringify(`${url}/two`)},focused:false}).then(w => w.id)`));
  const secondTarget = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === `${url}/two`), 15_000, "第二个窗口");
  work2 = await rp.attach(secondTarget.targetId);
  const before = new Set((await rp.targets()).filter(t => t.url.startsWith(`chrome-extension://${rp.extensionId}/sidepanel.html`)).map(t => t.targetId));
  await rp.openSidePanel(win2);
  const secondPanel = await until(async () => (await rp.targets()).find(t => t.url.startsWith(`chrome-extension://${rp.extensionId}/sidepanel.html`) && !before.has(t.targetId)), 15_000, "第二个侧栏");
  panel2 = await rp.attach(secondPanel.targetId);
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel2);
  await until(() => rp.evaluate(panel2, ready), 60_000, "第二个侧栏就绪");
  await checkpoint("两侧栏已就绪");
  const turn = async (panel: string, work: string, ask: string) => {
    await rp.cdp.send("Page.bringToFront", {}, work);
    await rp.click(panel, "#input"); await rp.typeText(panel, ask); await rp.pressEnter(panel);
    await until(() => rp.evaluate(panel, `!!document.querySelector('.memory-used-item[data-used-id="${id}"]') && document.body.innerText.includes(${JSON.stringify(email)}) && ${ready}`), 60_000, "回答中点名邮箱记忆");
    await until(() => rp.evaluate(work, `document.querySelector("#email")?.value === ${JSON.stringify(email)} && !!document.querySelector('[data-sideagent-overlay="memory-field"]')`), 15_000, "网页显示来自记忆");
  };
  stage = "第一窗口填写";
  await turn(panel1, work1, asks[0]!);
  await checkpoint("第一窗口填写完成");
  stage = "确认第二个侧栏看到同一条记忆";
  await until(() => rp.evaluate(panel2, `!!document.querySelector('.memory-used-item[data-used-id="${id}"]')`), 15_000, "第二个侧栏展示记忆");
  await checkpoint("两个侧栏都显示记忆");
  stage = "读取两个窗口";
  result.before = {
    first: await rp.evaluate(panel1, `document.querySelector('.memory-used-item[data-used-id="${id}"]')?.innerText`),
    second: await rp.evaluate(panel2, `document.querySelector('.memory-used-item[data-used-id="${id}"]')?.innerText`),
    firstValue: await rp.evaluate(work1, 'document.querySelector("#email").value'),
    secondValue: await rp.evaluate(work2, 'document.querySelector("#email").value'),
  };
  type Node = { nodeName: string; nodeValue?: string; backendNodeId: number; attributes?: string[]; children?: Node[]; shadowRoots?: Node[] };
  const walk = (n: Node, pred: (v: Node) => boolean): Node | undefined => pred(n) ? n : [...(n.children ?? []), ...(n.shadowRoots ?? [])].map(child => walk(child, pred)).find(Boolean);
  const nodeText = (n: Node): string => n.nodeName === "STYLE" ? "" : (n.nodeValue ?? "") + [...(n.children ?? []), ...(n.shadowRoots ?? [])].map(nodeText).join("");
  const overlay = async () => {
    const root = (await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, work1)).root as Node;
    return walk(root, n => (n.attributes ?? []).join("\u0000").includes("data-sideagent-overlay\u0000memory-field"));
  };
  const clickNode = async (n: Node) => {
    const q = (await rp.cdp.send("DOM.getBoxModel", { backendNodeId: n.backendNodeId }, work1)).model.border as number[];
    const x = (q[0]! + q[2]!) / 2, y = (q[1]! + q[5]!) / 2;
    await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, work1);
    for (const type of ["mousePressed", "mouseReleased"]) await rp.cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }, work1);
  };
  const host = await until(overlay, 10_000, "记忆标记");
  const tag = walk(host, n => n.nodeName === "BUTTON" && nodeText(n).trim() === "来自记忆");
  if (!tag) throw new Error("没有找到记忆标签");
  await rp.cdp.send("Page.bringToFront", {}, work1);
  await clickNode(tag);
  const opened = await until(async () => { const n = await overlay(); return n && walk(n, v => v.nodeName === "BUTTON" && nodeText(v).trim() === "忘记"); }, 10_000, "忘记按钮");
  await clickNode(opened);
  await sleep(2500);
  const remains = await overlay();
  const raw = String(await rp.evaluate(ext, readMemories));
  const entries = JSON.parse(raw).entries as Array<{ id: string; status: string }>;
  const after = {
    field: await rp.evaluate(work1, 'document.querySelector("#email").value'),
    overlay: remains ? nodeText(remains).replace(/\s+/g, " ").trim() : null,
    active: entries.some(entry => entry.id === id && entry.status === "active"),
    first: String(await rp.evaluate(panel1, `document.querySelector('.memory-used-item[data-used-id="${id}"]')?.innerText`)),
    second: String(await rp.evaluate(panel2, `document.querySelector('.memory-used-item[data-used-id="${id}"]')?.innerText`)),
  };
  result.after = after;
  await rp.screenshot(work1, join(out, "page.png"));
  if (after.field === "" && after.overlay === null && !after.active && after.first.includes("已忘记") && after.second.includes("已忘记") && !after.first.includes("没能忘记") && !after.second.includes("没能忘记")) {
    await rp.evaluate(panel1, `(() => { const item = document.querySelector('.memory-used-item[data-used-id="${id}"]'); const undo = [...item.querySelectorAll('button')].find(b => b.textContent.trim() === '撤销'); if (!undo) return false; undo.setAttribute('data-forget-undo-test', '1'); return true; })()`);
    await rp.click(panel1, "[data-forget-undo-test]");
    await until(async () => {
      const raw = await rp.evaluate(ext, readMemories) as string;
      return JSON.parse(raw).entries.some((entry: { id: string; status: string }) => entry.id === id && entry.status === "active");
    }, 20_000, "撤销后记忆已恢复");
    result.restored = true;
    await until(() => rp.evaluate(panel1, `!![...document.querySelectorAll('.memory-used-item[data-used-id="${id}"] button')].find(b => b.textContent.trim() === '忘记')`), 10_000, "撤销后可再次忘记");
    await rp.evaluate(panel1, `(() => { const item = document.querySelector('.memory-used-item[data-used-id="${id}"]'); const button = [...item.querySelectorAll('button')].find(b => b.textContent.trim() === '忘记'); button.setAttribute('data-forget-again-test', '1'); return true; })()`);
    await rp.click(panel1, "[data-forget-again-test]");
    await until(async () => {
      const raw = await rp.evaluate(ext, readMemories) as string;
      return !JSON.parse(raw).entries.some((entry: { id: string; status: string }) => entry.id === id && entry.status === "active") && await rp.evaluate(panel1, `document.querySelector('.memory-used-item[data-used-id="${id}"]')?.innerText.includes('已忘记')`);
    }, 20_000, "侧栏普通忘记成功");
    result.forgotAgain = true;
  }
} catch (error) {
  result.error = String(error);
  result.stage = stage;
  await checkpoint("发生错误").catch(() => {});
  result.trace = trace;
  result.modelRequests = model.requests.map(r => ({ rule: r.rule, step: r.step, tools: r.tools }));
  if (panel1) result.panel1 = await rp.evaluate(panel1, 'document.querySelector("#messages")?.innerText?.slice(-1200)').catch(() => null);
  if (panel2) result.panel2 = await rp.evaluate(panel2, 'document.querySelector("#messages")?.innerText?.slice(-1200)').catch(() => null);
}
finally {
  await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(resolve => site.close(() => resolve()));
}
const after = result.after as { field?: string; overlay?: string | null; active?: boolean; first?: string; second?: string } | undefined;
const pass = !result.error && after?.field === "" && after.overlay === null && after.active === false && !!after.first?.includes("已忘记") && !!after.second?.includes("已忘记") && !after.first.includes("没能忘记") && !after.second.includes("没能忘记") && result.restored === true && result.forgotAgain === true;
console.log(pass ? "PASS" : "FAIL", JSON.stringify(result), out);
if (!pass) process.exitCode = 1;
