// Probe: capture every model request the real extension sends during one task, with network timing.
// Isolated headless Chrome with the prebuilt extension; CDP Network on the extension's offscreen document (where the agent runs).
//
//   NODE_OPTIONS=--conditions=import npx tsx scripts/probes/request-replay/capture.mts [--task=点开第一行的第二个视频] [--url=https://www.youtube.com] [--model=openai-codex/gpt-6-luna] [--timeout=240] [--out=dir]
//
// Output dir (default out/probes/request-replay/<time>/, gitignored):
//   requests.jsonl    one line per model request: timing, SSE event timeline, usage, safe headers, body with images replaced by hash+length
//   bodies.raw.jsonl  original request bodies (images included) for replay.mts
//   summary.md/json   the table; traces.jsonl from the extension's diagnostics export; panel/page screenshots
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, exportDiagnosticsViaSettings, launchRealPath, sleep, until, type TargetInfo } from "../../acceptance/real-path/harness.mts";
import { DEFAULT_TEST_MODEL, loadModelPlan, modelStorageItems } from "../../acceptance/real-path/inproc-config.mts";
import { arg, imageCount, isOutputDelta, markdownTable, purposeGuess, redactImages, safeHeaders, sha256, sseParser, usageOf, type Body } from "./shared.mts";

const task = arg("task") ?? "点开第一行的第二个视频";
const startUrl = arg("url") ?? "https://www.youtube.com";
const modelArg = arg("model") ?? DEFAULT_TEST_MODEL;
const timeoutMs = Number(arg("timeout") ?? 240) * 1000;
const outDir = arg("out") ?? join(REPO, "out/probes/request-replay", new Date().toISOString().replace(/[:.]/g, "-"));

process.env.SIDEAGENT_ACCEPTANCE_DIST ??= join(REPO, "../By-Your-Side/extension/dist");

const MODEL_URL = /^https:\/\/chatgpt\.com\/backend-api\/.*responses(\?|$)/;

interface Captured {
  requestId: string; url: string; method: string; isModel: boolean;
  /** CDP monotonic seconds. */
  startTs: number; wallStartMs: number;
  headers: Record<string, string>;
  postData?: string; postDataError?: string;
  responseTs?: number; status?: number; responseHeaders?: Record<string, string>; timing?: Record<string, number>; protocol?: string; connectionReused?: boolean;
  dataTs: number[]; dataBytes: number; finishTs?: number; failed?: string;
  events: Array<[number, string]>; usage: ReturnType<typeof usageOf>; streamed: boolean; retryStream?: boolean; decoder?: TextDecoder; parse?: ReturnType<typeof sseParser>;
  inflightAtStart: string[];
}

await mkdir(outDir, { recursive: true });
const plan = await loadModelPlan(modelArg);
const rp = await launchRealPath();
const requests = new Map<string, Captured>();
const sessions = new Set<string>();
let sentWallMs = 0, finalAnswer = "", error: string | null = null;

const on = <P,>(method: string, fn: (p: P, sessionId: string) => void) => rp.cdp.onEvent(method, (m: { sessionId?: string; params: P }) => {
  if (m.sessionId && sessions.has(m.sessionId)) fn(m.params, m.sessionId);
});

const feed = (r: Captured, ts: number, base64: string) => {
  const text = r.decoder!.decode(Buffer.from(base64, "base64"), { stream: true });

  for (const e of r.parse!(text)) {
    r.events.push([Math.round((ts - r.startTs) * 1000), e.type]);

    if (e.type === "response.completed" || e.type === "response.done") r.usage = usageOf(e.data) ?? r.usage;
  }
};

on<{ requestId: string; timestamp: number; wallTime: number; request: { url: string; method: string; headers: Record<string, string>; postData?: string; hasPostData?: boolean } }>("Network.requestWillBeSent", (p, session) => {
  const isModel = p.request.method === "POST" && MODEL_URL.test(p.request.url);
  const inflight = [...requests.values()].filter(r => r.finishTs === undefined && !r.failed).map(r => r.requestId);
  const entry: Captured = {
    requestId: p.requestId, url: p.request.url, method: p.request.method, isModel, startTs: p.timestamp, wallStartMs: p.wallTime * 1000,
    headers: safeHeaders(p.request.headers), dataTs: [], dataBytes: 0, events: [], usage: null, streamed: false, inflightAtStart: inflight,
  };

  requests.set(p.requestId, entry);

  if (!isModel) return;
  entry.decoder = new TextDecoder();
  entry.parse = sseParser();

  if (p.request.postData !== undefined) entry.postData = p.request.postData;
  else if (p.request.hasPostData) {
    rp.cdp.send("Network.getRequestPostData", { requestId: p.requestId }, session).then(
      (r: { postData: string; base64Encoded?: boolean }) => { entry.postData = r.base64Encoded ? Buffer.from(r.postData, "base64").toString("utf8") : r.postData; },
      (e: Error) => { entry.postDataError = e.message; });
  }

  stream(entry, session, false);
});

