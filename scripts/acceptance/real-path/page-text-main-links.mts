import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until, type Json } from "./harness.mts";
import { startScriptedModel, type Rule } from "./scripted-model.mts";

requireHeadless();

const out = process.env.OUT_DIR ?? join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-page-text-main-links`);
await mkdir(out, { recursive: true });

const PROOF_URL = "https://author-site.example.test/research/proof.pdf";
const MANY_PARAS = Array.from({ length: 180 }, (_, i) => `<p>正文第 ${i + 1} 段：介绍研究背景与思考过程。<button type="button">点赞 ${i + 1}</button>${i < 30 ? ` <a href="/tag-${i + 1}">站内标签 ${i + 1}</a>` : ""}</p>`).join("");
const PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>作者专栏</title><body><article><h1>作者专栏</h1>${MANY_PARAS}<p>完整推导请见我的 <a href="${PROOF_URL}">mathematical proof</a>，以及 <a href="#top">返回顶部</a>。</p><div style="display:none"><a href="https://hidden.example.test/secret">隐藏链接</a></div></article></body></html>`;

const site = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE);
});
await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
const baseUrl = `http://127.0.0.1:${siteAddress(site).port}`;

type Message = { role: string; content?: string | Array<{ text?: string }> | null };
const textOf = (m: Message) => Array.isArray(m.content) ? m.content.map(p => p.text ?? "").join("") : m.content ?? "";
let obsPrompt = "";

const rules: Rule[] = [
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ items: [{ text: "回答问题", done: true }], goalOnPage: true, pointedFound: true, status: "done", remaining: "", correction: "" }) }] },
  { match: "作者的个人站链接是什么", steps: [{ text: "已查到作者链接。" }] },
];

const model = await startScriptedModel(rules, undefined, payload => {
  for (const m of (payload.messages ?? []) as Message[]) {
    const t = textOf(m);
    if (m.role === "user" && t.includes("[FRESH PAGE OBSERVATION")) obsPrompt = t;
  }
});

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `${baseUrl}/post` }, work);
  await until(async () => await rp.evaluate(work, `document.body?.innerText.includes("mathematical proof")`) || undefined, 15_000, "文章页加载");
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  const ready = 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false';
  await until(async () => await rp.evaluate(panel, ready), 60_000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);
  await rp.click(panel, "#input"); await rp.typeText(panel, "作者的个人站链接是什么"); await rp.pressEnter(panel);
  await until(async () => await rp.evaluate(panel, `document.querySelector("#messages")?.textContent.includes("已查到作者链接")`) || undefined, 30_000, "回答显示");

  check("正文尾部的可见外链 URL 在控件树截断后仍随首轮预读带给模型", obsPrompt.includes("[Links in main text]") && obsPrompt.includes(PROOF_URL) && obsPrompt.includes("mathematical proof"), { hasSection: obsPrompt.includes("[Links in main text]"), hasUrl: obsPrompt.includes(PROOF_URL), treeTruncated: obsPrompt.includes("Accessibility tree shortened"), obsLen: obsPrompt.length });
  check("隐藏元素里的链接不会泄露且不破坏原句连续文本", !obsPrompt.includes("hidden.example.test") && obsPrompt.includes("完整推导请见我的 mathematical proof，以及 返回顶部。"), { leakedHidden: obsPrompt.includes("hidden.example.test"), verbatimIntact: obsPrompt.includes("完整推导请见我的 mathematical proof，以及 返回顶部。") });
} catch (error) {
  check("流程完成", false, String(error));
} finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", checks }, null, 2));
  await rp.close(); await rp.remove(); await model.close();
  await new Promise<void>(end => site.close(() => end()));
}

console.log(`证据：${out}`);
if (checks.some(c => !c.pass)) process.exitCode = 1;
