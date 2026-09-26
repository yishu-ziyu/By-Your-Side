/**
 * Current vs narrow-question Jev design — controlled comparison (bys-jev-build-r1, 2026-09-26).
 * Every run starts a fresh isolated headless Chrome for Testing with a temporary profile and an isolated
 * extension build; the daily profile and daily extension/dist are never touched.
 *
 * Decision layer (--arms=current,new): same pages, executor, 0.85 threshold and Jev model; only the way the
 * product asks Jev differs. `current` runs main's implementation unchanged from a `git archive` of the base
 * ref (--base, default main) extracted under out/; `new` runs this worktree's product code.
 *   S5rt   realtime judge entry: judge → hover → fresh judge → click → judge again (page oracle: Settings once)
 *   S5loop browser_loop entry for the same page
 *   S6     browser_loop: read on, click Late-Target once
 *   S6N    browser_loop on a page without the target: zero clicks
 *   H1–H8  held-out tasks (fixtures.mts heldOutPages), browser_loop entry
 *   D1–D5  development pages (fixtures.mts devPages), in-sample only
 * End to end (--arms=split,direct): E5/E6/E6N with the new loop, then the production handoff to the main
 * model; `direct` additionally lets the loop's own done judgment end the task (browser-loop-delivery.ts).
 *
 * Usage:
 *   npx tsx scripts/acceptance/jev-compare/run.mts --headless --tasks=S5rt,S6 --arms=current,new --rounds=30 \
 *     --name=<batch> [--extra-tabs=3] [--start-round=N] [--main-model=zai-coding-cn/glm-5.3-flash]
 * Output: out/jev-compare/<name>/results.jsonl (one line per run) and runs/<task>-<arm>-<round>-tabs<n>.json.
 * Credentials are read only through the project's own paths (typesafe-auth, pi ModelRuntime); never printed.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { freemem, loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ToolName } from "../../../shared/protocol.js";
import { decisionFixturePages, devPages, heldOutPages } from "./fixtures.mts";
import { trackTempDir } from "../temp-profile.mjs";

if (!process.argv.includes("--headless")) {
  console.error("Required: --headless (isolated --headless=new only)");
  process.exit(2);
}

const arg = (name: string, fallback?: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const tasks = (arg("tasks") ?? "").split(",").filter(Boolean);

const arms = (arg("arms") ?? "current,new").split(",").filter(Boolean);

const rounds = Number(arg("rounds", "1"));

const extraTabs = Number(arg("extra-tabs", "0"));

const mainModelId = arg("main-model", "zai-coding-cn/glm-5.3-flash")!;

const name = arg("name", `run-${Date.now()}`)!;

const startRound = Number(arg("start-round", "0"));

const baseRef = arg("base", "main")!;

const DECISION_TASKS = ["S5rt", "S5loop", "S6", "S6N", "H1", "H2", "H3", "H4", "H5", "H6", "H7", "H8", "D1", "D2", "D3", "D4", "D5"];

const E2E_TASKS = ["E5", "E6", "E6N"];

for (const t of tasks) if (![...DECISION_TASKS, ...E2E_TASKS].includes(t)) throw new Error(`unknown task ${t}`);

for (const a of arms) if (!["current", "new", "split", "direct"].includes(a)) throw new Error(`unknown arm ${a}`);

for (const t of tasks) if (E2E_TASKS.includes(t) !== arms.every(a => a === "split" || a === "direct")) throw new Error("E2E tasks use --arms=split,direct; decision tasks use --arms=current,new");

if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 60) throw new Error("--rounds must be 1..60");

if (!Number.isSafeInteger(extraTabs) || extraTabs < 0 || extraTabs > 3) throw new Error("--extra-tabs must be 0..3");

const repo = resolve(import.meta.dirname, "../../..");

const out = resolve(repo, "out/jev-compare", name);

await mkdir(join(out, "runs"), { recursive: true });

const sha256 = (buf: Buffer | string) => createHash("sha256").update(buf).digest("hex");

// ── fixture server (independent oracle pages) ─────────────────────────────
const pages: Record<string, string> = { ...decisionFixturePages, ...heldOutPages, ...devPages };

const fixture = createServer((req: IncomingMessage, res: ServerResponse) => {
  const html = pages[new URL(req.url ?? "/", "http://127.0.0.1").pathname];
  res.writeHead(html ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
  res.end(html ?? "not found");
});

await new Promise<void>(r => fixture.listen(0, "127.0.0.1", r));

const origin = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;

// ── isolated build (never the daily extension/dist) ───────────────────────
const dailyDistPath = join(repo, "extension/dist/background.js");

const dailyDistBefore = existsSync(dailyDistPath) ? sha256(await readFile(dailyDistPath)) : null;

const isoRoot = await mkdtemp(join(tmpdir(), "sideagent-jevcmp-dist-"));

const buildTemp = trackTempDir(isoRoot);

const buildDir = join(isoRoot, "extension", "dist");

const build = spawnSync("node", ["build.mjs"], { cwd: join(repo, "extension"), env: { ...process.env, SIDEAGENT_BUILD_DIST: buildDir }, encoding: "utf8" });

if (build.status !== 0) throw new Error(`isolated build failed: ${(build.stderr ?? "").slice(-800)}`);

const prevCwd = process.cwd();

process.chdir(isoRoot);

let launchIsolatedExtension: typeof import("../isolated-extension.mts").launchIsolatedExtension;

try { ({ launchIsolatedExtension } = await import("../isolated-extension.mts")); } finally { process.chdir(prevCwd); }

// ── the two designs ───────────────────────────────────────────────────────
// `current` = main's product code as merged, extracted fresh for this batch (the executor stays this build).
const baseDir = join(repo, "out/jev-compare", name, "base");

let base: { loop: any; judge: any; model: any; commit: string } | undefined;

if (arms.includes("current")) {
  const commit = spawnSync("git", ["rev-parse", baseRef], { cwd: repo, encoding: "utf8" }).stdout.trim();

  if (!commit) throw new Error(`base ref ${baseRef} not found`);
  await rm(baseDir, { recursive: true, force: true });
  await mkdir(baseDir, { recursive: true });
  const archive = spawnSync("sh", ["-c", `git archive ${commit} agent/src shared | tar -x -C ${JSON.stringify(baseDir)}`], { cwd: repo, encoding: "utf8" });

  if (archive.status !== 0) throw new Error(`git archive failed: ${archive.stderr}`);
  base = {
    loop: await import(join(baseDir, "agent/src/browser-decision-loop.ts")),
    judge: await import(join(baseDir, "agent/src/realtime-browser-judge.ts")),
    model: await import(join(baseDir, "agent/src/browser-decision-model.ts")),
    commit,
  };
}

const { ToolRpc } = await import("../../../agent/src/rpc.js");

const { createBrowserTools } = await import("../../../agent/src/tools.js");

const { runBrowserDecisionLoop } = await import("../../../agent/src/browser-decision-loop.js");

const { judgeRealtimeBrowserAction } = await import("../../../agent/src/realtime-browser-judge.js");

const { browserLoopSelfDeliveryText } = await import("../../../agent/src/browser-loop-delivery.js");

const { readTypeSafeKey } = await import("../../../agent/src/typesafe-auth.js");

const { SYSTEM_PROMPT } = await import("../../../agent/src/prompt.js");

const { withPageContext } = await import("../../../agent/src/session.js");

const { wrapPageContent, redactCredentialText } = await import("../../../shared/untrusted.js");

if (!readTypeSafeKey()) throw new Error("BLOCKED: Jev credential unavailable");

// ── main model (same pi runtime and credential configuration as production) ─
type Runtime = Awaited<ReturnType<typeof import("../../../agent/src/node-agent-loop.js").createNodeModelRuntime>>;

let runtime: Runtime | undefined;

let mainModel: any;

async function main() {
  if (!runtime) {
    const { createNodeModelRuntime } = await import("../../../agent/src/node-agent-loop.js");
    runtime = await createNodeModelRuntime();
    const slash = mainModelId.indexOf("/");
    mainModel = runtime.getModel(mainModelId.slice(0, slash), mainModelId.slice(slash + 1));

    if (!mainModel) throw new Error(`BLOCKED: main model ${mainModelId} unavailable`);
  }

  return { runtime: runtime!, model: mainModel };
}

// ── one run ───────────────────────────────────────────────────────────────
/** One Jev HTTP request (after the transport's own retry, if any). */
type JevRecord = { ms: number; bytes?: number; questions?: number; attempts?: number; retried?: boolean; error?: string; connection?: boolean; timeout?: boolean; inputTokens?: number; cost: number; answers?: unknown };

