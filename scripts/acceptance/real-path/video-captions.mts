/**
 * 用户问「获得当前视频的字幕」：助手从播放器自己那里读到这个视频有哪些字幕，没有就直说没有，
 * 不再自己拼接口（B 站对不带签名的请求回别的视频的字幕，那次绕了 4–9 分钟）。
 * 只装扩展、隔离构建、本机脚本模型、本机视频页：
 *   /none：页面加载时自己调了带签名的播放器接口，字幕清单为空；视频没有字幕轨道。
 *   /with：视频带一条中文字幕轨道。
 *   npx tsx scripts/acceptance/real-path/video-captions.mts --headless
 *   a) /none 上读字幕：结果写明播放器自己的字幕清单是 0 条、这个视频没有字幕，并说出是哪条播放器请求。
 *   b) /with 上读字幕：结果列出中文字幕轨道和它的地址。
 * 失败方式：没有 video_captions，模型只能自己拼接口，a、b 都拿不到结论。
 */
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-video-captions`);

await mkdir(out, { recursive: true });

const NONE = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>没有字幕的视频</title><body><h1>访谈</h1><video width="320" height="180"></video>
<script>fetch("/x/player/wbi/v2?aid=1&cid=2&w_rid=signed").then(r => r.json()).then(j => { document.title = "没有字幕的视频 · " + j.data.subtitle.subtitles.length; });</script></body></html>`;
const WITH = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>有字幕的视频</title><body><h1>讲座</h1><video width="320" height="180"><track kind="subtitles" src="/subs.vtt" srclang="zh" label="中文"></video></body></html>`;
const site = createServer((req, res) => {
  if (req.url?.startsWith("/x/player/wbi/v2")) return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ code: 0, data: { subtitle: { allow_submit: false, subtitles: [] } } }));
  if (req.url === "/subs.vtt") return void res.writeHead(200, { "content-type": "text/vtt" }).end("WEBVTT\n\n00:00.000 --> 00:02.000\n大家好\n");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(req.url?.startsWith("/with") ? WITH : NONE);
});

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const ASK_NONE = "字幕核对一：获得当前视频的字幕";
const ASK_WITH = "字幕核对二：获得当前视频的字幕";
const results: Record<string, string> = {};
const textOf = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? "").join("") : "";
const model = await startScriptedModel([
  { match: ASK_NONE, steps: [{ tool: { name: "video_captions", args: {} } }, { text: "第一个视频读完了。" }] },
  { match: ASK_WITH, steps: [{ tool: { name: "video_captions", args: {} } }, { text: "第二个视频读完了。" }] },
], undefined, payload => {
  const messages = payload.messages ?? [];
  const tool = messages.filter(m => m.role === "tool").at(-1);
  const asked = [...messages].reverse().find(m => m.role === "user" && /字幕核对/.test(textOf(m.content)));

  if (tool && asked) results[textOf(asked.content).includes("核对一") ? "none" : "with"] = textOf(tool.content);
});

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(() => true)`);
  const ready = 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")';
  await until(async () => await rp.evaluate(panel, ready), 60_000, "侧栏就绪");
  const ask = async (path: string, text: string, done: string) => {
    await rp.cdp.send("Page.navigate", { url: `${origin}${path}` }, work);
    await sleep(1_500);
    await rp.cdp.send("Page.bringToFront", {}, work);
    await rp.click(panel, "#conversation-new");
    await sleep(1_000);
    await until(async () => await rp.evaluate(panel, ready), 60_000, "新对话就绪");
    await rp.click(panel, "#input");
    await rp.typeText(panel, text);
    await rp.pressEnter(panel);
    await until(async () => await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes(${JSON.stringify(done)}))`) || undefined, 60_000, `回答：${done}`);
  };

  await ask("/none", ASK_NONE, "第一个视频读完了");
  const none = results.none ?? "";
  check("a 没有字幕的视频：写明播放器自己的字幕清单 0 条、没有字幕", /x\/player\/wbi\/v2 → subtitles: 0 entries/.test(none) && /no subtitles the player can load/.test(none), { result: none.slice(0, 500) });

  await ask("/with", ASK_WITH, "第二个视频读完了");
  const withSubs = results.with ?? "";
  check("b 有字幕的视频：列出中文字幕轨道和地址", /track \[track\] zh 中文 .*\/subs\.vtt/.test(withSubs), { result: withSubs.slice(0, 500) });
  await rp.screenshot(panel, join(out, "panel.png"));
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.length > 0 && checks.every(c => c.pass) ? "PASS" : "FAIL", checks, results }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.close();
}

console.log(`证据：${out}`);

if (checks.length === 0 || checks.some(c => !c.pass)) process.exitCode = 1;
