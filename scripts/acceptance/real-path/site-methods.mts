/** Real extension and sidebar, scripted model and intercepted site fixtures. Actual public-site evidence is separate. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, until, type Json } from "./harness.mts";
import { startScriptedModel, type Rule, type TextStep } from "./scripted-model.mts";

requireHeadless();
const only = process.argv.find(arg => arg.startsWith("--case="))?.slice(7);
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-site-methods`);
await mkdir(out, { recursive: true });
const cases = [
  { id: "yt-captions", url: "https://www.youtube.com/watch?v=video123", method: "youtube.captions", expected: "这段字幕属于当前视频。", also: ["that's right"], absent: "&#39;" },
  // 方法成功后模型自己的代码出错：错误要指出哪一行，并带回已完成的方法结果，模型不必绕开方法重做。
  { id: "yt-program-bug", url: "https://www.youtube.com/watch?v=video123", method: "youtube.captions", code: 'const r = await browser.siteMethod({id:"youtube.captions"});\nreturn r.slice(0, 10);', expected: "这段字幕属于当前视频。", also: ["program line 2", "already finished: siteMethod"] },
  // 用户要的语言不在第一条轨：按 language 取到对应轨，而不是交回第一条。
  { id: "yt-language", url: "https://www.youtube.com/watch?v=multi1", method: "youtube.captions", language: "zh", expected: "这段字幕属于当前视频。", also: ['"language":"zh-CN"'], absent: "ترجمة" },
  { id: "yt-no-captions", url: "https://www.youtube.com/watch?v=nocap1", method: "youtube.captions", expected: '"status":"no_captions"' },
  { id: "yt-stale", url: "https://www.youtube.com/watch?v=video456&stale=1", method: "youtube.captions", expected: "unavailable", absent: "这是上一条视频" },
  { id: "bili-captions", url: "https://www.bilibili.com/video/BV1TEST123", method: "bilibili.captions", expected: "当前分P的字幕。", absent: "其他分P字幕" },
  { id: "x-post", url: "https://x.com/example/status/1234567890", method: "x.read-post", expected: "这是指定的原帖正文。", absent: "这是推荐帖" },
  { id: "yt-search", url: "https://www.youtube.com/", method: "youtube.search", query: "猫 & 自然", expected: "猫 & 自然" },
  { id: "bili-search", url: "https://www.bilibili.com/", method: "bilibili.search", query: "故宫 建筑", expected: "故宫 建筑" },
  { id: "x-search", url: "https://x.com/", method: "x.search", query: "agent browser", expected: "agent browser" },
  { id: "wrong-site", url: "https://www.youtube.com/", method: "x.read-post", expected: "does not apply", unchanged: true },
  { id: "spoof-host", url: "https://youtube.com.evil.test/", method: "youtube.search", query: "不会执行", expected: "does not apply", unchanged: true },
].filter(c => !only || c.id === only);
const replies = new Map<string, TextStep>();
const textOf = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value) ? value.map(part => typeof part?.text === "string" ? part.text : "").join("") : "";
const rules: Rule[] = cases.map(c => {
  const reply = { text: "等待真实工具结果" }; replies.set(c.id, reply);
  return { match: `网站方法 ${c.id}`, steps: [{ tool: { name: "browser_run", args: { label: c.id, code: c.code ?? `return await browser.siteMethod(${JSON.stringify({ id: c.method, ...(c.query ? { query: c.query } : {}), ...(c.language ? { language: c.language } : {}) })});` } } }, reply] };
});
let languageOffered = false;
const model = await startScriptedModel(rules, undefined, payload => {
  if (/youtube\.captions v1[^\n]*inputs: language/.test(JSON.stringify(payload).replaceAll("\\n", "\n"))) languageOffered = true;
  const messages = payload.messages ?? [];
  const task = [...messages].reverse().find(message => message.role === "user" && textOf(message.content).includes("网站方法 "));
  const result = [...messages].reverse().find(message => message.role === "tool");
  const id = task ? cases.find(c => textOf(task.content).includes(`网站方法 ${c.id}`))?.id ?? "" : "";
  if (result && replies.has(id)) replies.get(id)!.text = `工具实际返回：\n\n\`\`\`text\n${textOf(result.content)}\n\`\`\`\n本次记录结束。`;
});
const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };
const observedRequests: string[] = [];
let panel = "";
const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
function fixture(url: URL): { type: string; body: string } {
  if (url.pathname === "/captions-ar") return { type: "text/vtt", body: "WEBVTT\n\n00:00.000 --> 00:02.000\nترجمة\n" };
  if (url.pathname === "/captions") return { type: "text/vtt", body: "WEBVTT\n\n00:00.000 --> 00:02.000\n这段字幕属于当前视频。\n\n00:02.000 --> 00:04.000\nthat&amp;#39;s right\n" };
  if (url.pathname === "/bili-subs") return { type: "application/json", body: JSON.stringify({ body: [{ from: 0, to: 2, content: "当前分P的字幕。" }] }) };
  if (url.pathname.includes("/x/player/")) return { type: "application/json", body: JSON.stringify({ data: { subtitle: { subtitles: [{ lan: "zh", subtitle_url: url.searchParams.get("cid") === "222" ? "https://www.bilibili.com/bili-subs" : "https://www.bilibili.com/wrong-subs" }] } } }) };
  if (url.pathname === "/wrong-subs") return { type: "text/plain", body: "其他分P字幕" };
  const query = url.searchParams.get("search_query") ?? url.searchParams.get("keyword") ?? url.searchParams.get("q");
  let body = `<h1>搜索与阅读练习页</h1>${query ? `<h2 id="query">${escape(query)}</h2><p>这里是对应的实际搜索结果。</p>` : ""}`;
  if (url.hostname === "www.youtube.com" && url.pathname === "/watch") {
    body += `<video></video><script>window.ytInitialPlayerResponse=${JSON.stringify({ videoDetails: { videoId: url.searchParams.has("stale") ? "oldvideo" : url.searchParams.get("v") }, ...(url.searchParams.get("v") === "nocap1" ? {} : { captions: { playerCaptionsTracklistRenderer: { captionTracks: url.searchParams.get("v") === "multi1" ? [{ languageCode: "ar", name: { simpleText: "Arabic" }, baseUrl: "https://www.youtube.com/captions-ar" }, { languageCode: "zh-CN", name: { simpleText: "Chinese (China)" }, baseUrl: "https://www.youtube.com/captions" }] : [{ languageCode: "zh", name: { simpleText: "中文" }, baseUrl: "https://www.youtube.com/captions" }] } } }) })};</script>`;
  }
  if (url.hostname === "www.bilibili.com" && url.pathname.startsWith("/video/")) {
    body += `<video></video><script>window.__INITIAL_STATE__={videoData:{bvid:'BV1TEST123',cid:222,pages:[{cid:222}]}};Promise.all([fetch('/x/player/wbi/v2?cid=111'),fetch('/x/player/wbi/v2?cid=222')]).then(()=>document.body.dataset.ready='1');</script>`;
  }
  if (url.hostname === "x.com" && url.pathname.includes("/status/")) {
    body += `<article data-testid="tweet"><div data-testid="User-Name">推荐作者</div><a href="/other/status/9876543210"><time datetime="2026-01-01"></time></a><div data-testid="tweetText">这是推荐帖</div></article><article data-testid="tweet"><div data-testid="User-Name">原帖作者</div><a href="/example/status/1234567890"><time datetime="2026-01-02"></time></a><div data-testid="tweetText">这是指定的原帖正文。</div></article>`;
  }
  return { type: "text/html; charset=utf-8", body: `<!doctype html><html lang="zh"><meta charset="utf-8"><title>网站方法验收</title><body ${url.hostname === "www.bilibili.com" && url.pathname.startsWith("/video/") ? "" : 'data-ready="1"'}>${body}</body></html>` };
}
try {
  const work = await rp.attach((await rp.targets()).find(target => target.url === "about:blank")!.targetId);
  const worker = await rp.attach((await rp.serviceWorker())!.targetId);
  const intercepted = new Set([work, worker]);
  rp.cdp.onEvent("Fetch.requestPaused", (event: { sessionId?: string; params: { requestId: string; request: { url: string } } }) => {
    if (!event.sessionId || !intercepted.has(event.sessionId)) return;
    const url = new URL(event.params.request.url); observedRequests.push(url.href);
    const value = fixture(url);
    void rp.cdp.send("Fetch.fulfillRequest", { requestId: event.params.requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: value.type }, { name: "access-control-allow-origin", value: "*" }], body: Buffer.from(value.body).toString("base64") }, event.sessionId);
  });
  for (const session of intercepted) await rp.cdp.send("Fetch.enable", { patterns: ["*youtube.com/*", "*bilibili.com/*", "https://x.com/*", "https://youtube.com.evil.test/*"].map(urlPattern => ({ urlPattern, requestStage: "Request" })) }, session);
  panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })})`);
  const ready = 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")';
  await until(() => rp.evaluate(panel, ready), 60_000, "侧栏就绪");
  for (const c of cases) {
    await rp.cdp.send("Page.navigate", { url: c.url }, work);
    await until(() => rp.evaluate(work, 'document.body?.dataset.ready === "1"').catch(() => false), 15_000, c.id + " 页面就绪");
    await rp.cdp.send("Page.bringToFront", {}, work);
    await rp.click(panel, "#conversation-new");
    await until(() => rp.evaluate(panel, ready), 20_000, "新会话就绪");
    await rp.click(panel, "#input"); await rp.typeText(panel, `网站方法 ${c.id}`); await rp.pressEnter(panel);
    await until(async () => await rp.evaluate(panel, `document.querySelector("#messages")?.textContent.includes("本次记录结束")`), 45_000, c.id + " 侧栏交付");
    const text = String(await rp.evaluate(panel, '[...document.querySelectorAll(".msg.assistant")].map(m=>m.textContent).join("\\n")'));
    check(c.id + " 结果", text.includes(c.expected) && (c.also ?? []).every(part => text.includes(part)) && (!c.absent || !text.includes(c.absent)), { text: text.slice(0, 2200) });
    const actualUrl = String(await rp.evaluate(work, "location.href"));
    if (c.unchanged) check(c.id + " 没有改页", actualUrl === c.url, actualUrl);
    if (c.query) check(c.id + " 查询一致", c.unchanged ? actualUrl === c.url : new URL(actualUrl).searchParams.get(c.method.startsWith("youtube") ? "search_query" : c.method.startsWith("bilibili") ? "keyword" : "q") === c.query, actualUrl);
    await rp.screenshot(panel, join(out, c.id + ".png"));
    await until(() => rp.evaluate(panel, ready), 25_000, c.id + " 收尾");
  }
  check("字幕方法向模型写明可传 language", languageOffered, languageOffered);
  check("没有下载其他分P字幕", !observedRequests.some(url => url.includes("/wrong-subs")), observedRequests.filter(url => /subs|captions/.test(url)));
} catch (error) {
  check("流程完成", false, String(error));
  if (panel) {
    await rp.screenshot(panel, join(out, "failure.png")).catch(() => {});
    await writeFile(join(out, "failure.txt"), String(await rp.evaluate(panel, "document.body.innerText").catch(String)));
  }
}
finally { await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.length && checks.every(c => c.pass) ? "PASS" : "FAIL", checks, observedRequests, modelRequests: model.requests, replies: Object.fromEntries(replies) }, null, 2)); await rp.close(); await rp.remove(); await model.close(); }
console.log(`证据：${out}`);
if (!checks.length || checks.some(c => !c.pass)) process.exitCode = 1;