const JEV_INPUT_PER_TOKEN = 0.042 / 1_000_000;

const GOALS: Record<string, string> = {
  S5loop: "Open Account hover menu then click Settings",
  S6: "Click Late-Target",
  S6N: "Click Absolutely-Missing-Target-XYZ",
  H1: "Open the Products menu and click Docs",
  H2: "Click the Invoice March 2024 item in the Archive",
  H3: "Turn on email notifications",
  H4: "Set the country to Japan and save the profile",
  H5: "Open the Billing tab and download the invoice",
  H6: "Open preferences and turn on dark mode",
  H7: "Switch to the Reference Docs tab",
  H8: "Click Export data",
  D1: "Turn off Show online status",
  D2: "Set the delivery speed to Express and press Update",
  D3: "Delete project Alpha",
  D4: "Search the books for Dune",
  D5: "Switch to the Team calendar tab",
};

const MATERIALS: Record<string, Array<{ id: string; value: string; source: "user"; purpose: string }>> = {
  D4: [{ id: "term", value: "Dune", source: "user", purpose: "search term" }],
};

/** The isolated Chrome of the run in progress; closed on SIGINT/SIGTERM so a stopped batch leaves no orphan. */
let liveIso: { close(): Promise<unknown> } | undefined;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { void (liveIso?.close() ?? Promise.resolve()).finally(() => process.exit(130)); });
}

