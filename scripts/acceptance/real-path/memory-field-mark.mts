/**
 * 按记忆填的那一格带「记得的」记号，点开小卡能「这次不用」「忘掉」（YIS-87）。真实模型，只装扩展，无头。
 *   EGO_ACCEPTANCE_CHROME=<Chrome for Testing> npx tsx scripts/acceptance/real-path/memory-field-mark.mts --headless [--model=provider/id]
 * 失败方式：按记忆填的邮箱没有记号；不是记忆的备注也带了记号；记号改了网页的值或留下属性；你自己改了这一格记号还在；
 *   「这次不用」没清空或删了记忆；「忘掉」没清空、记忆库里还在，或侧栏没写已忘掉。
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type JsonRecord } from "./harness.mts";
import { DEFAULT_TEST_MODEL, configureViaSettings, loadModelPlan, modelStorageItems } from "./inproc-config.mts";

requireHeadless();

const modelArg = process.argv.find((arg) => arg.startsWith("--model="))?.slice("--model=".length) ?? DEFAULT_TEST_MODEL;

const plan = await loadModelPlan(modelArg);

const email = `mark-${randomBytes(3).toString("hex")}@example.com`;

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-memory-field-mark`);

await mkdir(artifacts, { recursive: true });

const site = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><meta charset="utf-8"><title>报名表</title>
<style>body{font:16px system-ui;margin:40px} label{display:block;margin:14px 0} input{font:16px system-ui;width:320px;padding:8px 10px;border:1px solid #bbb;border-radius:6px}</style>
<h1>报名表</h1><label>邮箱 <input id="email" name="email" aria-label="邮箱"></label><label>备注 <input id="note" name="note" aria-label="备注"></label>`);
});

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const rp = await launchRealPath();

let error: string | null = null;

let panel = "";

let work = "";

const evidence: JsonRecord = { model: modelArg, email };

const idle = `document.querySelector("#send-btn")?.disabled === false && !document.querySelector("#status-pill")?.classList.contains("running") && !document.querySelector(".msg.assistant.streaming,.msg.assistant[data-revealing]")`;

const ask = async (text: string) => {
  await rp.click(panel, "#input");
  await rp.typeText(panel, text);
  await rp.pressEnter(panel);
  await sleep(1500);
  await until(async () => (await rp.evaluate(panel, idle)) || undefined, 180_000, `回答「${text.slice(0, 12)}」`, 500);
};

type PageView = { email: string; note: string; marks: string[]; leftover: number };

// SAFETY: 页面脚本返回与 PageView 一一对应的字段。
const page = () => rp.evaluate(work, `({ email: email.value, note: note.value,
  marks: [...document.querySelectorAll('[data-sideagent-overlay="memory-field"]')].map((h) => h.dataset.memoryId),
  leftover: document.querySelectorAll("[data-sideagent-memory-field]").length })`) as Promise<PageView>;

type DomNode = { nodeId: number; nodeName: string; nodeValue?: string; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] };

/** 记号画在封闭的影子层里（网页脚本读不到），用调试接口穿进去，真点里面的按钮。 */
const clickInMark = async (match: (attrs: Record<string, string>, text: string) => boolean, what: string) => {
  // SAFETY: CDP DOM.getDocument 返回带 nodeId / children / shadowRoots 的节点树。
  const { root } = await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, work) as { root: DomNode };
  const text = (n: DomNode): string => (n.nodeValue ?? "") + (n.children ?? []).map(text).join("");

  const walk = (n: DomNode): DomNode | undefined => {
    const attrs = Object.fromEntries((n.attributes ?? []).flatMap((v, i, a) => (i % 2 ? [] : [[v, a[i + 1]!]])));

    if (n.nodeName === "BUTTON" && match(attrs, text(n))) return n;

    for (const c of [...(n.shadowRoots ?? []), ...(n.children ?? [])]) { const hit = walk(c);

 if (hit) return hit; }

    return undefined;
  };

  const node = walk(root);

  if (!node) throw new Error(`记号里找不到「${what}」`);
  // SAFETY: CDP DOM.getBoxModel 的 content 是 8 个数的四边形。
  const { model } = await rp.cdp.send("DOM.getBoxModel", { nodeId: node.nodeId }, work) as { model: { content: number[] } };
  const [x1 = 0, y1 = 0, , , x3 = 0, y3 = 0] = model.content;
  const at = { x: (x1 + x3) / 2, y: (y1 + y3) / 2 };

  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await rp.cdp.send("Input.dispatchMouseEvent", { type, ...at, button: "left", clickCount: 1 }, work);
  await sleep(400);
};

