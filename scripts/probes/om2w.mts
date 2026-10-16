// npx tsx scripts/probes/om2w.mts <tasks.jsonl> [--model=provider/id] [--cap=240] [--only=id1,id2] [--out=out/om2w]
// Runs Online-Mind2Web style tasks ({task_id, website, task_description, reference_length} per line) through the real extension on live sites and records what the OM2W judge reads:
// out/om2w/<runStamp>/<task_id>/{trajectory/<step>.png, result.json, run.json, trace.jsonl, panel.png, final-page.png when the time cap stopped the run}. No judging here.
// Safety: a send confirmation is always answered 先不发; the runner never signs in or types anything into a site (fresh profile, no site logins).
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { LEAD_SESSION_ID, WORKING_TABS_STORAGE_KEY } from "../../shared/protocol.ts";
import { BUSY, send, startExt, traceLines, waitIdle } from "./ext-session.mts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const flag = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!file) throw new Error("用法：npx tsx scripts/probes/om2w.mts <tasks.jsonl> [--model=] [--cap=秒] [--only=] [--out=]");
const MODEL = flag("model") ?? "openai-codex/gpt-6-luna";
const CAP_MS = (Number(flag("cap")) || 240) * 1000;
const only = flag("only")?.split(",");
const runDir = join(resolve(flag("out") ?? join(root, "out/om2w")), new Date().toISOString().replace(/[:.]/g, "-"));

type Om2wTask = { task_id: string; website: string; task_description: string; reference_length: number };
const tasks = (await readFile(file, "utf8")).split("\n").filter((l) => l.trim()).map((l, i) => {
  const t = JSON.parse(l);
  if (typeof t.task_id !== "string" || typeof t.website !== "string" || typeof t.task_description !== "string") throw new Error(`第 ${i + 1} 行缺 task_id / website / task_description`);
  return { ...t, reference_length: Number(t.reference_length) || 0 } as Om2wTask;
}).filter((t) => !only || only.includes(t.task_id));

type Line = { type?: string; time?: string; toolCallId?: string; droppedEvents?: number; data?: any };
const parse = (l: string): Line => { try { return JSON.parse(l); } catch { return {}; } };
const at = (l: Line) => Date.parse(l.time ?? "") || 0;
/** An oversized record keeps only its type and toolCallId at the top level, so the tool's name comes from its start record. */
const callOf = (l: Line) => String(l.data?.toolCallId ?? l.toolCallId ?? "");
/** send_user_message carries the reply to the user, not an action on a site: it gets no step and no history line. */
const isToolEvent = (l: Line, names: Map<string, string>) => (l.type === "tool_execution_start" || l.type === "tool_execution_end") && names.get(callOf(l)) !== "send_user_message";
const noteStarts = (lines: Line[], names: Map<string, string>, args: Map<string, any>) => { for (const l of lines) if (l.type === "tool_execution_start") { names.set(callOf(l), String(l.data?.toolName ?? "")); args.set(callOf(l), l.data?.args); } };

/** Trace lines stored after primary key `after`. The connection is closed each time: an open one would block the extension's own version upgrade of this database. */
const traceAfter = async (rp: any, panel: string, after: number) => (await rp.evaluate(panel, `new Promise((ok) => { const r = indexedDB.open("sideagent-diagnostics"); r.onerror = () => ok({ keys: [], lines: [] }); r.onsuccess = () => { const db = r.result; if (!db.objectStoreNames.contains("trace-lines")) { db.close(); return ok({ keys: [], lines: [] }); } const s = db.transaction("trace-lines").objectStore("trace-lines"); const range = IDBKeyRange.lowerBound(${after}, true); const k = s.getAllKeys(range); const v = s.getAll(range); v.onsuccess = () => { db.close(); ok({ keys: k.result, lines: v.result.map((x) => x.line) }); }; }; })`)) as { keys: number[]; lines: string[] };

/**
 * The tab the agent works in is the extension's working-tab pointer (the default conversation's lead session), not the active tab:
 * the agent often acts in a background tab while the user keeps theirs. chrome.debugger.getTargets maps that tab to a CDP target without attaching.
 */