/** Streaming makes dataReceived carry the bytes, so SSE events get their own arrival times. */
function stream(entry: Captured, session: string, last: boolean) {
  rp.cdp.send("Network.streamResourceContent", { requestId: entry.requestId }, session).then(
    (r: { bufferedData?: string }) => { entry.streamed = true; if (r.bufferedData) feed(entry, entry.dataTs[0] ?? entry.responseTs ?? entry.startTs, r.bufferedData); },
    (e: Error) => { if (last) entry.events.push([-1, `streamResourceContent failed: ${e.message}`]); else entry.retryStream = true; });
}

on<{ requestId: string; timestamp: number; response: { status: number; headers: Record<string, string>; timing?: Record<string, number>; protocol?: string; connectionReused?: boolean } }>("Network.responseReceived", (p, session) => {
  const r = requests.get(p.requestId);

  if (!r) return;
  Object.assign(r, { responseTs: p.timestamp, status: p.response.status, responseHeaders: safeHeaders(p.response.headers), timing: p.response.timing, protocol: p.response.protocol, connectionReused: p.response.connectionReused });

  if (r.retryStream) stream(r, session, true);
});

on<{ requestId: string; timestamp: number; dataLength: number; data?: string }>("Network.dataReceived", p => {
  const r = requests.get(p.requestId);

  if (!r) return;
  r.dataTs.push(p.timestamp);
  r.dataBytes += p.dataLength;

  if (r.isModel && p.data) feed(r, p.timestamp, p.data);
});

on<{ requestId: string; timestamp: number }>("Network.loadingFinished", p => { const r = requests.get(p.requestId); if (r) r.finishTs = p.timestamp; });
on<{ requestId: string; timestamp: number; errorText: string }>("Network.loadingFailed", p => { const r = requests.get(p.requestId); if (r) { r.finishTs = p.timestamp; r.failed = p.errorText; } });

const inprocUrl = `chrome-extension://${rp.extensionId}/inproc.html`;
const attachInproc = async (target: TargetInfo) => {
  const session = await rp.attach(target.targetId);
  sessions.add(session);
  await rp.cdp.send("Network.enable", { maxPostDataSize: 64 * 1024 * 1024, maxTotalBufferSize: 256 * 1024 * 1024, maxResourceBufferSize: 64 * 1024 * 1024 }, session);
  console.log(`network attached to offscreen document ${target.targetId}`);
};

// The offscreen document can be recreated; attach to each new one too.
rp.cdp.onEvent("Target.targetCreated", (m: { params: { targetInfo: TargetInfo } }) => {
  if (m.params.targetInfo.url === inprocUrl) attachInproc(m.params.targetInfo).catch(e => console.error(`attach failed: ${e}`));
});

