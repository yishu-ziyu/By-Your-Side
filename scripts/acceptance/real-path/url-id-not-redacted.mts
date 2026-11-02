/**
 * 读网页时，网址路径里的资源编号原样交给模型，像凭据的内容仍隐去（#782：Spotify 专辑页地址读回成 /album/[redacted]，模型拿不到链接）。
 * 只装扩展、隔离构建、模型请求转给本机脚本模型；页面是本机练习页，模型用 js 工具同时读正文和 HTML。
 *   npx tsx scripts/acceptance/real-path/url-id-not-redacted.mts --headless
 *   a) Spotify 专辑和 Google 文档地址里的编号完整出现在工具结果里。
 *   b) 页面上的 API key、网址 ?token= 参数、网址里的口令仍是 [redacted]。
 *   c) 侧栏显示模型的回答。
 * 失败方式：凭据隐去把网址路径里的长串当成密钥（a 失败）；放行范围过宽（b 失败）。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-url-id-not-redacted`);
await mkdir(out, { recursive: true });
const ALBUM = "4aawyAB9vmqN3uQ7FjRGTy";
const DOC = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdEFG";
const SECRETS = ["Zq8Wv3Nx7Lm2Kp9Rt4Yb6Hc", "Ab12Cd34Ef56Gh78Ij90Kl12", "Pq9Rs8Tu7Vw6Xy5Z"];
const HTML_SECRETS = ["FakeKey12AbCd34EfGh56IjKl", "OtherKey98ZyXw76VuTs54Rq", "AttrKey34MnOp56QrSt78Uv"];
const TASK = "网址编号核对：读一下这页上的链接";
const ANSWER = "已读到专辑和文档链接。";

const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end(`<title>链接清单</title>
<p>专辑 https://open.spotify.com/album/${ALBUM}</p>
<p>文档 https://docs.google.com/document/d/${DOC}/edit</p>
<p>API key: ${SECRETS[0]}</p>
<p>回调 https://api.example.com/cb?token=${SECRETS[1]}&amp;x=1</p>
<p>登录 https://admin:${SECRETS[2]}@db.example.com/x</p>
<section><p>https://example.com/path</p><p>${HTML_SECRETS[0]}</p></section>
<section><p>https://example.com</p><p>${HTML_SECRETS[1]}</p></section>
<a href=https://example.com/path>${HTML_SECRETS[2]}</a>
<p>片段 https://example.com/path#token=${SECRETS[1]}</p>`));
await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

type Part = { type?: string; text?: string };
type Message = { role: string; content?: string | Part[] | null };
const textOf = (content: Message["content"]) => (Array.isArray(content) ? content.map(part => part.text ?? "").join("") : content ?? "");
let toolText = "";

const model = await startScriptedModel([
  { match: "USER REQUEST:", steps: [{ text: '{"problems":[]}' }] },
  { match: '"lastReply"', steps: [{ text: '{"status":"done","remaining":null}' }] },
  { match: TASK, steps: [{ tool: { name: "js", args: { code: "JSON.stringify({ text: document.body.innerText, html: document.body.innerHTML })", purpose: "读正文和 HTML 链接" } } }, { text: ANSWER }] },
], undefined, payload => {
  if (!payload.tools?.length) return;
  const tool = ((payload.messages ?? []) as Message[]).filter(m => m.role === "tool").at(-1);
  if (tool) toolText = textOf(tool.content);
});

const rp = await launchRealPath();
let error = "", panel = "";
try {
  panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "stepfun", modelId: "step-3.7-flash" }, inproc_fast_model_config: { provider: "stepfun", modelId: "step-3.7-flash" }, "inproc_cred:stepfun": { type: "api_key", key: "local-fixture" } })}).then(() => true)`);
  await rp.evaluate(panel, `chrome.tabs.create({url:${JSON.stringify(`http://127.0.0.1:${siteAddress(site).port}/`)},active:true}).then(()=>true)`);
  await until(() => rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled===false`), 60_000, "侧栏就绪");
  const host = await until(async () => (await rp.targets()).find(t => t.url.endsWith("/inproc.html")), 30_000, "后台宿主");
  const hs = await rp.attach(host.targetId);
  rp.cdp.onEvent("Fetch.requestPaused", (e: { sessionId?: string; params: { requestId: string; request: { postData?: string } } }) => {
    if (e.sessionId !== hs) return;
    void (async () => {
      const r = await fetch(`${model.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: e.params.request.postData });
      await rp.cdp.send("Fetch.fulfillRequest", { requestId: e.params.requestId, responseCode: r.status, responseHeaders: [{ name: "Content-Type", value: r.headers.get("content-type") ?? "application/json" }], body: Buffer.from(await r.arrayBuffer()).toString("base64") }, hs);
    })().catch(err => { error = String(err); });
  });
  await rp.cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*api.stepfun.com/*/chat/completions*", requestStage: "Request" }] }, hs);

  await rp.click(panel, "#input");
  await rp.typeText(panel, TASK);
  await rp.pressEnter(panel);
  await until(async () => toolText.includes("专辑") || undefined, 90_000, "js 结果");
  const visible = await until(async () => {
    const text = await rp.evaluate(panel, `document.querySelector("#messages")?.innerText ?? ""`) as string;
    return text.includes(ANSWER) ? text : undefined;
  }, 90_000, "回答显示");
  await rp.screenshot(panel, join(out, "panel.png"));
  await writeFile(join(out, "evidence.json"), JSON.stringify({ toolText, error }, null, 2));
  assert.ok(toolText.includes(`/album/${ALBUM}`) && toolText.includes(`/document/d/${DOC}/`), `a 网址编号被隐去：${toolText.slice(0, 600)}`);
  assert.ok(toolText.includes("</p><p>"), "未读到相邻 HTML 标签，不能验证边界");
  for (const secret of [...SECRETS, ...HTML_SECRETS]) assert.ok(!toolText.includes(secret), `b 凭据没隐去：${secret}`);
  assert.ok(visible.includes(ANSWER), "c 侧栏没显示回答");
  assert.equal(error, "", `模型转发失败：${error}`);
  console.log("PASS 网址路径里的资源编号交给模型，凭据仍隐去");
} catch (failure) {
  if (panel) await rp.screenshot(panel, join(out, "failure.png")).catch(() => {});
  await writeFile(join(out, "evidence.json"), JSON.stringify({ toolText, error }, null, 2));
  throw failure;
} finally {
  await rp.close(); await rp.remove(); await model.close(); site.close();
}
