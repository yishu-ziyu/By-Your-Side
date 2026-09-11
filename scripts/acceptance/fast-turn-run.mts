#!/usr/bin/env node
/**
 * 单动作任务回合经济真实路径：真模型 + 隔离 headless Chrome + 真实扩展构建。
 * 依据 docs/evals/20260911-fast-and-lean.md 的 A 组标准。
 *
 * case：页面已打开、视频正在播放，用户说「把视频暂停」。
 * 记录：模型轮数、首个改变页面的动作时刻、总耗时、交付次数、页面真实暂停状态。
 * 只读环境，不碰用户 Chrome/扩展；不提交、不推送。
 */
import { createServer, type Server } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchIsolatedExtension } from "./isolated-extension.mts";
import { ConversationManager } from "../../agent/src/conversation-manager.js";
import { ConversationStore } from "../../agent/src/conversation-store.js";
import { createConversationRuntime } from "../../agent/src/conversation-runtime.js";
import type { ClientMessage, PageContext, ServerMessage } from "../../shared/protocol.js";

const MODEL = process.argv.find((a) => a.startsWith("--model="))?.slice(8) ?? "minimax-cn/MiniMax-M3";
const RUNS = Number(process.argv.find((a) => a.startsWith("--runs="))?.slice(7) ?? "3");
const OUT = process.argv.find((a) => a.startsWith("--out="))?.slice(6) ?? "/tmp/sideagent-fast-turn";
const TASK = process.argv.find((a) => a.startsWith("--task="))?.slice(7) ?? "把视频暂停";
const TIMEOUT_MS = 180_000;

/** 改变页面的动作（读类不算）。 */
const ACTION_TOOLS = new Set([
  "click", "fill", "type_text", "press_key", "scroll", "navigate", "open_tab", "switch_tab", "close_tab",
  "page_operation", "js", "mark", "clear_marks", "hover",
]);

