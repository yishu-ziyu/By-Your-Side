// npx tsx scripts/probes/om2w.mts <tasks.jsonl> [--model=provider/id] [--cap=240] [--only=id1,id2] [--out=out/om2w]
// Runs Online-Mind2Web style tasks ({task_id, website, task_description, reference_length} per line) through the real extension on live sites and records what the OM2W judge reads:
// out/om2w/<runStamp>/<task_id>/{trajectory/<step>.png, result.json, run.json, trace.jsonl, panel.png}. No judging here.
// Safety: a send confirmation is always answered 先不发; the runner never signs in or types anything into a site (fresh profile, no site logins).
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { LEAD_SESSION_ID, WORKING_TABS_STORAGE_KEY } from "../../shared/protocol.ts";
import { send, startExt, traceLines, waitIdle } from "./ext-session.mts";

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

type Line = { type?: string; data?: any };
const parse = (l: string): Line => { try { return JSON.parse(l); } catch { return {}; } };
/** send_user_message carries the reply to the user, not an action on a site: it gets no step and no history line. */
const isAction = (l: Line) => l.type === "tool_execution_end" && l.data?.toolName !== "send_user_message";

/** Trace lines stored after primary key `after`. The connection is closed each time: an open one would block the extension's own version upgrade of this database. */
const traceAfter = async (rp: any, panel: string, after: number) => (await rp.evaluate(panel, `new Promise((ok) => { const r = indexedDB.open("sideagent-diagnostics"); r.onerror = () => ok({ keys: [], lines: [] }); r.onsuccess = () => { const db = r.result; if (!db.objectStoreNames.contains("trace-lines")) { db.close(); return ok({ keys: [], lines: [] }); } const s = db.transaction("trace-lines").objectStore("trace-lines"); const range = IDBKeyRange.lowerBound(${after}, true); const k = s.getAllKeys(range); const v = s.getAll(range); v.onsuccess = () => { db.close(); ok({ keys: k.result, lines: v.result.map((x) => x.line) }); }; }; })`)) as { keys: number[]; lines: string[] };

/**
 * The tab the agent works in is the extension's working-tab pointer (the default conversation's lead session), not the active tab:
 * the agent often acts in a background tab while the user keeps theirs. chrome.debugger.getTargets maps that tab to a CDP target without attaching.
 */
const WORKING_TAB = `(async () => { const m = (await chrome.storage.session.get(${JSON.stringify(WORKING_TABS_STORAGE_KEY)}))[${JSON.stringify(WORKING_TABS_STORAGE_KEY)}] ?? {}; let id = typeof m[${JSON.stringify(LEAD_SESSION_ID)}] === "number" ? m[${JSON.stringify(LEAD_SESSION_ID)}] : Object.values(m).find((v) => typeof v === "number"); if (id == null) id = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id; const t = (await chrome.debugger.getTargets()).find((x) => x.tabId === id); return { tabId: id ?? null, targetId: t?.id ?? null, url: t?.url ?? "" }; })()`;

const resultText = (r: any): string => (Array.isArray(r?.content) ? r.content : []).map((c: any) => (c?.type === "text" ? String(c.text) : "")).join("").trim();
const clip = (s: string, n: number) => { const one = s.replace(/\s+/g, " ").trim(); return one.length > n ? one.slice(0, n - 1) + "…" : one; };
/** One factual line: tool, what it acted on, and the tool's own first result line. */
function historyLine(args: any, end: Line) {
  const a = args ?? {};
  const target = [a.action, a.label, a.target, a.url, a.key, a.value !== undefined ? `value=${JSON.stringify(a.value)}` : undefined, a.values !== undefined ? `values=${JSON.stringify(a.values)}` : undefined, a.tabId !== undefined ? `tab ${a.tabId}` : undefined]
    .filter((x) => x !== undefined && x !== "").map(String).join(" ");
  const text = resultText(end.data?.result);
  // A result that is only page content (e.g. a browser_run returning a snapshot) is summarised as the page it ended on.
  const first = text.startsWith("<page-content") ? `page ${JSON.stringify(text.match(/RootWebArea \\*"(.*?)\\*"/)?.[1] ?? "content returned")}` : text.split("\n").find((l) => l.trim()) ?? "";
  return `${end.data?.toolName}${target ? ` ${clip(target, 160)}` : ""} → ${end.data?.isError ? "error: " : ""}${clip(first, 200) || (end.data?.isError ? "failed" : "done")}`;
}