const WORKING_TAB = `(async () => { const m = (await chrome.storage.session.get(${JSON.stringify(WORKING_TABS_STORAGE_KEY)}))[${JSON.stringify(WORKING_TABS_STORAGE_KEY)}] ?? {}; let id = typeof m[${JSON.stringify(LEAD_SESSION_ID)}] === "number" ? m[${JSON.stringify(LEAD_SESSION_ID)}] : Object.values(m).find((v) => typeof v === "number"); if (id == null) id = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id; const t = (await chrome.debugger.getTargets()).find((x) => x.tabId === id); return { tabId: id ?? null, targetId: t?.id ?? null, url: t?.url ?? "" }; })()`;

const chars = (v: unknown) => `«${typeof v === "string" ? v.length : JSON.stringify(v ?? "").length} chars»`;
/** Scheme, host and path only: a query string can carry what the agent typed. */
const urlTarget = (u: string) => { try { const x = new URL(u); return x.origin + x.pathname + (x.search || x.hash ? ` ?${chars(x.search + x.hash)}` : ""); } catch { return chars(u); } };
/**
 * One factual line: tool, what it acted on, and whether it succeeded. Typed values and the model's free-text labels become their length and tool results are not copied,
 * so names, emails or page readbacks never reach result.json.
 */
function historyLine(tool: string, a: any, end: Line) {
  a ??= {};
  const target = [a.action, a.label !== undefined ? `label: ${chars(a.label)}` : undefined, a.target, typeof a.url === "string" ? urlTarget(a.url) : undefined, a.key, a.tabId !== undefined ? `tab ${a.tabId}` : undefined,
    ...(["value", "values", "text"] as const).map((k) => (a[k] !== undefined ? `${k}: ${chars(a[k])}` : undefined))]
    .filter((x) => x !== undefined && x !== "").map(String).join(" ");
  const outcome = end.data?.isError === true ? "error" : end.data?.isError === false ? "ok" : "unknown";
  return `${tool}${target ? ` ${target.replace(/\s+/g, " ").slice(0, 200)}` : ""} → ${outcome}`;
}

type Shot = { file: string | null; capturedAt: number; doneAt: number; tabId: number | null; url: string; error?: string };

