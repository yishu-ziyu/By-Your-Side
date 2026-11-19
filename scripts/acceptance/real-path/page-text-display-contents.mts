import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until, type Json } from "./harness.mts";
import { startScriptedModel, type Rule } from "./scripted-model.mts";

requireHeadless();

const out = process.env.OUT_DIR ?? join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-page-text-display-contents`);
await mkdir(out, { recursive: true });

const VISIBLE_TEXT = "这篇文章的正文放在 display contents 容器内部，应当被完整读到。";
const HIDDEN_TEXT = "这段隐藏文字不应出现在正文提取结果中。";
const CONTENTS_HIDDEN_TEXT = "这段在 visibility hidden 的 display contents 里也不应出现。";
const ANCESTOR_HIDDEN_CONTENTS = "这段被祖先 display none 包裹的 display contents 文本绝不应泄露。";
const FILLER = "这是用于保证页面无障碍树足够长的补充段落内容，说明文章正常渲染并且可见。".repeat(12);
const PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>容器测试页</title><body><div role="main"><div style="display:contents"><article><h1>测试文章</h1><p>${VISIBLE_TEXT}</p><p>${FILLER}</p><p style="display:none">${HIDDEN_TEXT}</p></article></div><div style="display:contents;visibility:hidden">${CONTENTS_HIDDEN_TEXT}</div></div></body></html>`;
const ANCESTOR_HIDDEN_PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>祖先隐藏测试页</title><body><div style="display:none"><article style="display:contents">${ANCESTOR_HIDDEN_CONTENTS}</article></div><section><h1>正常章节</h1><p>${VISIBLE_TEXT}</p><p>${FILLER}</p></section></body></html>`;

const site = createServer((req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(req.url === "/ancestor-hidden" ? ANCESTOR_HIDDEN_PAGE : PAGE));
await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
const baseUrl = `http://127.0.0.1:${siteAddress(site).port}`;
const pageUrl = `${baseUrl}/article`;

type Message = { role: string; content?: string | Array<{ text?: string }> | null };
const textOf = (m: Message) => Array.isArray(m.content) ? m.content.map(p => p.text ?? "").join("") : m.content ?? "";
const seenUserPrompts: string[] = [];

const rules: Rule[] = [
  { match: '"requests"', steps: [{ text: '{"scope":"local"}' }] },
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ items: [{ text: "读正文", done: true }], goalOnPage: true, pointedFound: true, status: "done", remaining: "", correction: "" }) }] },
  { match: "第一段写了什么", steps: [{ text: "正文已读到。" }] },
  { match: "第二页写了什么", steps: [{ text: "第二页已读到。" }] },
];
const model = await startScriptedModel(rules, undefined, payload => {
  const messages = (payload.messages ?? []) as Message[];
  for (const m of messages) {
    if (m.role === "user") seenUserPrompts.push(textOf(m));
  }
});

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: pageUrl }, work);
  await until(async () => await rp.evaluate(work, `document.body?.innerText.includes(${JSON.stringify(VISIBLE_TEXT)})`) || undefined, 15_000, "测试页加载");
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  const ready = 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false';
  await until(async () => await rp.evaluate(panel, ready), 60_000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);
  await rp.click(panel, "#input");
  await rp.typeText(panel, "第一段写了什么");
  await rp.pressEnter(panel);
  await until(async () => await rp.evaluate(panel, `document.querySelector("#messages")?.textContent.includes("正文已读到")`) || undefined, 30_000, "回答显示");

  const mainPrompt = seenUserPrompts.find(p => p.includes("[FRESH PAGE OBSERVATION")) ?? "";
  const marker = "[Accessibility tree of the same page";
  const hasMainAndTree = mainPrompt.includes(marker);
  const mainBlock = hasMainAndTree ? mainPrompt.split(marker)[0]! : "";
  check("display:contents 包裹的正文出现在预读主正文段", hasMainAndTree && mainBlock.includes(VISIBLE_TEXT), { hasMainAndTree, mainBlockLen: mainBlock.length });
  check("display:none 的隐藏文字未进入预读主正文段", !mainBlock.includes(HIDDEN_TEXT), { leaked: mainBlock.includes(HIDDEN_TEXT) });
  check("visibility:hidden 的 display:contents 文本未进入预读主正文段", !mainBlock.includes(CONTENTS_HIDDEN_TEXT), { leaked: mainBlock.includes(CONTENTS_HIDDEN_TEXT) });

  seenUserPrompts.length = 0;
  await rp.cdp.send("Page.navigate", { url: `${baseUrl}/ancestor-hidden` }, work);
  await until(async () => await rp.evaluate(work, `document.title === "祖先隐藏测试页"`) || undefined, 15_000, "第二页加载");
  await rp.cdp.send("Page.bringToFront", {}, work);
  await rp.click(panel, "#input");
  await rp.typeText(panel, "第二页写了什么");
  await rp.pressEnter(panel);
  await until(async () => await rp.evaluate(panel, `document.querySelector("#messages")?.textContent.includes("第二页已读到")`) || undefined, 30_000, "第二页回答显示");
  const secondPrompt = seenUserPrompts.filter(p => p.includes("[FRESH PAGE OBSERVATION")).at(-1) ?? "";
  check("祖先 display:none 包裹的 display:contents 根节点未泄露且读到可见正文", !secondPrompt.includes(ANCESTOR_HIDDEN_CONTENTS) && secondPrompt.includes(VISIBLE_TEXT), { leaked: secondPrompt.includes(ANCESTOR_HIDDEN_CONTENTS), hasVisible: secondPrompt.includes(VISIBLE_TEXT) });
} catch (error) {
  check("流程完成", false, String(error));
} finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", checks }, null, 2));
  await rp.close(); await rp.remove(); await model.close();
  await new Promise<void>(end => site.close(() => end()));
}

console.log(`证据：${out}`);
if (checks.some(c => !c.pass)) process.exitCode = 1;