try {
  await rp.cdp.send("Target.setDiscoverTargets", { discover: true });
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "work tab");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.navigate", { url: startUrl }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  await until(async () => (await rp.evaluate(panel, `document.querySelector('#send-btn')?.disabled === false`)) || undefined, 60_000, "side panel ready");
  await attachInproc(await until(async () => (await rp.targets()).find(t => t.url === inprocUrl), 30_000, "offscreen document"));
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(modelStorageItems(plan))}).then(() => true)`);
  await until(async () => (await rp.evaluate(work, `document.readyState === 'complete'`)) || undefined, 30_000, "start page loaded");
  await rp.cdp.send("Target.activateTarget", { targetId: blank.targetId });
  await sleep(3000);
  const before = [...requests.values()].filter(r => r.isModel).length;

  if (before) console.log(`${before} model request(s) before the task (kept, marked pre-task)`);
  const userMsgs = `document.querySelectorAll('#messages .msg.user').length`;
  const count0 = Number(await rp.evaluate(panel, userMsgs));
  // 真人点进输入框后要想、要打几秒字：--think-ms 模拟这段时间，提前建连接只能在这段时间里起作用。
  const thinkMs = Number(process.argv.find(a => a.startsWith("--think-ms="))?.slice(11) ?? 0);
  await rp.click(panel, "#input"); await sleep(thinkMs); await rp.typeText(panel, task);
  sentWallMs = Date.now();
  await rp.pressEnter(panel);
  await until(async () => Number(await rp.evaluate(panel, userMsgs)) > count0 || undefined, 15_000, "task sent");
  let stable = 0;
  await until(async () => {
    const idle = await rp.evaluate(panel, `!document.querySelector('#status-pill').classList.contains('running') && !document.querySelector('.msg.assistant.streaming, .msg.assistant[data-revealing]')`);
    stable = idle && Date.now() - sentWallMs > 3000 ? stable + 1 : 0;

    return stable >= 5 || undefined;
  }, timeoutMs, "task finished", 400);
  console.log(`task finished in ${Date.now() - sentWallMs}ms`);
  finalAnswer = String(await rp.evaluate(panel, `[...document.querySelectorAll('#messages .msg.assistant')].filter(x=>!x.closest('.run-steps')).at(-1)?.innerText ?? ''`));
  await rp.screenshot(panel, join(outDir, "panel.png"));
  await rp.screenshot(work, join(outDir, "page.png"));
  // Late side calls (e.g. a goal check after the visible answer) still finish.
  await until(async () => [...requests.values()].every(r => !r.isModel || r.finishTs !== undefined) || undefined, 30_000, "model requests finished").catch(e => console.error(String(e)));
  const diag = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(outDir, "diagnostics"));
  await writeFile(join(outDir, "traces.jsonl"), diag.traces);
} catch (e) { error = String(e); console.error(error); }
finally { await rp.close(); }

// ---------- trace correlation ----------

const traceLines = await import("node:fs/promises").then(fs => fs.readFile(join(outDir, "traces.jsonl"), "utf8")).catch(() => "");
const traces = traceLines.split("\n").filter(Boolean).flatMap(l => { try { return [JSON.parse(l) as { time: string; type: string; data: Record<string, unknown> }]; } catch { return []; } });
const modelRequestShas = new Set(traces.filter(t => t.type === "model_request").map(t => String(t.data.systemPromptSha256)));
const sideCalls = traces.filter(t => t.type === "side_call").map(t => ({ wallMs: Date.parse(t.time), purpose: String(t.data.purpose), used: false }));

// ---------- write ----------

const model = [...requests.values()].filter(r => r.isModel).sort((a, b) => a.startTs - b.startTs);
const indexOf = new Map(model.map((r, i) => [r.requestId, i]));
const ms = (from: number, to: number | undefined) => (to === undefined ? null : Math.round((to - from) * 1000));
const rows: Array<Record<string, unknown>> = [];
const lines: string[] = [], rawLines: string[] = [];

for (const [i, r] of model.entries()) {
  let body: Body | null = null;

  try { body = r.postData ? JSON.parse(r.postData) as Body : null; } catch { r.postDataError ??= "body is not JSON"; }
  const firstOutput = r.events.find(([, t]) => isOutputDelta(t))?.[0] ?? null;
  const firstEvent = r.events.find(([t]) => t >= 0)?.[0] ?? null;
  const endWallMs = r.wallStartMs + (ms(r.startTs, r.finishTs) ?? 0);
  const side = sideCalls.find(s => !s.used && s.wallMs >= endWallMs - 50 && s.wallMs - endWallMs < 3000);
  const instructionsSha = typeof body?.instructions === "string" ? sha256(body.instructions) : "";
  let purpose = body ? purposeGuess(body) : "unknown (no body)";

  if (instructionsSha && modelRequestShas.has(instructionsSha)) purpose = `main (traced model_request, ${body!.tools?.length ?? 0} tools)`;
  else if (side) { side.used = true; purpose = `side_call:${side.purpose}`; }
  const inflightModel = r.inflightAtStart.filter(id => indexOf.has(id)).map(id => indexOf.get(id));
  const inflightOther = r.inflightAtStart.filter(id => !indexOf.has(id)).map(id => requests.get(id)!.url.replace(/\?.*$/, ""));
  const record = {
    index: i, purpose, preTask: r.wallStartMs < sentWallMs, sinceSendMs: Math.round(r.wallStartMs - sentWallMs), url: r.url, status: r.status ?? null, failed: r.failed ?? null,
    bodyBytes: r.postData ? Buffer.byteLength(r.postData) : null, postDataError: r.postDataError ?? null,
    images: body ? imageCount(body) : null, effort: body?.reasoning?.effort ?? null, inputItems: body?.input?.length ?? null, tools: body?.tools?.length ?? null,
    instructionsSha8: instructionsSha.slice(0, 8), promptCacheKey: body?.prompt_cache_key ?? null,
    timing: {
      headersMs: ms(r.startTs, r.responseTs), firstDataMs: ms(r.startTs, r.dataTs[0]), firstEventMs: firstEvent, firstOutputDeltaMs: firstOutput, totalMs: ms(r.startTs, r.finishTs),
      dataReceivedCount: r.dataTs.length, firstDataMsList: r.dataTs.slice(0, 5).map(t => ms(r.startTs, t)), dataBytes: r.dataBytes,
      /** Chrome ResourceTiming: ms offsets from timing.requestTime; -1 = not applicable (e.g. reused connection). */
      chrome: r.timing ?? null, queuedBeforeRequestTimeMs: r.timing ? Math.round((r.timing.requestTime - r.startTs) * 1000) : null,
      protocol: r.protocol ?? null, connectionReused: r.connectionReused ?? null,
    },
    usage: r.usage, inflightAtStart: { modelRequests: inflightModel, other: inflightOther },
    sseStreamed: r.streamed, events: r.events,
    requestHeaders: r.headers, responseHeaders: r.responseHeaders ?? null,
    body: body ? redactImages(body).value : null,
  };

  lines.push(JSON.stringify(record));

  if (body) rawLines.push(JSON.stringify({ index: i, url: r.url, requestHeaders: r.headers, body }));
  rows.push({
    i, purpose, sinceSend: record.sinceSendMs, kB: record.bodyBytes === null ? null : Math.round(record.bodyBytes / 1024), img: record.images, effort: record.effort, items: record.inputItems, tools: record.tools,
    inflight: inflightModel.join(",") || "-", reused: r.connectionReused ? "y" : "n", headers: record.timing.headersMs, firstData: record.timing.firstDataMs, firstOutput: firstOutput, total: record.timing.totalMs,
    inTok: r.usage?.input ?? null, cached: r.usage?.cached ?? null, outTok: r.usage?.output ?? null, reasonTok: r.usage?.reasoning ?? null, status: `${r.status ?? "-"}${r.failed ? ` ${r.failed}` : ""}`,
  });
}

await writeFile(join(outDir, "requests.jsonl"), lines.join("\n") + (lines.length ? "\n" : ""));
await writeFile(join(outDir, "bodies.raw.jsonl"), rawLines.join("\n") + (rawLines.length ? "\n" : ""));
const unusedSide = sideCalls.filter(s => !s.used).map(s => s.purpose);
const meta = { model: modelArg, task, startUrl, dist: process.env.SIDEAGENT_ACCEPTANCE_DIST, sentAt: new Date(sentWallMs).toISOString(), error, finalAnswer: finalAnswer.slice(0, 500), modelRequests: model.length, otherRequests: requests.size - model.length, sideCallsInTrace: sideCalls.map(s => s.purpose), unmatchedSideCalls: unusedSide };
await writeFile(join(outDir, "summary.json"), JSON.stringify({ meta, rows }, null, 2));
const table = markdownTable(rows);
await writeFile(join(outDir, "summary.md"), `# capture ${meta.sentAt}\n\nmodel ${modelArg} · task ${task} · url ${startUrl}\n\nTimes in ms from requestWillBeSent; sinceSend = request start minus the Enter press.\n\n${table}\nside_call records in trace: ${meta.sideCallsInTrace.join(", ") || "none"}; unmatched: ${unusedSide.join(", ") || "none"}\n`);
console.log(table);
console.log(`answer: ${finalAnswer.slice(0, 160).replace(/\n/g, " ")}`);
console.log(outDir);

if (error) process.exitCode = 1;
process.exit();