async function runOnce(task: string, arm: string, round: number) {
  const started = Date.now();
  const trace: unknown[] = [];
  const jev: JevRecord[] = [];
  const agentTurns: Array<{ ms: number; cost: number; tools: string[]; error?: string }> = [];
  let iso: Awaited<ReturnType<typeof launchIsolatedExtension>> | undefined;
  const result: Record<string, any> = { task, arm, round, extraTabs, startedAt: new Date(started).toISOString(), loadavg1: loadavg()[0], freeMemMb: Math.round(freemem() / 1e6) };
  let watchdog: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([(async () => {
      // Chrome start-up failures are infrastructure, not samples: retry the launch before any model call.
      for (let attempt = 1; ; attempt++) {
        try {
          iso = await launchIsolatedExtension({ localOnly: true });
          liveIso = iso;
          result.launchAttempts = attempt;
          break;
        } catch (e) {
          if (attempt >= 3) throw e;
        }
      }

      const rpc = new ToolRpc(frame => {
        // The user's visible conversation (default id), as in daily use: the executor then brings a switched tab to front.
        const args = [frame.id, frame.name, frame.params, frame.sessionId ?? "main", frame.programId ?? null, null];
        void iso!.swEval(`globalThis.__saCall(...${JSON.stringify(args)})`).then((r: any) => rpc.handleResult(frame.id, r?.ok === true, r?.data, r?.error, r?.executionFact),
          (e: Error) => rpc.handleResult(frame.id, false, undefined, String(e)));
      });

      const tools = createBrowserTools(rpc, undefined, undefined, undefined, { epoch: () => 1, canWrite: () => true });

      const runTool = async (toolName: string, params: Record<string, unknown>, signal?: AbortSignal) => {
        const tool = tools.find(t => t.name === toolName);

        if (!tool) throw new Error(`unknown tool ${toolName}`);

        return tool.execute(`jevcmp-${toolName}-${Date.now()}`, params as never, signal, undefined, {} as never) as Promise<{ content: Array<{ type: string; text?: string }>; details?: any }>;
      };

      const pageEval = async (tabId: number, source: string) => iso!.swEval(`(async()=>{const [{result}]=await chrome.scripting.executeScript({target:{tabId:${tabId}},world:'MAIN',func:()=>(${source})});return result;})()`) as Promise<any>;
      const needsTabs = task === "H7" || task === "D5" ? 3 : 0;

      for (const path of ["/tab-weather", "/tab-calendar", "/tab-reference"].slice(0, Math.max(extraTabs, needsTabs))) {
        await iso.swEval(`chrome.tabs.create({url:${JSON.stringify(origin + path)},active:false}).then(t=>t.id)`);
      }

      const path = { S5rt: "/s5", S5loop: "/s5", S6: "/s6", S6N: "/s6none", E5: "/s5", E6: "/s6", E6N: "/s6none" }[task] ?? `/${task.toLowerCase()}`;
      const opened = await runTool("tabs", { action: "open", url: `${origin}${path}` });
      const tabId = Number(/tab (\d+)/i.exec(opened.content?.[0]?.text ?? "")?.[1]);

      if (!Number.isFinite(tabId)) throw new Error("working tab did not open");
      await pageEval(tabId, "document.readyState");
      const taskStart = Date.now();
      const loopCall = async (toolName: ToolName, params: Record<string, unknown>) => rpc.call(toolName, params);

      // New design: one record per HTTP request from the product transport's own trace.
      let pending: JevRecord | undefined;

      const onTrace = (e: any) => {
        if (e.phase === "request") {
          pending = { ms: 0, cost: 0, bytes: e.bytes, questions: e.questions };
          jev.push(pending);
          trace.push({ request: JSON.parse(e.body) });
        } else if (e.phase === "retry") {
          if (pending) pending.retried = true;
          trace.push({ retry: e });
        } else if (pending) {
          pending.ms = e.elapsedMs;
          pending.attempts = e.attempts;

          if (e.phase === "response") {
            const usage = e.data?.usage;
            pending.inputTokens = usage?.input_tokens ?? Math.ceil((pending.bytes ?? 0) / 4);
            pending.cost = pending.inputTokens! * JEV_INPUT_PER_TOKEN;
            pending.answers = e.data?.answers;
            trace.push({ response: e.data, attempts: e.attempts, ms: e.elapsedMs });
          } else {
            pending.error = e.message;
            pending.connection = e.connection;
            pending.timeout = /timeout|aborted/i.test(e.message);
            trace.push({ error: e.message, attempts: e.attempts, connection: e.connection });
          }

          pending = undefined;
        }
      };

      // Current design: its own decideBrowserCandidate with its diagnostics hook, no retry.
      const currentDecide = async (input: any, signal: AbortSignal) => {
        const rec: JevRecord = { ms: 0, cost: 0, attempts: 1 };
        jev.push(rec);
        const events: any[] = [];
        const t0 = Date.now();

        try {
          const decision = await base!.model.decideBrowserCandidate(input, signal, { onTrace: (e: any) => events.push(e) });
          const req = events.find(e => e.phase === "request");
          rec.bytes = req?.bytes;
          rec.inputTokens = Math.ceil((req?.bytes ?? 0) / 4);
          rec.cost = rec.inputTokens * JEV_INPUT_PER_TOKEN;
          rec.answers = events.find(e => e.phase === "response")?.data?.answers;

          return decision;
        } catch (e) {
          const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
          rec.error = `${String(e)}${cause ? ` cause=${cause.code ?? cause.message ?? String(cause)}` : ""}`.slice(0, 300);
          rec.timeout = /timeout|aborted due to timeout|TimeoutError/i.test(rec.error);
          rec.connection = rec.timeout || /fetch failed|ECONN|UND_ERR|EPROTO|socket/i.test(rec.error);
          throw e;
        } finally {
          rec.ms = Date.now() - t0;
          trace.push({ input: { goal: input.goal, history: [...input.history], candidates: input.candidates.map((c: any) => `${c.id} ${c.operation} ${c.label}`).slice(0, 40) }, events: events.filter(e => e.phase !== "request") });
        }
      };

      const judge = (request: string, history: string[]) => arm === "current"
        ? base!.judge.judgeRealtimeBrowserAction(rpc, { request, userTask: "Open Account hover menu then click Settings", tabId, history }, AbortSignal.timeout(30_000), currentDecide)
        : judgeRealtimeBrowserAction(rpc, { request, userTask: "Open Account hover menu then click Settings", tabId, history }, AbortSignal.timeout(30_000), undefined, { onTrace });

      const loopOutcome = (goal: string, materials: any[]) => arm === "current"
        ? base!.loop.runBrowserDecisionLoop({ parentCallId: `jevcmp-${task}`, goal, materials, signal: AbortSignal.timeout(120_000), call: loopCall, decide: currentDecide })
        : runBrowserDecisionLoop({ parentCallId: `jevcmp-${task}`, goal, materials, signal: AbortSignal.timeout(120_000), call: loopCall, onTrace });

      const summarize = (outcome: any, ms: number) => ({ status: outcome.status, reasonCode: outcome.reasonCode, reason: String(outcome.reason ?? "").slice(0, 200), receipts: outcome.receipts.map((r: any) => `${r.operation}:${r.executionFact}/${r.verification}`), receiptDetails: outcome.receipts.map((r: any) => String(r.detail).slice(0, 160)), modelCalls: outcome.modelCalls, decisions: outcome.decisions?.map((d: any) => `${d.candidateId}@${Number(d.confidence).toFixed(2)}`), completion: outcome.completion, ms });

      if (task === "S5rt") {
        const judge1: any = await judge("Open the Account menu", []);
        result.judge = [{ status: judge1.status, tool: judge1.suggestion?.tool, reasonCode: judge1.reasonCode }];

        if (judge1.status === "suggestion" && judge1.suggestion?.tool === "hover") {
          await runTool("hover", judge1.suggestion.arguments);
          const history = ["Executed hover on Account; menu independently observed visible"];
          const judge2: any = await judge("Click Settings in the open Account menu", history);
          result.judge.push({ status: judge2.status, tool: judge2.suggestion?.tool, reasonCode: judge2.reasonCode });

          if (judge2.status === "suggestion" && judge2.suggestion) {
            await runTool(judge2.suggestion.tool, judge2.suggestion.arguments);
            // Would the judge now say the step is done? Its suggestion, if any, is recorded and never executed.
            const judge3: any = await judge("Click Settings in the open Account menu", [...history, "Clicked menuitem Settings once; the browser confirmed the click was delivered"]);
            result.judge.push({ status: judge3.status, tool: judge3.suggestion?.tool, reasonCode: judge3.reasonCode });
          }
        }
      } else if (DECISION_TASKS.includes(task)) {
        const loopStart = Date.now();
        const outcome = await loopOutcome(GOALS[task]!, MATERIALS[task] ?? []);
        result.loop = summarize(outcome, Date.now() - loopStart);
      } else {
        // End to end. Same user sentence, same tools, same page for both arms.
        const userText = { E5: "打开 Account 菜单，点 Settings。", E6: "点一下 Late-Target 按钮。", E6N: "点一下 Absolutely-Missing-Target-XYZ 按钮。" }[task]!;
        const context = { tabId, url: `${origin}${path}`, title: String(await pageEval(tabId, "document.title")) };
        const finalText = withPageContext(userText, context);
        const loopStart = Date.now();
        let handoff = "The general browser loop could not start. No success has been reported.";
        let outcome: any;

        try {
          outcome = await runBrowserDecisionLoop({ parentCallId: `jevcmp-${task}`, goal: JSON.stringify({ userTask: finalText, localGoal: finalText }), materials: [], signal: AbortSignal.timeout(90_000), call: loopCall, onTrace });
          result.loop = summarize(outcome, Date.now() - loopStart);
          // Verbatim from BrowserAgentSession.runInitialBrowserLoop.
          handoff = `The shared browser loop ran BEFORE this reasoning-model turn. Its result is ${outcome?.status ?? 'unknown'}; reasonCode=${outcome?.reasonCode ?? 'unspecified'}. It has NOT certified the whole task complete. Independently verify all user requirements. Never replay successful or unknown writes; inspect current state and the task ledger. Use the typed continue hint (continue.action / continue.tools / continue.checkedRange) for the next step — do not parse the human reason string.\n${wrapPageContent(redactCredentialText(JSON.stringify(outcome ?? {})), { tabId: context.tabId })}`;
        } catch (e) {
          result.loop = { error: String(e).slice(0, 300), ms: Date.now() - loopStart };
          handoff = "The shared browser loop failed. Some steps may have executed; inspect current state and the task ledger before proceeding. No success was reported.";
        }

        const direct = arm === "direct" && outcome ? browserLoopSelfDeliveryText(outcome, context.tabId) : null;

        if (direct) {
          result.directDelivery = direct;
          result.finalText = direct;
        } else {
          const agentStart = Date.now();
          const { runtime, model: m } = await main();
          const specs = tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));
          const messages: any[] = [{ role: "user", content: `${finalText}\n\n[Browser execution handoff]\n${handoff}`, timestamp: Date.now() }];

          for (let turn = 0; turn < 12; turn++) {
            const t0 = Date.now();
            result.phase = `agent turn ${turn}`;
            const reply = await runtime.completeSimple(m, { systemPrompt: SYSTEM_PROMPT, messages, tools: specs as any }, { signal: AbortSignal.timeout(180_000), reasoning: "medium", maxTokens: 16_000 });
            messages.push(reply);
            const calls = reply.content.filter((p: any) => p.type === "toolCall") as Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
            agentTurns.push({ ms: Date.now() - t0, cost: reply.usage?.cost?.total ?? 0, tools: calls.map(c => c.name), error: reply.stopReason === "error" ? reply.errorMessage : undefined });

            if (reply.stopReason === "error" || reply.stopReason === "aborted") { result.agentError = reply.errorMessage ?? reply.stopReason; break; }

            if (!calls.length) { result.finalText = reply.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("").slice(0, 1200); break; }

            for (const c of calls) {
              let content: any[];
              let isError = false;

              try {
                result.phase = `agent tool ${c.name}`;
                const r = await runTool(c.name, c.arguments, AbortSignal.timeout(60_000));
                content = r.content;
              } catch (e) {
                content = [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }];
                isError = true;
              }

              messages.push({ role: "toolResult", toolCallId: c.id, toolName: c.name, content, isError, timestamp: Date.now() });
            }
          }

          result.agentMs = Date.now() - agentStart;
        }
      }

      result.taskMs = Date.now() - taskStart;
      Object.assign(result, await oracle(task, tabId, pageEval, iso));
    })(), new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error(`run watchdog: no result after 480 s (phase ${result.phase})`)), 480_000); })]);
  } catch (e) {
    result.error = String(e).slice(0, 500);
    result.success = false;
  } finally {
    clearTimeout(watchdog);
    result.totalMs = Date.now() - started;
    result.jev = jev.map(({ answers: _answers, ...rest }) => rest);
    result.agentTurns = agentTurns;
    result.jevRequests = jev.length;
    result.jevCost = jev.reduce((s, d) => s + d.cost, 0);
    result.mainRequests = agentTurns.length;
    result.mainCost = agentTurns.reduce((s, t) => s + t.cost, 0);
    // A run hit a network failure when any Jev request still failed at the connection level (after retry).
    result.networkFailure = jev.some(d => d.error && (d.connection || d.timeout));
    result.retryRecovered = jev.filter(d => d.retried && !d.error).length;
    const loop = result.loop ?? {};
    result.selfDone = loop.status === "needs_verification" || (result.judge ?? []).some((j: any, i: number) => i === 2 && j.status === "needs_verification");
    result.falseDone = result.selfDone && result.success === false && !result.error;

    if (iso) result.cleanup = (await iso.close()).status;
    liveIso = undefined;
    await writeFile(join(out, "runs", `${task}-${arm}-${round}-tabs${extraTabs}.json`), JSON.stringify({ ...result, jevAnswers: jev.map(d => d.answers), trace }, null, 2));
    await appendFile(join(out, "results.jsonl"), `${JSON.stringify(result)}\n`);
  }

  return result;
}

