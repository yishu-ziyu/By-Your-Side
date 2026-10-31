/**
 * 网页点击下载 PDF 后，不重新选择文件，直接按关键词读正文。
 * 真扩展、真 Chrome 下载、真 PDF 解析；脚本模型只固定工具顺序。
 *   npx tsx scripts/acceptance/real-path/download-continuity.mts --headless
 * 失败方式：不捕获下载原件或 read_attachment 未注册时，正文检查失败；重复 GET 也算失败。
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const ASK = "下载合同并查交付日期";
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-download-continuity`);
const sourcePdf = await readFile(join(REPO, "scripts/acceptance/fixtures/files/contract.pdf"));
// 超过 5 MB 的原件只留会话内存；尾部填充不改变这份 PDF 的正文。
const pdf = Buffer.concat([sourcePdf, Buffer.alloc(6 * 1024 * 1024)]);
const expectedSha256 = createHash("sha256").update(pdf).digest("hex");
const requests: string[] = [];
const site = createServer((req, res) => {
  const path = req.url ?? "";
  requests.push(path);
  if (path === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><title>合同下载</title><a id="download" href="/contract.pdf" download="contract.pdf">下载合同</a><input id="upload" type="file"><output id="receipt">尚未选择</output><script>document.querySelector('#upload').addEventListener('change',async event=>{const file=event.target.files[0];const hash=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());document.querySelector('#receipt').textContent=[...new Uint8Array(hash)].map(byte=>byte.toString(16).padStart(2,'0')).join('');});</script>`);
    return;
  }
  if (path === "/contract.pdf") {
    res.writeHead(200, { "content-type": "application/pdf", "content-disposition": 'attachment; filename="contract.pdf"', "content-length": pdf.length });
    res.end(pdf);
    return;
  }
  res.writeHead(404).end();
});
await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;
await mkdir(out, { recursive: true });

type Part = { type?: string; text?: string };
type Message = { role: string; content?: string | Part[] | null };
const textOf = (content: Message["content"]) => Array.isArray(content) ? content.map(part => part.text ?? "").join("") : content ?? "";
const toolResults: string[] = [];
let leakedBase64 = false;
const model = await startScriptedModel([
  { match: ASK, steps: [
    { tool: { name: "browser_run", args: { code: 'const armed = await browser.armEvent({type:"download"}); await browser.click({target:"#download"}); return await browser.waitEvent({token:armed.token, timeoutMs:30000});' } } },
    { tool: { name: "read_attachment", args: { name: "contract.pdf", query: "交付日期" } } },
    { tool: { name: "upload_file", args: { files: ["contract.pdf"], target: "#upload" } } },
    { text: "合同第 3 页的交付日期是 2025 年 6 月 30 日。原件已放回上传框。" },
  ] },
], undefined, payload => {
  if (!payload.tools?.length) return;
  for (const message of payload.messages ?? []) {
    if (message.role !== "tool") continue;
    const text = textOf(message.content);
    if (toolResults.at(-1) !== text) toolResults.push(text);
    if (text.includes("dataBase64") || text.includes("capturedFile")) leakedBase64 = true;
  }
});

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };
let error: string | null = null;
try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "工作页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.navigate", { url: origin }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  const ready = 'document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")';
  await until(async () => await rp.evaluate(panel, ready), 60_000, "侧栏就绪");
  await rp.cdp.send("Target.activateTarget", { targetId: blank.targetId });
  await rp.click(panel, "#input");
  await rp.typeText(panel, ASK);
  await rp.pressEnter(panel);
  await until(async () => model.requests.some(r => r.rule === ASK && r.step === 3 && r.finished) || undefined, 90_000, "正文读取和原件上传完成", 100);
  await until(async () => await rp.evaluate(panel, ready), 60_000, "任务结束");
  const visibleAnswer = await until(async () => {
    const text = String(await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].at(-1)?.innerText ?? ""`));
    return text.includes("2025 年 6 月 30 日") ? text : null;
  }, 15_000, "侧栏显示正文结论");
  check("侧栏向用户显示从下载正文得到的结论", visibleAnswer.includes("2025 年 6 月 30 日"), { visibleAnswer });
  await sleep(500);
  await rp.screenshot(panel, join(out, "answer.png"));

  const names = await readdir(rp.dirs.downloads);
  const downloaded = names.includes("contract.pdf") ? await readFile(join(rp.dirs.downloads, "contract.pdf")) : Buffer.alloc(0);
  check("Chrome 保存的就是网页提供的原件", downloaded.equals(pdf) && pdf.length > 5 * 1024 * 1024, { names, bytes: downloaded.length });
  check("下载只请求一次，没有为读正文重新 GET", requests.filter(path => path === "/contract.pdf").length === 1, { requests });
  check("read_attachment 找到 PDF 里的交付日期", toolResults.some(text => text.includes("交付日期：2025 年 6 月 30 日")), { toolResults: toolResults.map(text => text.slice(0, 500)) });
  const uploaded = await rp.evaluate(work, `({ size: document.querySelector("#upload").files[0]?.size ?? 0, sha256: document.querySelector("#receipt").textContent })`) as { size: number; sha256: string };
  check("大于 5 MB 的下载原件上传前后哈希一致", uploaded.size === pdf.length && uploaded.sha256 === expectedSha256, uploaded);
  check("原始 base64 没有进入模型工具结果", !leakedBase64, { leakedBase64 });
} catch (cause) {
  error = String(cause);
  check("流程完成", false, error);
} finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: !error && checks.length === 6 && checks.every(c => c.pass) ? "PASS" : "FAIL", checks, requests, modelRequests: model.requests }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.closeAllConnections();
  site.close();
}
console.log(`证据：${out}`);
if (error || checks.length !== 6 || checks.some(c => !c.pass)) process.exitCode = 1;