function wav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const report: Record<string, unknown> = { model: MODEL, task: TASK, runs: [] as unknown[] };
  const server: Server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://local").pathname;
    if (pathname === "/tone.wav") {
      res.setHeader("Content-Type", "audio/wav");
      res.end(wav(Buffer.alloc(48000 * 120)));
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><meta charset="utf-8"><title>周末海边</title>
<style>body{font:20px sans-serif;padding:30px}video{width:600px;height:260px;background:#222}</style>
<h1>周末海边</h1>
<video id="movie" aria-label="周末海边视频" controls autoplay loop src="/tone.wav"></video>
<article>评论一：今天海风很舒服。</article>
<script>globalThis.pauseEvents=[];document.querySelector('video').addEventListener('pause',()=>pauseEvents.push(Date.now()));</script>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

  const iso = await launchIsolatedExtension();
  try {
    const results: Record<string, unknown>[] = [];
    for (let run = 1; run <= RUNS; run += 1) {
      const cid = `fast-${Date.now()}-${run}`;
      const out = join(iso.outDir, `run-${run}`);
      const store = new ConversationStore(join(out, "conversations"));
      const messages: ServerMessage[] = [];
      const bridge = new Set<Promise<unknown>>();
      /** 逐轮/逐工具时刻：仅测量，不影响运行路径。 */
      const marks: { kind: string; at: number }[] = [];
      const toolAt = new Map<string, { name: string; at: number; doneAt: number | null }>();
      let manager!: ConversationManager;
      const emit = (message: ServerMessage): void => {
        messages.push(message);
        if (message.type === "agent_event") {
          const kind = (message as { event?: { kind?: string } }).event?.kind;
          if (kind) marks.push({ kind, at: Date.now() });
        }
        if (message.type === "tool_call") {
          toolAt.set(message.id, { name: message.name, at: Date.now(), doneAt: null });
          const sessionId = message.sessionId ?? "main";
          const id = `fast-${message.name}-${messages.length}`;
          const job = (iso.swEval(
            `globalThis.__saCall(${JSON.stringify(id)}, ${JSON.stringify(message.name)}, ${JSON.stringify(message.params)}, ${JSON.stringify(sessionId)}, ${JSON.stringify((message as { programId?: string }).programId ?? null)}, ${JSON.stringify(cid)})`,
            60_000,
          ) as Promise<{ ok?: boolean; data?: unknown; error?: string }>)
            .then((reply) => {
              const entry = toolAt.get(message.id);
              if (entry) entry.doneAt = Date.now();
              return manager.handleMessage({
                type: "tool_result",
                conversationId: message.conversationId ?? cid,
                id: message.id,
                ok: reply?.ok === true,
                ...(reply?.ok === true ? { data: reply.data } : { error: String(reply?.error ?? "tool failed") }),
              } as ClientMessage);
            })
            .catch((error) => {
              const entry = toolAt.get(message.id);
              if (entry) entry.doneAt = Date.now();
              return manager.handleMessage({
                type: "tool_result",
                conversationId: message.conversationId ?? cid,
                id: message.id,
                ok: false,
                error: String(error),
              } as ClientMessage);
            });
          bridge.add(job);
          void job.finally(() => bridge.delete(job));
        }
      };
      manager = new ConversationManager(
        (id, emitServer, summary) => createConversationRuntime(id, emitServer, MODEL, {
          sessionManager: store.sessionManager(id),
          mode: summary?.mode,
        }),
        emit,
        store,
      );
      const entry = await manager.ensureDefault();
      if (!entry.runtime.session.available) throw new Error("模型会话不可用（凭据或 provider 未就绪）");

      let callSeq = 0;
      const call = (name: string, params: Record<string, unknown>, sessionId = "main"): Promise<{ ok?: boolean; data?: any; error?: string }> =>
        iso.swEval(
          `globalThis.__saCall(${JSON.stringify(`fast-${name}-${++callSeq}`)}, ${JSON.stringify(name)}, ${JSON.stringify(params)}, ${JSON.stringify(sessionId)}, undefined, ${JSON.stringify(cid)})`,
          60_000,
        ) as Promise<{ ok?: boolean; data?: any; error?: string }>;

      // 打开页面、切到工作页，确认视频真的在播。
      const opened = await call("open_tab", { url });
      const tabId = opened?.data?.tabId as number;
      const switched = await call("switch_tab", { tabId });
      if (opened?.ok !== true || typeof tabId !== "number") throw new Error(`open_tab 失败：${JSON.stringify(opened)}`);
      if (switched?.ok !== true) throw new Error(`switch_tab 失败：${JSON.stringify(switched)}`);
      const media = (): Promise<{ paused: boolean; time: number; events: number[] }> => iso.swEval(
        `chrome.scripting.executeScript({target:{tabId:${tabId}},world:'MAIN',func:()=>{const v=document.querySelector('video');return {paused:v.paused,time:v.currentTime,events:globalThis.pauseEvents};}}).then(r=>r[0].result)`,
      ) as Promise<{ paused: boolean; time: number; events: number[] }>;
      let ready = false;
      let lastMedia: unknown;
      await iso.swEval(`chrome.tabs.update(${tabId},{active:true}).catch(()=>{})`).catch(() => {});
      for (let n = 0; n < 60 && !ready; n += 1) {
        if (n === 6) {
          await iso.swEval(
            `chrome.scripting.executeScript({target:{tabId:${tabId}},world:'MAIN',func:()=>{const v=document.querySelector('video');v.muted=true;return v.play().catch(()=>{});}}).then(()=>true)`,
          ).catch(() => {});
        }
        const state = await media().catch((error) => {
          lastMedia = String(error);
          return undefined;
        });
        if (!ready && state) lastMedia = state;
        // headless 后台页可能不推进媒体时钟；「不在暂停」就是可暂停的真实起点。
        ready = Boolean(state && !state.paused);
        if (!ready) await sleep(200);
      }
      if (!ready) throw new Error(`视频没有开始播放，夹具未就绪（${JSON.stringify(lastMedia)}）`);

      const context: PageContext = { tabId, url, title: "周末海边" };
      const startedAt = Date.now();
      let firstActionAt: number | null = null;
      let firstActionTool: string | null = null;
      await manager.handleMessage({ type: "user_message", text: TASK, context } as ClientMessage);
      const deadline = Date.now() + TIMEOUT_MS;
      while (Date.now() < deadline) {
        for (const message of messages) {
          if (message.type !== "tool_call") continue;
          if (firstActionAt === null && ACTION_TOOLS.has(message.name)) {
            firstActionAt = Date.now();
            firstActionTool = message.name;
          }
        }
        const runtime = manager.get("default")?.runtime;
        const running = runtime?.session.isStreaming() === true || runtime?.fleet.size;
        const ended = messages.some((m) => m.type === "agent_event" && m.event.kind === "agent_end");
        if (!running && ended && bridge.size === 0) break;
        await sleep(150);
      }
      await sleep(500);
      const finalMedia = await media();
      const turns = messages.filter((m) => m.type === "agent_event" && m.event.kind === "turn_start").length;
      const tools = messages.filter((m) => m.type === "tool_call").map((m) => (m as { name: string }).name);
      // 逐轮与逐工具耗时（测量）：turn_start→turn_end 为一轮，最后一个 turn_end→agent_end 是收尾空档。
      const turnStarts = marks.filter((m) => m.kind === "turn_start").map((m) => m.at);
      const turnEnds = marks.filter((m) => m.kind === "turn_end").map((m) => m.at);
      const agentEndAt = marks.filter((m) => m.kind === "agent_end").map((m) => m.at).at(-1) ?? null;
      const roundsMs = turnStarts.map((at, index) => (turnEnds[index] === undefined ? null : turnEnds[index] - at));
      const settledMs = agentEndAt !== null && turnEnds.length > 0 ? agentEndAt - turnEnds[turnEnds.length - 1] : null;
      const orderedToolCalls = [...toolAt.entries()]
        .map(([id, entry]) => ({ id, ...entry }))
        .sort((a, b) => a.at - b.at);
      const toolsMs = orderedToolCalls
        .filter((entry) => entry.doneAt !== null)
        .map((entry) => ({ name: entry.name, ms: (entry.doneAt as number) - entry.at }));
      // 预注入的观察发生在第一轮之前（运行时读页面），模型自己发的 snapshot 在轮内。
      const firstTurnStart = turnStarts[0] ?? null;
      const preObserved = orderedToolCalls.length > 0
        && orderedToolCalls[0].name === "snapshot"
        && (firstTurnStart === null || orderedToolCalls[0].at <= firstTurnStart);
      const modelTools = orderedToolCalls
        .filter((entry) => firstTurnStart !== null && entry.at > firstTurnStart)
        .map((entry) => entry.name);
      const deliveries = messages
        .filter((m) => m.type === "agent_event" && m.event.kind === "user_delivery")
        .map((m) => (m as { event: { delivery?: { kind?: string; text?: string } } }).event.delivery)
        .filter((d) => d && d.kind !== "ack");
      const runResult = {
        run,
        rounds: turns,
        roundsMs,
        settledMs,
        toolsMs,
        preObserved,
        modelTools,
        firstActionMs: firstActionAt === null ? null : firstActionAt - startedAt,
        firstActionTool,
        totalMs: Date.now() - startedAt,
        tools,
        deliveryCount: deliveries.length,
        deliveryText: deliveries.map((d) => d?.text ?? "").join("\n").slice(0, 2000),
        paused: finalMedia.paused,
        pauseEvents: finalMedia.events.length,
        ok: finalMedia.paused && finalMedia.events.length === 1 && turns <= 2 && (firstActionAt !== null && firstActionAt - startedAt <= 5000) && deliveries.length === 1,
      };
      results.push(runResult);
      console.log(JSON.stringify(runResult));
      await writeFile(join(out, "run.json"), JSON.stringify(runResult, null, 2));
      entry.runtime.dispose();
      for (const id of messages.filter((m) => m.type === "tool_call" && (m as { name: string }).name === "open_tab").map(() => tabId)) {
        await iso.swEval(`chrome.tabs.remove(${id}).catch(()=>{})`).catch(() => {});
      }
    }
    report.runs = results;
    // 中位数按排序后的样本取（上一版的写法在样本乱序时取错元素，属测量修正）。
    const median = (values: number[]): number | null => {
      if (values.length === 0) return null;
      const sorted = [...values].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
    };
    report.summary = {
      rounds: results.map((r) => r.rounds),
      firstActionMs: results.map((r) => r.firstActionMs),
      totalMs: results.map((r) => r.totalMs),
      deliveryCount: results.map((r) => r.deliveryCount),
      allPaused: results.every((r) => r.paused === true),
      okCount: results.filter((r) => r.ok === true).length,
      roundsMedian: median(results.map((r) => r.rounds as number)),
      totalMsMedian: median(results.map((r) => r.totalMs as number)),
      firstActionMsMedian: median(results.map((r) => r.firstActionMs as number).filter((v) => v !== null)),
      preObserved: results.map((r) => r.preObserved === true),
    };
    console.log(JSON.stringify({ summary: report.summary }));
  } finally {
    await iso.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await writeFile(join(OUT, "report.json"), JSON.stringify(report, null, 2));
  }
}

await main();
