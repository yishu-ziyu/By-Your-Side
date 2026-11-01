/**
 * 侧栏附上的图片，模型能按名字用 read_attachment 重读原图（#782：附件组里模型 9 次猜名字、9 次被告知「用户没有附上文件」）。
 * 只装扩展、隔离构建、收图的模型请求转给本机脚本模型；图片走侧栏真实的文件选择框（DOM.setFileInputFiles）。
 *   npx tsx scripts/acceptance/real-path/image-attachment-read.mts --headless
 *   a) 模型收到的用户消息里写明了图片的名字。
 *   b) read_attachment 按这个名字拿回原图，不报错。
 *   c) 带 cell 时按原图像素放大那一格：返回的范围是原图右下四分之一，图片放大到长边至少 1024。
 *   d) 侧栏显示模型的回答。
 * 失败方式：read_attachment 只找 type=file 的附件（b 失败）；提示里不写图片名（a 失败）；cell 被忽略、返回整张（c 失败）。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-image-attachment-read`);
await mkdir(out, { recursive: true });
const IMAGE = "scan-page.png";
const TASK = "图片附件重读：再看一眼我附的这张图原件";
const ANSWER = "已按名字重读了附上的原图。";

type Part = { type?: string; text?: string };
type Message = { role: string; content?: string | Part[] | null };
const textOf = (content: Message["content"]) => (Array.isArray(content) ? content.map(part => part.text ?? "").join("") : content ?? "");
let userText = "";
let toolText = "";
const toolTexts: string[] = [];
let pngSizes: string[] = [];

const model = await startScriptedModel([
  { match: "USER REQUEST:", steps: [{ text: '{"problems":[]}' }] },
  { match: '"lastReply"', steps: [{ text: '{"status":"done","remaining":null}' }] },
  { match: TASK, steps: [
    { tool: { name: "read_attachment", args: { name: IMAGE } } },
    { tool: { name: "read_attachment", args: { name: IMAGE, cell: { rows: 2, cols: 2, row: 2, col: 2 } } } },
    { text: ANSWER },
  ] },
], undefined, payload => {
  if (!payload.tools?.length) return;
  const messages = (payload.messages ?? []) as Message[];
  const user = messages.find(m => m.role === "user" && textOf(m.content).includes(TASK) && !textOf(m.content).startsWith("本次运行的上下文"));
  if (user && !userText) userText = textOf(user.content);
  const tools = messages.filter(m => m.role === "tool").map(m => textOf(m.content));
  if (tools.length) { toolText = tools[0]!; toolTexts.splice(0, toolTexts.length, ...tools); }
  // 请求里每张 PNG 的宽高（读 PNG 头）：放大后的局部图必须以预期尺寸出现。
  if (toolTexts.length >= 2) pngSizes = (JSON.stringify(messages).match(/iVBORw0KGgo[A-Za-z0-9+/=]{40}/g) ?? []).map(head => { const png = Buffer.from(head, "base64"); return `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`; });
});

const rp = await launchRealPath();
let panel = "", error = "";
try {
  panel = await rp.attach(await rp.openSidePanel());
  // 登记为收图的模型（StepFun），请求在后台宿主里拦下转给脚本模型。
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "stepfun", modelId: "step-3.7-flash" }, inproc_fast_model_config: { provider: "stepfun", modelId: "step-3.7-flash" }, "inproc_cred:stepfun": { type: "api_key", key: "local-fixture" } })}).then(() => true)`);
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

  await rp.cdp.send("DOM.enable", {}, panel);
  const { root } = await rp.cdp.send("DOM.getDocument", { depth: 0 }, panel) as { root: { nodeId: number } };
  const { nodeId } = await rp.cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#file-input" }, panel) as { nodeId: number };
  await rp.cdp.send("DOM.setFileInputFiles", { nodeId, files: [join(REPO, "scripts/acceptance/fixtures/files", IMAGE)] }, panel);
  await until(() => rp.evaluate(panel, `!!document.querySelector("#attachments-strip .tile-56.complete")`), 15_000, "图片附上");
  await rp.click(panel, "#input");
  await rp.typeText(panel, TASK);
  await rp.pressEnter(panel);

  await until(async () => (toolTexts.length >= 2 ? true : undefined), 90_000, "两次 read_attachment 结果");
  const visible = await until(async () => {
    const text = await rp.evaluate(panel, `document.querySelector("#messages")?.innerText ?? ""`) as string;
    return text.includes(ANSWER) ? text : undefined;
  }, 90_000, "回答显示");
  await rp.screenshot(panel, join(out, "panel.png"));
  await writeFile(join(out, "evidence.json"), JSON.stringify({ userText, toolTexts, pngSizes, error }, null, 2));
  assert.ok(userText.includes(JSON.stringify(IMAGE)), `a 用户消息里没写图片名：${userText.slice(-400)}`);
  assert.ok(toolText.includes(`Original image: ${IMAGE}`) && !toolText.includes("没有附件") && !toolText.includes("没有附上文件"), `b read_attachment 没拿回原图：${toolText.slice(0, 300)}`);
  const { width, height } = await import("node:fs/promises").then(fs => fs.readFile(join(REPO, "scripts/acceptance/fixtures/files", IMAGE))).then(png => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) }));
  const zoom = toolTexts[1] ?? "";
  const range = `x ${Math.round(width / 2)}–${Math.round(width / 2) + Math.round(width / 2)}, y ${Math.round(height / 2)}–${Math.round(height / 2) + Math.round(height / 2)} of ${width}×${height}`;
  assert.ok(zoom.includes(`Zoomed cell row 2, column 2 of a 2×2 split of ${IMAGE}: original pixels ${range}`), `c 放大范围不对：${zoom.slice(0, 300)}`);
  // 右下四分之一，长边放大到 1024。
  const half = { w: Math.round(width / 2), h: Math.round(height / 2) }, scale = 1024 / Math.max(half.w, half.h);
  const expected = `${Math.round(half.w * scale)}x${Math.round(half.h * scale)}`;
  assert.ok(pngSizes.includes(expected), `c 没有收到 ${expected} 的放大图，收到 ${pngSizes.join(", ")}`);
  assert.ok(visible.includes(ANSWER), "d 侧栏没显示回答");
  assert.equal(error, "", `模型转发失败：${error}`);
  console.log("PASS 侧栏附上的图片能按名字重读原图，并能放大局部");
} finally {
  await rp.close(); await rp.remove(); await model.close();
}
console.log(`证据目录 ${out}`);
