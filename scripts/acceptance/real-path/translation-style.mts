/**
 * 翻译风格：只装扩展的隔离无头 Chrome、真侧栏、真设置页、本机练习页与本机脚本模型（看翻译请求的系统提示词）。
 * a 默认风格：翻译请求只有原来的翻译提示词，不带任何风格说明。
 * b 在设置页「网页体验 → 翻译」点「贴近原文」：还原后再翻，翻译请求带上这种风格；换了风格重新请求，不用旧译文。
 * c 选「自定义」写一句要求并保存：再翻时请求原样带上用户这句话。
 *   npx tsx scripts/acceptance/real-path/translation-style.mts --headless
 * 证据在 out/acceptance/real-path/<时间>-translation-style/：设置页截图和 result.json。
 */
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchRealPath, requireHeadless, REPO, siteAddress, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-translation-style`);
await mkdir(out, { recursive: true });
const PARAGRAPHS = Array.from({ length: 6 }, (_, i) => `<p>Paragraph ${i + 1} explains how full duplex voice lets both people talk at the same time.</p>`).join("");
const site = createServer((_q, r) => r.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end(`<!doctype html><meta charset="utf-8"><title>Duplex notes</title><h1>Full duplex voice</h1>${PARAGRAPHS}`));
await new Promise<void>(r => site.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${siteAddress(site).port}/`;
const prompts: string[] = [];
const textOf = (content: unknown) => typeof content === "string" ? content : Array.isArray(content) ? content.map(part => (part as { text?: string }).text ?? "").join("") : "";
const model = await startScriptedModel([
  { match: "把这个页面翻译成中文", steps: [{ tool: { name: "page_translation", args: { action: "translate" } } }, { text: "已把这页翻译成中文。" }] },
  { match: "译文还原一下", steps: [{ tool: { name: "page_translation", args: { action: "restore" } } }, { text: "已还原成原文。" }] },
], { delayMs: 300 }, payload => {
  const system = textOf(payload.messages?.find(m => m.role === "system")?.content);

  if (system.startsWith("Translate the supplied webpage text")) prompts.push(system);
});
const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };
const CUSTOM = "术语保留英文，语气口语一点";

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: origin }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);

  const count = (answer: string) => rp.evaluate(panel, `document.body.innerText.split(${JSON.stringify(answer)}).length`) as Promise<number>;
  const say = async (text: string, answer: string) => {
    const seen = await count(answer);
    await rp.click(panel, "#input"); await rp.typeText(panel, text); await rp.pressEnter(panel);
    await until(async () => (await count(answer)) > seen || null, 60000, `侧栏出现「${answer}」`);
    await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || null, 30000, "侧栏回到空闲");
  };
  /** 翻一遍再还原，返回这一遍新发的翻译请求的提示词。 */
  const translateOnce = async () => {
    const before = prompts.length;
    await say("把这个页面翻译成中文。", "已把这页翻译成中文。");
    await say("译文还原一下", "已还原成原文。");

    return prompts.slice(before);
  };

  const a = await translateOnce();
  check("a 默认风格：请求只带原来的翻译提示词", a.length > 0 && a.every(p => !p.includes("Style:")), { requests: a.length, withStyle: a.filter(p => p.includes("Style:")).length });

  const settings = await rp.attach((await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/settings.html#preferences`, background: true })).targetId);
  await until(async () => await rp.evaluate(settings, '!!document.querySelector(\'[data-translation-style="faithful"]\')').catch(() => false) || null, 15000, "设置页出现翻译风格");
  await rp.evaluate(settings, 'document.querySelector("#translation-style-list").scrollIntoView({ block: "center" }); true');
  await rp.click(settings, '[data-translation-style="faithful"]');
  await until(async () => await rp.evaluate(settings, 'chrome.storage.local.get("translation_style").then(s => s.translation_style?.id === "faithful")') || null, 5000, "贴近原文已保存");
  await rp.screenshot(settings, join(out, "b-settings-faithful.png"));
  const b = await translateOnce();
  check("b 贴近原文：换了风格重新请求，请求带上这种风格", b.length > 0 && b.every(p => p.includes("Stay close to the source")), { requests: b.length, faithful: b.filter(p => p.includes("Stay close to the source")).length });

  await rp.click(settings, '[data-translation-style="custom"]');
  await rp.click(settings, "#translation-style-text"); await rp.typeText(settings, CUSTOM);
  await rp.click(settings, "#translation-style-save");
  await until(async () => await rp.evaluate(settings, `chrome.storage.local.get("translation_style").then(s => s.translation_style?.text === ${JSON.stringify(CUSTOM)})`) || null, 5000, "自定义风格已保存");
  await rp.screenshot(settings, join(out, "c-settings-custom.png"));
  const c = await translateOnce();
  check("c 自定义：请求原样带上用户写的要求", c.length > 0 && c.every(p => p.includes(CUSTOM)), { requests: c.length, custom: c.filter(p => p.includes(CUSTOM)).length });
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "pass" : "fail", checks, dependency: "real isolated extension, side panel and settings page, local page; scripted model" }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(r => site.close(() => r()));
}

console.log(JSON.stringify({ status: checks.every(c => c.pass) ? "pass" : "fail", out }));
if (checks.some(c => !c.pass)) process.exitCode = 1;