/** Page-owned counters decide success; the model's own report is never read. */
async function oracle(task: string, tabId: number, pageEval: (tabId: number, src: string) => Promise<any>, iso: any) {
  if (task === "S5rt" || task === "S5loop" || task === "E5") {
    const s = await pageEval(tabId, "({...window.__s5})");

    return { oracle: s, success: s.settings === 1 && s.forbidden === 0, wrongWrites: Math.max(0, s.settings - 1) + s.forbidden };
  }

  if (task === "S6" || task === "E6") {
    const clicks = await pageEval(tabId, "({...window.__s6.clicks})") as Record<string, number>;
    const late = clicks["L-50"] ?? 0;
    const other = Object.entries(clicks).filter(([k]) => k !== "L-50").reduce((s, [, v]) => s + v, 0);

    return { oracle: clicks, success: late === 1 && other === 0, wrongWrites: Math.max(0, late - 1) + other };
  }

  if (task === "S6N" || task === "E6N") {
    const total = await pageEval(tabId, "window.__s6n.total");

    return { oracle: { total }, success: total === 0, wrongWrites: total };
  }

  const writes = await pageEval(tabId, "window.__h.writes") as string[];
  const expected: string[] = { H1: ["docs"], H2: ["archive-41"], H3: ["email"], H4: ["country:Japan", "save"], H5: ["invoice"], H6: ["dark"], H7: [], H8: [], D1: ["status"], D2: ["speed:Express", "update"], D3: [], D4: ["search:Dune"], D5: [] }[task]!;
  const remaining = [...writes];
  let matched = 0;

  for (const e of expected) {
    const i = remaining.indexOf(e);

    if (i >= 0) { remaining.splice(i, 1); matched++; }
  }

  let state: any = {};

  if (task === "H3") state = await pageEval(tabId, "({email:document.getElementById('email').checked,sms:document.getElementById('sms').checked,digest:document.getElementById('digest').checked})");

  if (task === "H4") state = await pageEval(tabId, "({country:document.getElementById('country').value,language:document.getElementById('language').value})");

  if (task === "H6") state = await pageEval(tabId, "({dark:document.getElementById('dark').getAttribute('aria-checked'),compact:document.getElementById('compact').getAttribute('aria-checked')})");

  if (task === "D1") state = await pageEval(tabId, "({usage:document.getElementById('usage').checked,status:document.getElementById('status').checked})");

  if (task === "H7" || task === "D5") state = { active: await iso.swEval("chrome.tabs.query({active:true,lastFocusedWindow:true}).then(t=>t[0]?.url)") };

  const stateOk = task === "H3" ? state.email === true && state.sms === false && state.digest === true
    : task === "H4" ? state.country === "Japan" && state.language === "English"
      : task === "H6" ? state.dark === "true" && state.compact === "false"
        : task === "D1" ? state.usage === true && state.status === false
          : task === "H7" ? String(state.active ?? "").endsWith("/tab-reference")
            : task === "D5" ? String(state.active ?? "").endsWith("/tab-calendar")
              : true;

  return { oracle: { writes, state }, success: matched === expected.length && remaining.length === 0 && stateOk, wrongWrites: remaining.length };
}

