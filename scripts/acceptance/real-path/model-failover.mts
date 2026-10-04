/**
 * 主模型连上后一直不出字，快速模型接手回答（docs/evals/20261004-model-failover.md F1、F4）。
 * 只装扩展、隔离构建、本机脚本模型：主模型地址指向一个「接了请求就不再说话」的本机服务。
 *   npx tsx scripts/acceptance/real-path/model-failover.mts --headless
 * 失败方式：侧栏一直等主模型（日常 30 s 才报错再重试）；或报错而不是换快速模型；或侧栏看不到切换。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-model-failover`);

await mkdir(artifacts, { recursive: true });

const MARK = "你好，切换验收";

const ANSWER = "你好！我是快速模型，在这儿。";

const BOUND_MS = 25_000;

const fast = await startScriptedModel([{ match: MARK, steps: [{ text: ANSWER }] }]);

// 主模型：带工具表的任务请求只回响应头，之后不再说话；其他请求（不带工具）转给脚本模型。
const hung: number[] = [];

const main = createServer(async (req, res) => {
  let body = "";

  for await (const chunk of req) body += String(chunk);

  if (req.method === "POST" && /"tools"\s*:\s*\[\s*\{/.test(body)) {
    hung.push(Date.now());
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();

    return;
  }

  const upstream = await fetch(`${fast.baseUrl.replace(/\/$/, "")}${(req.url ?? "").replace(/^\/v1/, "")}`, { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "POST" ? body : undefined });
  res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" }).end(Buffer.from(await upstream.arrayBuffer()));
});

await new Promise<void>(resolve => main.listen(0, "127.0.0.1", resolve));

const rp = await launchRealPath();

let error: string | null = null;

/** 写进 result.json 的证据。 */
interface Evidence { stage?: string; visibleMs?: number; hungRequestsAtMs?: number[]; fastRequests?: unknown[]; switchNotice?: boolean; sidebarTail?: string }

const evidence: Evidence = {};

try {
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);

  // 设置页路径另有验收（inproc-config）；这里直接写入设置页会存的那几项：主模型指向挂起服务，快速模型指向脚本模型。
  const items = {
    inproc_model_config: { provider: "custom", modelId: "step-hang", baseUrl: `http://127.0.0.1:${siteAddress(main).port}/v1` },
    inproc_fast_model_config: { provider: "custom", modelId: "demo-model", baseUrl: fast.baseUrl },
    "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" },
  };

  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);

  evidence.stage = "send";
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");
  await rp.click(panel, "#input");
  await rp.typeText(panel, MARK);
  const sentAt = Date.now();
  await rp.pressEnter(panel);

  await until(async () => await rp.evaluate(panel, `document.querySelector("#messages")?.textContent.includes(${JSON.stringify(ANSWER)})`) || undefined, 90_000, "answer visible");
  const visibleMs = Date.now() - sentAt;
  evidence.stage = "done";
  const text = String(await rp.evaluate(panel, 'document.querySelector("#messages")?.textContent ?? ""'));
  await rp.screenshot(panel, join(artifacts, "sidebar.png"));

  evidence.visibleMs = visibleMs;
  evidence.hungRequestsAtMs = hung.map(at => at - sentAt);
  evidence.fastRequests = fast.requests.filter(r => r.rule === MARK);
  evidence.switchNotice = /切换到/.test(text);
  evidence.sidebarTail = text.slice(-400);

  assert.equal(hung.length, 1, "the hung main model is asked once, not retried");
  assert.ok(visibleMs <= BOUND_MS, `answer visible within ${BOUND_MS} ms (got ${visibleMs})`);
  assert.ok(/切换到/.test(text), "the sidebar shows the switch");
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  await fast.close();
  main.closeAllConnections();
  main.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