async function runTask(task: Om2wTask, dir: string) {
  await mkdir(join(dir, "trajectory"), { recursive: true });
  const { rp, user, sw, panel, harness: { sleep } } = await startExt(root, { model: MODEL, tabs: [task.website] });
  const names = new Map<string, string>(), argsOf = new Map<string, any>(), shots = new Map<string, Shot>();
  let denied = 0, lastKey = 0, deadline = Infinity;
  const sessions = new Map<string, string>();
  const shootWorkingTab = async (file: string): Promise<Shot> => {
    const w = (await rp.evaluate(sw, WORKING_TAB).catch((e: Error) => ({ tabId: null, targetId: null, url: "", error: String(e) }))) as { tabId: number | null; targetId: string | null; url: string; error?: string };
    const shot: Shot = { file: null, capturedAt: Date.now(), doneAt: Date.now(), tabId: w.tabId, url: w.url, error: w.error };
    if (!w.targetId) { shot.error ??= "工作标签页没有对应的调试目标"; return shot; }
    try {
      if (!sessions.has(w.targetId)) sessions.set(w.targetId, await rp.attach(w.targetId));
      shot.capturedAt = Date.now();
      // Bounded by the deadline, so a slow capture cannot hold off the stop at the time cap.
      const { data } = await rp.cdp.send("Page.captureScreenshot", { format: "png" }, sessions.get(w.targetId), Math.max(1, Math.min(10_000, deadline - Date.now())));
      shot.doneAt = Date.now();
      await writeFile(join(dir, file), Buffer.from(data, "base64"));
      shot.file = file;
    } catch (e) { shot.error = String(e).slice(0, 200); }
    return shot;
  };
  const tick = async () => {
    if (Date.now() >= deadline) return; // nothing after the deadline belongs to the run
    const got = await traceAfter(rp, panel, lastKey).catch(() => ({ keys: [], lines: [] }));
    if (got.keys.length) lastKey = got.keys.at(-1)!;
    const lines = got.lines.map(parse);
    noteStarts(lines, names, argsOf);
    // Each end is shot as soon as it is read. Whether the page could already be a later one is judged afterwards from the trace times.
    for (const l of lines) if (l.type === "tool_execution_end" && isToolEvent(l, names) && Date.now() < deadline) shots.set(callOf(l), await shootWorkingTab(join("trajectory", `${shots.size + 1}.png`)));
    // A trusted click on the panel card's 先不发 answers the same wait as the page's own confirmation box.
    if (await rp.evaluate(panel, `(() => { const b = document.querySelector(".send-confirm .send-confirm-no:not([disabled])"); if (!b) return false; b.scrollIntoView({ block: "center" }); return true; })()`)) {
      await rp.click(panel, ".send-confirm .send-confirm-no:not([disabled])"); denied++;
      console.log(`  ${task.task_id} 发送确认：已点「先不发」`);
    }
  };
  let capped = false, error: string | undefined, ms = 0, finalPage: Shot | undefined;
  try {
    await rp.cdp.send("Page.bringToFront", {}, user); await sleep(600);
    const t0 = Date.now();
    deadline = t0 + CAP_MS;
    await send(rp, panel, task.task_description);
    const r = await waitIdle(rp, panel, t0, CAP_MS, tick);
    ms = r.ms;
    capped = r.capped;
    if (capped) {
      // The panel's stop button: the same stop a user presses. Then one look at the page the agent was on.
      if (await rp.evaluate(panel, `!!document.querySelector("#send-btn.stopping")`)) await rp.click(panel, "#send-btn");
      for (const by = Date.now() + 15_000; Date.now() < by && (await rp.evaluate(panel, BUSY)); ) await sleep(250);
      finalPage = await shootWorkingTab("final-page.png");
    } else { await sleep(1500); await tick(); } // trace writes are queued, so the last tool ends may land after the panel goes quiet
  } catch (e) { error = String(e); }
  try {
    const all = (await traceLines(rp, panel)).split("\n").filter(Boolean);
    await writeFile(join(dir, "trace.jsonl"), all.join("\n") + "\n");
    await rp.screenshot(panel, join(dir, "panel.png")).catch(() => {});
    const lines = all.map(parse);
    noteStarts(lines, names, argsOf);
    // The panel waits 4 s of quiet before calling a run done, so a run that ended just before the deadline still reaches it: the trace's agent_end decides.
    const lifecycle = lines.filter((l) => (l.type === "agent_start" || l.type === "agent_end") && at(l) <= deadline).at(-1);
    if (capped && lifecycle?.type === "agent_end") capped = false;
    // The extension records an abort when the stop button ends the run; without it the agent may have kept working after the deadline.
    const stopConfirmed = capped ? lines.some((l) => l.type === "abort" && at(l) >= deadline) : undefined;
    const traceIncomplete = lines.some((l) => l.type === "trace_limit" || l.droppedEvents);
    const tools = lines.filter((l) => isToolEvent(l, names));
    const ends = tools.filter((l) => l.type === "tool_execution_end");
    const postCap = ends.filter((l) => at(l) > deadline).map((l) => ({ tool: names.get(callOf(l)) ?? "", toolCallId: callOf(l), status: "post_cap" }));
    const inRun = ends.filter((l) => at(l) <= deadline);
    // Started but never finished, e.g. cut off by the stop at the time cap: the page may already show part of it (final-page.png).
    const inFlight = tools.filter((l) => l.type === "tool_execution_start" && !ends.some((e) => callOf(e) === callOf(l))).map((l) => names.get(callOf(l)) ?? "");
    const steps = inRun.map((l, i) => {
      const shot = shots.get(callOf(l));
      // Late: another tool started or finished between this end and the moment the capture returned, so the image may show a later page.
      const late = !!shot && tools.some((o) => callOf(o) !== callOf(l) && at(o) >= at(l) && at(o) <= shot.doneAt);
      return { step: i + 1, tool: names.get(callOf(l)) ?? "", toolCallId: callOf(l), status: !shot?.file ? "missing" : late ? "screenshot_late" : "on_time", screenshot: shot?.file?.replace(/^trajectory\//, "") ?? null, tabId: shot?.tabId ?? null, url: shot?.url ?? "", error: shot?.error };
    });
    const action_history = inRun.map((l) => historyLine(names.get(callOf(l)) ?? "", argsOf.get(callOf(l)), l));
    // The last thing delivered to the user: a send_user_message finding (its text is the content argument) or the model's own reply text, whichever came later.
    // The model's text comes from the trace: the panel's innerText would add button labels (复制, 来源) to it.
    let agent_final_answer = "";
    for (const l of lines.filter((x) => at(x) <= deadline)) {
      // Text sent together with a tool call is narration of the next step, not an answer.
      if (l.type === "message_end" && l.data?.message?.role === "assistant" && !(l.data.message.content ?? []).some((c: any) => c?.type === "toolCall")) { const t = (l.data.message.content ?? []).map((c: any) => (c?.type === "text" ? String(c.text) : "")).join("").trim(); if (t) agent_final_answer = t; }
      const a = argsOf.get(callOf(l));
      if (l.type === "tool_execution_end" && names.get(callOf(l)) === "send_user_message" && l.data?.isError !== true && a?.kind === "finding" && typeof a.content === "string" && a.content.trim()) agent_final_answer = a.content.trim();
    }
    // final_result_response repeats the answer: the official judge reads a string action_history as its v1 format, which takes the answer from that key.
    await writeFile(join(dir, "result.json"), JSON.stringify({ task: task.task_description, task_id: task.task_id, reference_length: task.reference_length, agent_final_answer, final_result_response: agent_final_answer, action_history }, null, 2));
    const stopped_reason = error ? "error" : traceIncomplete ? "trace_incomplete" : capped ? "time_cap" : denied ? "confirm_denied" : "finished";
    const run = { task_id: task.task_id, website: task.website, model: MODEL, stopped_reason, error, seconds: +(ms / 1000).toFixed(1), capSeconds: CAP_MS / 1000, capped, stopConfirmed, traceIncomplete, confirmDenied: denied, actions: action_history.length, steps, postCap, inFlight, finalPage };
    await writeFile(join(dir, "run.json"), JSON.stringify(run, null, 2));
    return run;
  } finally { await rp.close(); await rp.remove(); }
}

await mkdir(runDir, { recursive: true });
console.log(`om2w → ${runDir}（${tasks.length} 个任务，${MODEL}，每个最多 ${CAP_MS / 1000} 秒）`);
for (const task of tasks) {
  console.log(`▶ ${task.task_id} ${task.website}`);
  const dir = join(runDir, task.task_id.replace(/[^\w.-]/g, "_"));
  try {
    const r = await runTask(task, dir);
    const count = (s: string) => r.steps.filter((x) => x.status === s).length;
    if (r.capped && !r.stopConfirmed) console.log(`  警告：${task.task_id} 到时后没看到扩展停下（记录里没有 abort），助手可能还在继续做`);
    if (r.traceIncomplete) console.log(`  警告：${task.task_id} 的扩展记录不完整（trace_limit 或丢了事件），这次结果不能当完整轨迹用`);
    console.log(`${r.stopped_reason === "finished" && count("on_time") === r.actions ? "✔" : "!"} ${task.task_id} ${r.stopped_reason} ${r.seconds}s actions=${r.actions} on_time=${count("on_time")} late=${count("screenshot_late")} missing=${count("missing")} post_cap=${r.postCap.length}${r.error ? " — " + r.error.slice(0, 200) : ""}`);
  } catch (e) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "run.json"), JSON.stringify({ task_id: task.task_id, website: task.website, model: MODEL, stopped_reason: "error", error: String(e) }, null, 2));
    console.log(`! ${task.task_id} error — ${String(e).slice(0, 200)}`);
  }
}
console.log(`done ${runDir}`);
