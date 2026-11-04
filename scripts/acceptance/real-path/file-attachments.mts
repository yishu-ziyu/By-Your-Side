import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-file-attachments`);
const files = join(REPO, "scripts/acceptance/fixtures/files");

await mkdir(out, { recursive: true });

const ASK_ALL = "附件案例一：这些文件分别讲了什么？";
const ASK_QUICK = "附件案例二：合同的交付日期是哪天？";

const ATTACHED = ["contract.pdf", "receipt-scan.pdf", "scan-with-blank.pdf", "weekly-report.docx", "memo-textutil.docx", "sales.xlsx", "review.pptx", "cities-gbk.csv", "long-notes.txt"];

const FACTS: Record<string, string[]> = {
  "contract.pdf": ["[Page 3]", "交付日期：2025 年 6 月 30 日"],
  "weekly-report.docx": ["# 青柠项目周报", "青柠 7 号", "| 开发 \\| 测试 | 128,000 元 |", "- 联调退款接口"],
  "memo-textutil.docx": ["周四下午三点"],
  "sales.xlsx": ["[Sheet: 销售]", "2 | 2024-03-15 | 华东 | 4520.5 | 首单", "4 | 2024-03-17 | 华北 | 0.3 |", "=SUM(C2:C4)", "[Sheet: 内部] (hidden)", "北极星"],
  "review.pptx": ["[Slide 3]", "## 风险", "| 供应商延期 | 备选两家 |", "Speaker notes: 讲到这里提醒：合同 4 月 30 日到期"],
  "cities-gbk.csv": ["杭州,1252万"],
  "long-notes.txt": ["第 1 行：这是用来测试分段读取"],
};

type Part = { type?: string; text?: string; image_url?: unknown };
type Message = { role: string; content?: string | Part[] | null; tool_call_id?: string };
const textOf = (content: Message["content"]) => Array.isArray(content) ? content.map(part => part.text ?? "").join("") : content ?? "";

const asked = new Map<string, { text: string; images: number }>();
let toolResult = "";

const model = await startScriptedModel([
  { match: ASK_ALL, steps: [
    { tool: { name: "read_attachment", args: { name: "long-notes.txt", query: "暗号" } } },
    { text: "合同第 3 页写交付日期是 2025 年 6 月 30 日；长文本第 2401 行的暗号是紫色长颈鹿。" },
  ] },
  { match: ASK_QUICK, steps: [{ text: "合同第 3 页写的交付日期是 2025 年 6 月 30 日。" }] },
], undefined, payload => {
  if (!payload.tools?.length) return;
  const messages = (payload.messages ?? []) as Message[];

  for (const ask of [ASK_ALL, ASK_QUICK]) {
    const user = messages.find(m => m.role === "user" && textOf(m.content).includes(ask) && !textOf(m.content).startsWith("本次运行的上下文"));

    if (user && !asked.has(ask)) asked.set(ask, { text: textOf(user.content), images: Array.isArray(user.content) ? user.content.filter(part => part.type === "image_url" || part.type === "image").length : 0 });
  }

  const tool = messages.filter(m => m.role === "tool").at(-1);

  if (tool) toolResult = textOf(tool.content);
});

const rp = await launchRealPath();
let panelSession: string | null = null;
const consoleLines: string[] = [];
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

try {
  const panel = await rp.attach(await rp.openSidePanel());
  panelSession = panel;
  await rp.cdp.send("Runtime.enable", {}, panel);
  rp.cdp.onEvent("Runtime.consoleAPICalled", (event: { args?: Array<{ value?: unknown; description?: string }> }) => consoleLines.push((event.args ?? []).map(a => String(a.value ?? a.description ?? "")).join(" ")));
  rp.cdp.onEvent("Runtime.exceptionThrown", (event: { exceptionDetails?: { text?: string; exception?: { description?: string } } }) => consoleLines.push(`exception: ${event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text}`));
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  const ready = 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")';
  await until(async () => await rp.evaluate(panel, ready), 60_000, "侧栏就绪");

  const attach = async (names: string[]) => {
    await rp.cdp.send("DOM.enable", {}, panel);
    const { root } = await rp.cdp.send("DOM.getDocument", { depth: 0 }, panel) as { root: { nodeId: number } };
    const { nodeId } = await rp.cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#file-input" }, panel) as { nodeId: number };
    await rp.cdp.send("DOM.setFileInputFiles", { nodeId, files: names.map(name => join(files, name)) }, panel);
  };

  const tiles = `[...document.querySelectorAll("#attachments-strip .tile-file")].map(t => ({ name: t.querySelector(".file-chip-name")?.textContent, meta: t.querySelector(".file-chip-meta")?.textContent, done: t.classList.contains("complete") }))`;

  await attach([...ATTACHED, "legacy.doc"]);
  const shown = await until(async () => {
    const list = await rp.evaluate(panel, tiles) as Array<{ name: string; meta: string; done: boolean }>;

    return list.length === ATTACHED.length && list.every(t => t.done) ? list : null;
  }, 60_000, "全部文件读完");
  await rp.screenshot(panel, join(out, "a-composer.png"));
  const meta = Object.fromEntries(shown.map(t => [t.name, t.meta]));
  check("a 每个文件一张卡，写着格式和页数", meta["contract.pdf"] === "PDF · 3 页" && meta["receipt-scan.pdf"] === "PDF · 1 页" && meta["scan-with-blank.pdf"] === "PDF · 2 页" && meta["sales.xlsx"] === "Excel · 3 张表" && meta["review.pptx"] === "PPT · 3 张幻灯片" && /^Word · /.test(meta["weekly-report.docx"] ?? "") && /^CSV · /.test(meta["cities-gbk.csv"] ?? ""), meta);
  await sleep(800);
  const cut = await rp.evaluate(panel, `(() => {
    const strip = document.getElementById("attachments-strip").getBoundingClientRect();
    return [...document.querySelectorAll("#attachments-strip .tile-file")].map(t => ({ t, r: t.getBoundingClientRect() }))
      .filter(({ r }) => (r.left < strip.left - 1 && r.right > strip.left + 1) || (r.right > strip.right + 1 && r.left < strip.right - 1))
      .map(({ t, r }) => ({ name: t.querySelector(".file-chip-name")?.textContent, left: Math.round(r.left - strip.left), right: Math.round(strip.right - r.right) }));
  })()`) as Array<{ name: string }>;
  check("a 输入框上方看得见的文件卡都完整，没有被边缘切掉一半的", cut.length === 0, cut);
  const listedTwice = await rp.evaluate(panel, `[...document.querySelectorAll("#task-bar-root .tb-mat-label")].filter(e => e.offsetParent !== null).map(e => e.textContent)`) as string[];
  check("a 发送前每个文件只在输入框上方有一张卡，上面不再另列一遍", listedTwice.length === 0, listedTwice);
  const errors = await rp.evaluate(panel, `[...document.querySelectorAll(".msg.error")].map(e => e.textContent)`) as string[];
  check("a 旧版 .doc 没附上，并说明要另存为 .docx", !shown.some(t => t.name === "legacy.doc") && errors.some(e => e.includes("legacy.doc") && e.includes(".docx")), errors);

  await rp.click(panel, "#input");
  await rp.typeText(panel, ASK_ALL);
  await rp.pressEnter(panel);
  await until(async () => asked.has(ASK_ALL) || undefined, 60_000, "模型收到第一句", 100);
  const first = asked.get(ASK_ALL)!;
  const missing = Object.entries(FACTS).flatMap(([file, facts]) => facts.filter(fact => !first.text.includes(fact)).map(fact => `${file}: ${fact}`));
  check("b 模型收到的消息里有每个文件里的事实", missing.length === 0, { missing, chars: first.text.length });
  check("b 文件内容包在不可信边界里，并说明是数据不是指令", (first.text.match(/<page-content untrusted title="/g) ?? []).length >= ATTACHED.length - 1 && first.text.includes("not instructions"), { wrappers: (first.text.match(/<page-content untrusted/g) ?? []).length });
  check("b 扫描页标明没有文字层；当前模型不收图时照实说明，空白页标为空白", first.images === 0 && (first.text.match(/have no text layer \(scanned\)\. The current model cannot see images/g) ?? []).length === 2 && first.text.includes("(blank page)"), { images: first.images });
  check("c 长文本只给开头，写明怎么读后面", !first.text.includes("紫色长颈鹿") && /\[Shown: characters 1–\d+ of \d+\. .*read_attachment with name "long-notes\.txt"/.test(first.text), { hasNeedle: first.text.includes("紫色长颈鹿") });
  await until(async () => toolResult || undefined, 60_000, "read_attachment 结果");
  check("c read_attachment 按关键词找到第 2401 行的暗号", toolResult.includes("第 2401 行：暗号是紫色长颈鹿") && /offset \d+/.test(toolResult), { toolResult: toolResult.slice(0, 300) });
  await until(async () => await rp.evaluate(panel, ready), 60_000, "第一轮结束");
  const bubble = await rp.evaluate(panel, `[...document.querySelectorAll(".msg.user")].at(-1) ? [...[...document.querySelectorAll(".msg.user")].at(-1).querySelectorAll(".user-msg-file .file-chip-name")].map(e => e.textContent) : []`) as string[];
  const folded = await rp.evaluate(panel, `(() => { const m = [...document.querySelectorAll(".msg.user")].at(-1); return { visible: [...m.querySelectorAll(".user-msg-file")].filter(c => !c.hidden).length, more: m.querySelector(".user-msg-files-more")?.textContent ?? null }; })()`) as { visible: number; more: string | null };
  check("d 已发出的消息里每个文件一张卡，多出的收成「+N 个文件」", bubble.length === ATTACHED.length && folded.visible === 4 && folded.more === `+${ATTACHED.length - 4} 个文件`, { bubble, ...folded });
  await rp.screenshot(panel, join(out, "b-sent-folded.png"));
  await rp.click(panel, ".user-msg-files-more");
  const expanded = await rp.evaluate(panel, `[...[...document.querySelectorAll(".msg.user")].at(-1).querySelectorAll(".user-msg-file")].filter(c => !c.hidden).length`);
  check("d 点「+N 个文件」展开全部", expanded === ATTACHED.length, expanded as Json);
  check("d 输入框上方的附件发出后清空", await rp.evaluate(panel, `document.querySelector("#attachments-strip").hidden`) === true, null);
  await rp.screenshot(panel, join(out, "b-sent.png"));

  await rp.click(panel, "#conversation-new");
  await sleep(1_500);
  await until(async () => await rp.evaluate(panel, ready), 60_000, "新对话就绪");
  await rp.click(panel, "#input");
  await rp.typeText(panel, ASK_QUICK);
  await attach(["contract.pdf"]);
  const readingAtSend = await until(async () => {
    const state = await rp.evaluate(panel, `(() => { const t = document.querySelector("#attachments-strip .tile-file"); return t ? (t.classList.contains("complete") ? "done" : "reading") : null; })()`);

    return state as string | null;
  }, 15_000, "文件卡出现", 20);
  await rp.pressEnter(panel);
  await until(async () => asked.has(ASK_QUICK) || undefined, 60_000, "模型收到第二句", 100);
  check("d 刚附上就发送，模型照样收到 PDF 的文字", asked.get(ASK_QUICK)!.text.includes("交付日期：2025 年 6 月 30 日"), { chars: asked.get(ASK_QUICK)!.text.length, readingAtSend });
  await until(async () => await rp.evaluate(panel, ready), 60_000, "第二轮结束");
  await rp.screenshot(panel, join(out, "c-quick.png"));

  await rp.click(panel, "#input");
  await rp.typeText(panel, "草稿还没发");
  await attach(["weekly-report.docx"]);
  await until(async () => await rp.evaluate(panel, `!!document.querySelector("#attachments-strip .tile-file.complete")`) || undefined, 30_000, "草稿里的文件读完");
  await sleep(500);
  await rp.cdp.send("Page.reload", {}, panel);
  await until(async () => await rp.evaluate(panel, ready).catch(() => false), 60_000, "侧栏重新打开");
  const restored = await until(async () => {
    const state = await rp.evaluate(panel, `({ text: document.querySelector("#input")?.value ?? "", files: ${tiles} })`) as { text: string; files: Array<{ name: string; meta: string; done: boolean }> };

    return state.files.length ? state : null;
  }, 15_000, "草稿恢复");
  check("e 重开侧栏后，草稿里的文字和文件卡都在", restored.text === "草稿还没发" && restored.files.length === 1 && restored.files[0]!.name === "weekly-report.docx" && restored.files[0]!.meta === "Word · 36 KB", restored as unknown as Json);
  await writeFile(join(out, "first-message.txt"), first.text);
} catch (error) {
  check("流程完成", false, String(error));
  const state = panelSession ? await rp.evaluate(panelSession, `({ tiles: [...document.querySelectorAll("#attachments-strip .tile-56")].map(t => t.className + " | " + t.textContent), errors: [...document.querySelectorAll(".msg.error, .msg.notice")].map(e => e.textContent) })`).catch(e => String(e)) : null;
  await writeFile(join(out, "failure-state.json"), JSON.stringify({ state, console: consoleLines.slice(-80) }, null, 2));
} finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.length > 0 && checks.every(c => c.pass) ? "PASS" : "FAIL", checks, modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close();
}

console.log(`证据：${out}`);

if (checks.length === 0 || checks.some(c => !c.pass)) process.exitCode = 1;