async function runTask(task: Om2wTask, dir: string) {
  await mkdir(join(dir, "trajectory"), { recursive: true });
  const { rp, user, sw, panel, harness: { sleep } } = await startExt(root, { model: MODEL, tabs: [task.website] });
  const steps: { step: number; tool: string; tabId: number | null; url: string; screenshot: string | null; error?: string }[] = [];
  let denied = 0, lastKey = 0;
  const sessions = new Map<string, string>();
  const shoot = async (tool: string) => {
    const step = steps.length + 1;
    const w = (await rp.evaluate(sw, WORKING_TAB).catch((e: Error) => ({ tabId: null, targetId: null, url: "", error: String(e) }))) as { tabId: number | null; targetId: string | null; url: string; error?: string };
    const row = { step, tool, tabId: w.tabId, url: w.url, screenshot: null as string | null, error: w.error };
    steps.push(row);
    if (!w.targetId) { row.error ??= "工作标签页没有对应的调试目标"; return; }
    try {
      if (!sessions.has(w.targetId)) sessions.set(w.targetId, await rp.attach(w.targetId));
      const { data } = await rp.cdp.send("Page.captureScreenshot", { format: "png" }, sessions.get(w.targetId), 10_000);
      await writeFile(join(dir, "trajectory", `${step}.png`), Buffer.from(data, "base64"));
      row.screenshot = `${step}.png`;
    } catch (e) { row.error = String(e).slice(0, 200); }
  };
  const tick = async () => {
    const got = await traceAfter(rp, panel, lastKey).catch(() => ({ keys: [], lines: [] }));
    if (got.keys.length) lastKey = got.keys.at(-1)!;
    for (const l of got.lines.map(parse)) if (isAction(l)) await shoot(String(l.data.toolName));
    // A trusted click on the panel card's 先不发 answers the same wait as the page's own confirmation box.
    if (await rp.evaluate(panel, `(() => { const b = document.querySelector(".send-confirm .send-confirm-no:not([disabled])"); if (!b) return false; b.scrollIntoView({ block: "center" }); return true; })()`)) {
      await rp.click(panel, ".send-confirm .send-confirm-no:not([disabled])"); denied++;
      console.log(`  ${task.task_id} 发送确认：已点「先不发」`);
    }
  };
  let reason = "finished", error: string | undefined, ms = 0;
  try {
    await rp.cdp.send("Page.bringToFront", {}, user); await sleep(600);
    const t0 = Date.now();
    await send(rp, panel, task.task_description);
    const r = await waitIdle(rp, panel, t0, CAP_MS, tick);
    ms = r.ms;
    if (r.capped) reason = "time_cap";
    await sleep(1500); await tick(); // trace writes are queued, so the last tool ends may land after the panel goes quiet
  } catch (e) { reason = "error"; error = String(e); }
  try {
    if (denied && reason !== "error") reason = "confirm_denied";
    const all = (await traceLines(rp, panel)).split("\n").filter(Boolean);
    await writeFile(join(dir, "trace.jsonl"), all.join("\n") + "\n");
    await rp.screenshot(panel, join(dir, "panel.png")).catch(() => {});
    const lines = all.map(parse);
    const argsOf = new Map(lines.filter((l) => l.type === "tool_execution_start").map((l) => [l.data?.toolCallId, l.data?.args]));
    const action_history = lines.filter(isAction).map((l) => historyLine(argsOf.get(l.data?.toolCallId), l));
    // The model's own last reply text: the panel's innerText would add button labels (复制, 来源) to it.
    const agent_final_answer = lines.filter((l) => l.type === "message_end" && l.data?.message?.role === "assistant").map((l) => (l.data.message.content ?? []).map((c: any) => (c?.type === "text" ? String(c.text) : "")).join("").trim()).filter(Boolean).at(-1) ?? "";
    // final_result_response repeats the answer: the official judge reads a string action_history as its v1 format, which takes the answer from that key.
    await writeFile(join(dir, "result.json"), JSON.stringify({ task: task.task_description, task_id: task.task_id, reference_length: task.reference_length, agent_final_answer, final_result_response: agent_final_answer, action_history }, null, 2));
    const run = { task_id: task.task_id, website: task.website, model: MODEL, stopped_reason: reason, error, seconds: +(ms / 1000).toFixed(1), capSeconds: CAP_MS / 1000, confirmDenied: denied, actions: action_history.length, steps };
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
    const shots = r.steps.filter((s) => s.screenshot).length;
    console.log(`${r.stopped_reason === "finished" && shots === r.actions ? "✔" : "!"} ${task.task_id} ${r.stopped_reason} ${r.seconds}s actions=${r.actions} screenshots=${shots}${r.error ? " — " + r.error.slice(0, 200) : ""}`);
  } catch (e) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "run.json"), JSON.stringify({ task_id: task.task_id, website: task.website, model: MODEL, stopped_reason: "error", error: String(e) }, null, 2));
    console.log(`! ${task.task_id} error — ${String(e).slice(0, 200)}`);
  }
}
console.log(`done ${runDir}`);