/** 记忆库里生效的记忆原文。 */
const active = async (): Promise<string[]> => {
  // SAFETY: CDP Target.createTarget 的返回值带字符串 targetId。
  const target = (await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/voice-permission.html` })).targetId as string;

  try {
    const ext = await rp.attach(target);
    await until(async () => (await rp.evaluate(ext, `location.protocol === "chrome-extension:" && document.readyState === "complete"`)) || undefined, 10_000, "扩展页");

    // SAFETY: 页面脚本返回 kv 里 memories 的 JSON 文本。
    const raw = await rp.evaluate(ext, `new Promise((res, rej) => { const r = indexedDB.open("sideagent-memory"); r.onerror = () => rej(r.error);
      r.onsuccess = () => { const q = r.result.transaction("kv").objectStore("kv").get("memories"); q.onsuccess = () => res(q.result ?? ""); q.onerror = () => rej(q.error); }; })`) as string;

    // SAFETY: memories 键由扩展写入，形状是 { entries: [{ text, status }] }。
    return raw ? (JSON.parse(raw) as { entries: Array<{ text: string; status: string }> }).entries.filter((e) => e.status === "active").map((e) => e.text) : [];
  } finally {
    await rp.cdp.send("Target.closeTarget", { targetId: target }).catch(() => undefined);
    await rp.cdp.send("Target.activateTarget", { targetId: workTarget }).catch(() => undefined);
  }
};

/** 让助手按记忆把邮箱重新填一遍，等记号出来。 */
const refill = async () => {
  await rp.evaluate(work, `email.value = ""; true`);
  await ask("把当前网页报名表的邮箱一格重新填成我的邮箱。不用提交。");
  await until(async () => { const v = await page();

 return v.email === email && v.marks.length === 1 || undefined; }, 20_000, "邮箱重新填上并带记号");
};

let workTarget = "";

try {
  panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled === false`)) || undefined, 60_000, "侧栏就绪");

  if (plan.credential.type === "api_key") await configureViaSettings(rp, panel, plan);
  else await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(modelStorageItems(plan))}).then(() => true)`);

  await sleep(3000);
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#conversation-new")?.getAttribute("aria-busy") === "false" && ${idle}`)) || undefined, 60_000, "默认会话建好");

  await ask(`记住我的邮箱是 ${email}`);

  // SAFETY: CDP Target.createTarget 的返回值带字符串 targetId。
  const tab = (await rp.cdp.send("Target.createTarget", { url: `http://127.0.0.1:${siteAddress(site).port}/` })).targetId as string;
  await rp.cdp.send("Target.activateTarget", { targetId: tab });
  workTarget = tab;
  work = await rp.attach(tab);
  await sleep(1000);
  await ask("帮我填当前网页的报名表：邮箱填我的邮箱，备注写「第一次参加」。不用提交。");

  const filled = await until(async () => { const v = await page();

 return v.email && v.note ? v : undefined; }, 20_000, "两格都填上");

  await sleep(800);
  const view = await page();
  evidence.filled = view;
  await rp.screenshot(work, join(artifacts, "marked.png"));
  assert.equal(filled.email, email, "邮箱一格的值就是记住的邮箱，没有多余内容");
  assert.equal(view.marks.length, 1, "只有一格带记号（邮箱），备注没有");
  assert.equal(view.leftover, 0, "网页元素上没有留下记号属性");

  // 你自己在邮箱一格里打一个字（真实键盘输入）：记号消失。
  await rp.evaluate(work, `email.focus(); email.setSelectionRange(email.value.length, email.value.length); true`);
  await rp.cdp.send("Input.insertText", { text: "x" }, work);
  await sleep(500);
  const edited = await page();
  evidence.edited = edited;
  assert.equal(edited.marks.length, 0, "你改过这一格后记号消失");
  await rp.screenshot(work, join(artifacts, "edited.png"));

  // 点标签出小卡，点「这次不用」：这一格清空，记号消失，记忆还在。
  await refill();
  await clickInMark((a) => a.class === "tag", "记得的");
  await rp.screenshot(work, join(artifacts, "card.png"));
  await clickInMark((a) => a["data-action"] === "once", "这次不用");
  const once = await page();
  evidence.once = { ...once, memories: await active() };
  assert.equal(once.email, "", "「这次不用」清空这一格");
  assert.equal(once.marks.length, 0, "「这次不用」后记号消失");
  assert.ok((await active()).some((t) => t.includes(email)), "「这次不用」不删记忆");

  // 再填一次，点「忘掉」：这一格清空，记忆库里没有了，侧栏那一行写已忘掉。
  await refill();
  await clickInMark((a) => a.class === "tag", "记得的");
  await clickInMark((a) => a["data-action"] === "forget", "忘掉");
  await until(async () => (await page()).marks.length === 0 || undefined, 10_000, "「忘掉」后记号消失");
  const forgot = await page();
  const memories = await active();
  // SAFETY: 页面脚本返回字符串。
  const panelRow = await rp.evaluate(panel, `[...document.querySelectorAll('.memory-used-item[data-state="forgotten"]')].at(-1)?.innerText ?? ""`) as string;
  evidence.forgot = { ...forgot, memories, panelRow };
  await rp.screenshot(panel, join(artifacts, "panel-forgotten.png"));
  assert.equal(forgot.email, "", "「忘掉」清空这一格");
  assert.ok(!memories.some((t) => t.includes(email)), "「忘掉」后记忆库里没有这条");
  assert.match(panelRow, /已忘掉/, "侧栏那一行写已忘掉");
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);

  if (work) await rp.screenshot(work, join(artifacts, "failure-page.png")).catch(() => undefined);

  if (panel) await rp.screenshot(panel, join(artifacts, "failure-panel.png")).catch(() => undefined);
  evidence.panelText = panel ? await rp.evaluate(panel, `document.querySelector("#messages")?.innerText.slice(-1500)`).catch(() => null) : null;
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  site.closeAllConnections();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, evidence, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