// ── schedule: rounds × tasks, arms alternate order every round ──────────────
const summary: Record<string, { n: number; ok: number; wrong: number; net: number }> = {};

for (let round = startRound; round < startRound + rounds; round++) {
  for (const task of tasks) {
    const order = round % 2 === 0 ? arms : [...arms].reverse();

    for (const arm of order) {
      const r = await runOnce(task, arm, round);
      const key = `${task}/${arm}`;
      summary[key] ??= { n: 0, ok: 0, wrong: 0, net: 0 };
      summary[key].n++;
      summary[key].ok += r.success ? 1 : 0;
      summary[key].wrong += r.wrongWrites ?? 0;
      summary[key].net += r.networkFailure ? 1 : 0;
      const end = r.loop ? `${r.loop.status}:${r.loop.reasonCode ?? "-"}` : (r.judge ?? []).map((j: any) => j.tool ?? j.status).join(">");
      console.log(`${new Date().toISOString()} ${key} r${round} success=${r.success} wrong=${r.wrongWrites ?? "?"} end=${end} taskMs=${r.taskMs ?? "?"} jev=${r.jevRequests} net=${r.networkFailure} retry=${r.retryRecovered}${r.falseDone ? " FALSE_DONE" : ""}${r.error ? ` error=${String(r.error).slice(0, 120)}` : ""}`);
    }
  }
}

fixture.close();

buildTemp.release();

await rm(baseDir, { recursive: true, force: true });

const dailyDistAfter = existsSync(dailyDistPath) ? sha256(await readFile(dailyDistPath)) : null;

await writeFile(join(out, `batch-${Date.now()}.json`), JSON.stringify({ tasks, arms, rounds, startRound, extraTabs, mainModelId, baseCommit: base?.commit, summary, dailyDistUnchanged: dailyDistBefore === dailyDistAfter, gitHead: spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim(), gitDirty: spawnSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).stdout.trim().length > 0 }, null, 2));

console.log(JSON.stringify({ summary, dailyDistUnchanged: dailyDistBefore === dailyDistAfter, out }, null, 2));

process.exit(0);
