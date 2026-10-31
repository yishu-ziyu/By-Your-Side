/** 长任务超过三分钟后仍能完成剩余网页操作；隔离扩展、本机脚本模型，约三分半。 */
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-run-clock`);

await mkdir(out, { recursive: true });

const hits: string[] = [];
const site = createServer((req, res) => {
  hits.push(req.url ?? "");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>${req.url}</title><body><main><h1>${req.url}</h1></main></body></html>`);
});

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
const at = (path: string) => ({ name: "navigate", args: { url: `http://127.0.0.1:${siteAddress(site).port}${path}` } });

const TASK = "计时核对：把这期视频的字幕找出来";
const DONE = "已完成全部四个页面的整理。";
// 每段停 5 秒、不超过断流计时：3 分多钟一直在出字，然后才调第一个工具。
const slow = Array.from({ length: 38 }, () => ({ text: "…", delayMs: 5_000 }));
const notes: string[] = [];
const textOf = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? "").join("") : "";

const model = await startScriptedModel([
  { match: TASK, steps: [
    { text: "…".repeat(slow.length), pieces: slow, thenTool: at("/first") },
    { tool: at("/grace1") },
    { tool: at("/grace2") },
    { tool: at("/third") },
    { text: DONE },
  ] },
], undefined, payload => {
  // 工具结果后面可能还跟着产品插的上下文段，不一定是最后一条。
  for (const message of payload.messages ?? []) if (message.role === "tool" && !notes.includes(textOf(message.content))) notes.push(textOf(message.content));
});

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

try {
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")'), 60_000, "侧栏就绪");
  await rp.click(panel, "#input");
  await rp.typeText(panel, TASK);
  await rp.pressEnter(panel);
  await until(async () => await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes(${JSON.stringify(DONE)}))`) || undefined, 300_000, "最后的回话");
  await rp.screenshot(panel, join(out, "panel.png"));
  const first = notes[0] ?? "";
  check("a 满 3 分钟后提醒继续已授权工作", first.includes("[Time]") && first.includes("continue the remaining authorized work"), { first: first.slice(-300), results: notes.length });
  const pages = hits.filter(path => path !== "/favicon.ico");
  check("b 提醒后所有剩余页面均实际打开", pages.includes("/grace1") && pages.includes("/grace2") && pages.includes("/third"), { pages });
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.length > 0 && checks.every(c => c.pass) ? "PASS" : "FAIL", checks, notes }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.close();
}

console.log(`证据：${out}`);

if (checks.length === 0 || checks.some(c => !c.pass)) process.exitCode = 1;
