/**
 * 模型回复写了几个字就不再推进（连接仍发空事件）：助手很快自己重发，用户不用干等到连接被服务端掐断。
 * 只装扩展、隔离构建、本机脚本模型；前面一层代理让第一次主任务回复写出几个字后挂住 120 秒再掐断。
 *   npx tsx scripts/acceptance/real-path/stream-stall-retry.mts --headless
 *   a) 发出后 60 秒内出现完整回答。
 *   b) 回答只出现一遍，断流前写出的半句不留在回答里。
 * 失败方式：没有断流计时，要等 120 秒连接被掐断才重发，a 失败。
 */
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-stream-stall-retry`);

await mkdir(out, { recursive: true });

const TASK = "断流核对：这页讲什么";
const ANSWER = "这一页讲的是断流之后怎样自动重来。";
const HALF = "断流前写出的半句";
const HOLD_MS = 120_000;

const model = await startScriptedModel([{ match: TASK, steps: [{ text: ANSWER }] }]);
let stalled = false;
const proxy = createServer(async (req, res) => {
  let body = "";

  req.setEncoding('utf8'); for await (const chunk of req) body += chunk;

  // 空 delta 经过供应商原始事件钩子，但没有推进正文；连接活着不等于回答在推进。
  if (!stalled && req.method === "POST" && body.includes(TASK) && body.includes('"tools"')) {
    stalled = true;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: Json) => `data: ${JSON.stringify({ id: "stall", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
    res.write(chunk({ role: "assistant", content: HALF }));
    const heartbeat = setInterval(() => res.write(chunk({})), 1_000);
    const timer = setTimeout(() => res.destroy(), HOLD_MS);
    res.on("close", () => { clearTimeout(timer); clearInterval(heartbeat); });

    return;
  }

  const response = await fetch(`${model.baseUrl.replace(/\/v1$/, "")}${req.url ?? ""}`, { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "POST" ? body : undefined });
  res.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "application/json" }).end(Buffer.from(await response.arrayBuffer()));
});

await new Promise<void>(done => proxy.listen(0, "127.0.0.1", done));
const baseUrl = `http://127.0.0.1:${siteAddress(proxy).port}/v1`;

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

try {
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")'), 60_000, "侧栏就绪");
  await rp.click(panel, "#input");
  await rp.typeText(panel, TASK);
  const sentAt = Date.now();
  await rp.pressEnter(panel);
  console.log("已发出：服务每秒发空事件；等待侧栏在 60 秒内恢复完整回答。");
  const answered = await until(async () => await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes(${JSON.stringify(ANSWER)}))`) || undefined, 65_000, "回答出现").then(() => true, () => false);
  const waitedMs = Date.now() - sentAt;
  await until(async () => await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].every(m => m.getAnimations({ subtree: true }).every(a => a.playState !== "running"))`) || undefined, 5_000, "回答淡入完成后留图");
  await rp.screenshot(panel, join(out, "answer.png"));
  check("a 断流后 60 秒内出现完整回答", answered && waitedMs < 60_000, { answered, waitedMs, stalled });
  const text = await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].map(m => m.textContent).join("\\n")`) as string;
  check("b 回答只出现一遍，断流前的半句不留在回答里", text.split(ANSWER).length === 2 && !text.includes(HALF), { text: text.slice(0, 300) });
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.length > 0 && checks.every(c => c.pass) ? "PASS" : "FAIL", checks }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); proxy.closeAllConnections(); proxy.close();
}

console.log(`证据：${out}`);

if (checks.length === 0 || checks.some(c => !c.pass)) process.exitCode = 1;
