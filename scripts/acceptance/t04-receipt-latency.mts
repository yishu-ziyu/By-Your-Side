#!/usr/bin/env npx tsx
/**
 * T04 反馈延迟：权威修改回执到呈现，P95 ≤200ms，50 次，无头串行。
 *
 * 测量边界：隔离无头 Chrome（真实构建扩展、真实 SW、真实 sidepanel 页面）+ 本机受控 agent 服务。
 * agent 只按真实协议完成握手与 conversation_list，不调用模型、不执行网页操作；每轮的权威回执
 * 由验收脚本按生产 emitReceipt 的同一消息形状（agent_event notice + TaskReceipt + diff）从 agent
 * 侧投递，经真实 WS → SW onServerMessage → 面板 Port → renderReceipt 渲染。
 * t0 = 投递前的墙钟时间；t1 = 面板内 MutationObserver 在该 requestId 的 DOM 出现后下一帧
 * （requestAnimationFrame）的墙钟时间；两端同为 Date.now()（同机同一系统时钟）。
 * 含 WS/CDP 传输开销，不含模型判断与实际网页操作。串行执行，50 次全接受；超时按失败保留、不转 0。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { DEFAULT_PORT, HOST_VERSION, PROTOCOL_VERSION, STORAGE_SCHEMA_VERSION, parseClientMessage } from "../../shared/protocol.js";
import { launchIsolatedExtension, sleep, until } from "./isolated-extension.mts";
import { percentileNearestRank } from "../eval/lib/clock.mjs";

if (!process.argv.includes("--headless=new") && !process.argv.includes("--headless")) {
  console.error("t04-receipt-latency 只允许无头：请加 --headless=new");
  process.exit(2);
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const ROUNDS = 50;

const TARGET_P95_MS = 200;

const token = randomUUID();

interface RenderFact { requestId: string; domAt: number; frameAt: number; text: string }

const portFree = await new Promise<boolean>(done => {
  const probe = createServer();
  probe.once("error", () => done(false));
  probe.once("listening", () => probe.close(() => done(true)));
  probe.listen(DEFAULT_PORT, "127.0.0.1");
});

if (!portFree) {
  console.error(`端口 ${DEFAULT_PORT} 已被占用（可能有本地伴随进程在运行）。不终止任何进程；请先停掉冲突实例再重跑。`);
  process.exit(2);
}

const conversations = [{ id: "default", title: "新会话", createdAt: Date.now(), updatedAt: Date.now(), state: "idle" as const, mode: "act" as const, runId: null }];

const wss = new WebSocketServer({ host: "127.0.0.1", port: DEFAULT_PORT });

const listening = new Promise<void>((done, reject) => { wss.once("listening", done); wss.once("error", reject); });

let socket: WebSocket | undefined;

wss.on("connection", client => {
  client.on("message", raw => {
    const message = parseClientMessage(raw.toString());

    if (!message) return;

    if (message.type === "hello") {
      if (message.token !== token) { client.close();

 return; }

      socket = client;
      client.send(JSON.stringify({ type: "hello_ok", version: PROTOCOL_VERSION, model: "acceptance", models: [], hostVersion: HOST_VERSION, storageSchema: STORAGE_SCHEMA_VERSION, extensionVersion: "0.1.0" }));
      client.send(JSON.stringify({ type: "conversation_list", conversations }));

      return;
    }

    if (message.type === "conversation_list") client.send(JSON.stringify({ type: "conversation_list", conversations }));
  });
  client.on("close", () => { if (socket === client) socket = undefined; });
});

const report: Record<string, unknown> = { ok: false, rounds: ROUNDS, targetP95Ms: TARGET_P95_MS, samples: [], failures: [] };

const iso = await launchIsolatedExtension();

try {
  await listening;
  const extId = await iso.swEval("chrome.runtime.id") as string;
  await iso.swEval(`chrome.storage.local.set({sideagent_token:${JSON.stringify(token)}})`);
  const panelId = await iso.newTarget(`chrome-extension://${extId}/sidepanel.html`);
  await until(async () => await iso.evalIn(panelId, "Boolean(document.querySelector('#input'))") || undefined, 20_000, "面板 DOM");
  await iso.evalIn(panelId, "globalThis.probePort=chrome.runtime.connect({name:'sideagent-panel'});probePort.postMessage({kind:'retry'});");
  await until(() => socket?.readyState === WebSocket.OPEN || undefined, 15_000, "受控 agent 连接");
  await until(async () => await iso.evalIn(panelId, "document.getElementById('status-text')?.textContent?.includes('已连接')") || undefined, 15_000, "面板进入已连接状态");

  await iso.evalIn(panelId, `(() => {
    globalThis.__t04 = { renders: [] };
    const seen = new Set();
    const messages = document.getElementById('messages');
    const record = (id) => {
      if (!id || seen.has(id)) return;
      const el = document.querySelector('[data-request-id="' + id + '"]');
      if (!el) return;
      seen.add(id);
      const domAt = Date.now();
      const text = el.textContent || '';
      requestAnimationFrame(() => {
        globalThis.__t04.renders.push({ requestId: id, domAt, frameAt: Date.now(), text });
      });
    };
    const scan = (node) => {
      if (!(node instanceof Element)) return;
      if (node.matches('[data-request-id]')) record(node.dataset.requestId);
      node.querySelectorAll('[data-request-id]').forEach(x => record(x.dataset.requestId));
    };
    globalThis.__t04Observer = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        if (mutation.target instanceof Element) {
          const holder = mutation.target.closest('[data-request-id]');
          if (holder) record(holder.dataset.requestId);
        }
        mutation.addedNodes.forEach(scan);
      }
    });
    globalThis.__t04Observer.observe(messages, { childList: true, subtree: true });
    return true;
  })()`);

  const samples: Array<{ requestId: string; latencyMs: number; domMs: number; textOk: boolean }> = [];

  for (let i = 0; i < ROUNDS; i++) {
    const requestId = `t04-lat-${i}-${Date.now()}`;
    const message = "修改已直接应用并核对：译文已改成宋体。原任务继续。";

    const receipt = {
      requestId,
      conversationId: "default",
      source: "text",
      action: "steer",
      runId: `t04-run-${i}`,
      text: "把译文改成宋体",
      targetTitle: "文章",
      status: "applied",
      message,
      updatedAt: Date.now(),
      diff: { target: "文章", changed: [{ attribute: "字体", from: "原字体", to: "宋体" }], preserved: ["显示模式"] },
    };

    const t0 = Date.now();

    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("受控 agent 连接已断开，测量中止");
    socket.send(JSON.stringify({ type: "agent_event", conversationId: "default", event: { kind: "notice", message, receipt } }));
    const render = await waitForRender(panelId, requestId, 3_000);

    if (!render) {
      report.failures.push({ i, requestId, reason: "3 秒内面板没有出现这条回执" });
      samples.push({ requestId, latencyMs: 3_000, domMs: 3_000, textOk: false });
      continue;
    }

    const textOk = render.text.includes("修改已应用并核对") && render.text.includes("字体：原字体 → 宋体") && render.text.includes("显示模式保持不变");
    samples.push({ requestId, latencyMs: render.frameAt - t0, domMs: render.domAt - t0, textOk });
  }

  report.samples = samples;

  const sorted = samples.map(sample => sample.latencyMs).sort((a, b) => a - b);
  const p95 = percentileNearestRank(sorted, 95);
  report.latencyMs = { p50: percentileNearestRank(sorted, 50), p95, max: sorted.at(-1) ?? null, min: sorted.at(0) ?? null };
  report.renderedOk = samples.filter(sample => sample.textOk).length;
  report.lastRenderText = (await iso.evalIn(panelId, "(globalThis.__t04?.renders ?? []).at(-1)?.text ?? null")) as string | null;
  report.pass = samples.length === ROUNDS
    && samples.every(sample => sample.textOk)
    && (p95 ?? Number.POSITIVE_INFINITY) <= TARGET_P95_MS;
  report.ok = report.pass === true;

  const outDir = join(REPO_ROOT, "out", "acceptance", `${new Date().toISOString().replace(/[:.]/g, "-")}-t04`);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "t04-receipt-latency.json"), `${JSON.stringify({ ...report, outDir }, null, 2)}\n`);
  // 截图前展开回执归档并滚到最新一条，让「旧值 → 新值；保留项」在截图里可见。
  await iso.evalIn(panelId, `(() => {
    document.querySelector('.receipt-archive')?.setAttribute('open', '');
    const all = [...document.querySelectorAll('[data-request-id]')];
    const last = all.at(-1);
    if (last) { last.setAttribute('open', ''); last.scrollIntoView({block: 'end'}); }
    return all.length;
  })()`);
  await sleep(150);
  await iso.screenshot(panelId, join(outDir, "t04-receipt-panel.png"));
  console.log(JSON.stringify({ outDir, ok: report.ok, latencyMs: report.latencyMs, renderedOk: report.renderedOk, failures: report.failures }, null, 2));
} catch (error) {
  report.error = String(error);
  const outDir = join(REPO_ROOT, "out", "acceptance", `${new Date().toISOString().replace(/[:.]/g, "-")}-t04`);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "t04-receipt-latency.json"), `${JSON.stringify({ ...report, outDir }, null, 2)}\n`);
  console.log(JSON.stringify({ outDir, ok: false, error: report.error }, null, 2));
} finally {
  await iso.close();
  wss.close();
}

process.exit(report.ok === true ? 0 : 1);

/** 面板里等这条回执真的渲染；返回面板记录的帧时间。 */
async function waitForRender(panelId: string, requestId: string, timeoutMs: number): Promise<RenderFact | null> {
  const end = Date.now() + timeoutMs;

  while (Date.now() < end) {
    const found = await iso.evalIn(
      panelId,
      `(globalThis.__t04?.renders ?? []).find(r => r.requestId === ${JSON.stringify(requestId)}) ?? null`,
    ) as RenderFact | null;

    if (found) return found;
    await sleep(5);
  }

  return null;
}
