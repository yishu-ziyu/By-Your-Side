// V2.3 联合验收：真实切页（隔离 profile headless Chrome + 本地测试页 + 真实扩展执行器）
// 与真实开口决策（真实 StepFun Realtime + 真实 Jev）在同一条链上同时运行。
// 复用 realtime-spoken-result-live.mts 的轨迹/收尾/判分与 v23-switch-verification-live 的
// 真实浏览器宿主链装配；只补必要探针装配，不改生产策略、不新建通用测试平台。
// 输入为已有文字入口（connection.handle text），非真人语音；不手填 verified、不伪造 Jev 结果或返回时间。
// 预算固定：Jev≤2（每输入一次三问）、response≤15、ready≤20s、单场景≤100s、总≤360s；不预热、不重试、不改题、不调阈值。
// 退出码：0=PASS，1=FAIL，2=BLOCKED（入口无法合法贯通）。
import {spawnSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, writeFile, readdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import WebSocket from 'ws';
import {RealtimeVoiceConnection, MODEL} from '../../agent/src/realtime-voice-connection.js';
import {RouteShadow} from '../../agent/src/route-shadow.js';
import {readStepVoiceKey} from '../../agent/src/voice-service.js';
import {readTypeSafeKey} from '../../agent/src/typesafe-auth.js';
import {ToolRpc} from '../../agent/src/rpc.js';
import {createBrowserTools} from '../../agent/src/tools.js';
import {BrowserAgentSession} from '../../agent/src/session.js';
import {isSettled, newTrace, summarize, type Trace} from './realtime-spoken-result-live.mts';

export const CAPS = {jev: 2, responses: 15, readyMs: 20_000, scenarioMs: 100_000, totalMs: 360_000} as const;
export const JOINT_SCENARIOS = [
  {id: 'S1', text: '切到测试标签页。'},
  {id: 'S2', text: '切到测试标签页，顺便告诉我一加一等于几。'},
] as const;
type Scenario = typeof JOINT_SCENARIOS[number];
type TraceEvent = Trace['provider'][number];

export type Receipt = {tabId?: number; verification?: {verified?: boolean; activeTabId?: number; windowId?: number; windowFocused?: boolean; workingTabId?: number}} | null;
export type ReadState = {tabId: number | null; windowId: number | null; focused: boolean | null; aActive: boolean; bActive: boolean};

/** 联合验收新增的判分（离线可测）：真实回执核验事实 + 双通道独立读取 + 胶囊事件次数 + 场景身份。 */
export function jointChecks(input: {
  id: Scenario['id'];
  summary: {status: string; reason: string | null; request?: Record<string, unknown> | null};
  receipt: Receipt;
  pre: ReadState;
  post: ReadState;
  vis: {a: string; b: string};
  successCapsules: number;
  tabA: number;
  tabB: number;
}): string[] {
  const reasons: string[] = [];
  if (input.summary.status !== 'PASS') reasons.push(`scenario_${input.id}_${input.summary.reason ?? 'fail'}`);
  // 场景身份不串用：判断归属本场景 voiceId（判断存在且带 voiceId 时核对）。
  const voiceId = input.summary.request?.voiceId;
  if (voiceId !== undefined && String(voiceId) !== input.id) reasons.push('judgment_identity_mismatch');
  // 起点必须是已确认的“A 活动 + 窗口聚焦”（起点准备与受测动作分开记录，由探针 setup 字段佐证）。
  if (input.pre.tabId !== input.tabA || input.pre.focused !== true || input.pre.aActive !== true) reasons.push('start_state_invalid');
  // A1：生产回执来自实际读回，逐项核验通过。
  const v = input.receipt?.verification;
  if (input.receipt?.tabId !== input.tabB || v?.verified !== true || v?.activeTabId !== input.tabB
    || v?.windowFocused !== true || v?.workingTabId !== input.tabB) reasons.push('receipt_not_verified');
  // A1：独立读取确认目标 B 活动、窗口聚焦（不经过回执）。
  if (input.post.tabId !== input.tabB || input.post.bActive !== true || input.post.focused !== true) reasons.push('independent_read_mismatch');
  if (input.vis.b !== 'visible' || input.vis.a !== 'hidden') reasons.push('visibility_mismatch');
  // A2（S1）：成功胶囊事件恰好一次；S2 至少一次并记录次数。
  if (input.id === 'S1' && input.successCapsules !== 1) reasons.push('success_capsule_event_count');
  if (input.id === 'S2' && input.successCapsules < 1) reasons.push('success_capsule_event_missing');
  return reasons;
}

const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const SOURCES = [
  'agent/src/route-shadow.ts', 'agent/src/realtime-voice-connection.ts', 'agent/src/realtime-voice-session.ts',
  'agent/src/voice-service.ts', 'agent/src/config.ts', 'agent/src/session.ts', 'agent/src/rpc.ts', 'agent/src/tools.ts',
  'shared/execution-feedback.ts', 'shared/protocol.ts',
  'extension/src/background/exec/tabs.ts', 'extension/src/background/state.ts',
  'scripts/acceptance/realtime-spoken-result-live.mts', 'scripts/acceptance/v23-joint-live.mts',
  'scripts/acceptance/isolated-extension.mts', 'scripts/acceptance/sw-hook.mjs', 'scripts/acceptance/cdp.mjs',
];
const sourceHashes = async () => Object.fromEntries(await Promise.all(SOURCES.map(async p => [p, hash(await readFile(p))])));

export async function main(): Promise<number> {
  if (!process.argv.includes('--headless')) throw new Error('Requires --headless; no browser window, microphone or speaker is opened.');
  const root = join('out/acceptance', `v23-joint-live-${Date.now()}`);
  await mkdir(root, {recursive: true});
  const summaryPath = join(root, 'result.json');
  const before = await sourceHashes();
  const dailyDistPath = join(process.cwd(), 'extension/dist/background.js');
  const dailyDistBefore = existsSync(dailyDistPath) ? hash(await readFile(dailyDistPath)) : null;
  const startedAt = Date.now();
  const write = async (payload: Record<string, unknown>) => writeFile(summaryPath, JSON.stringify({startedAt, endedAt: Date.now(), input: 'text（文字入口，非真人语音）', ...payload}, null, 2));

  let stepKey: string;
  try {
    stepKey = await readStepVoiceKey();
    if (!readTypeSafeKey()) throw new Error('missing_jev_credential');
  } catch {
    await write({status: 'BLOCKED', reason: 'missing_credentials', scenarios: JOINT_SCENARIOS.map(s => ({id: s.id, status: 'NOT_RUN'}))});
    console.log(summaryPath);
    return 2;
  }

  // ── 隔离构建 + 隔离浏览器（本地测试页；不动日常 dist）────────────────────────
  const isoRoot = await mkdtemp(join(tmpdir(), 'sideagent-joint-dist-'));
  const buildDir = join(isoRoot, 'extension', 'dist');
  const build = spawnSync('node', ['build.mjs'], {cwd: join(process.cwd(), 'extension'), env: {...process.env, SIDEAGENT_BUILD_DIST: buildDir}, encoding: 'utf8'});
  if (build.status !== 0) {
    await write({status: 'BLOCKED', reason: 'isolated_build_failed', stderrTail: (build.stderr ?? '').split('\n').slice(-5)});
    console.log(summaryPath);
    return 2;
  }
  const prevCwd = process.cwd();
  process.chdir(isoRoot);
  let launchIsolatedExtension: typeof import('./isolated-extension.mts').launchIsolatedExtension;
  try {
    ({launchIsolatedExtension} = await import('./isolated-extension.mts'));
  } finally {
    process.chdir(prevCwd);
  }

  const results: any[] = [];
  const setups: any[] = [];
  const traces: Record<string, Trace> = {};
  const bridgeEvents: Array<Record<string, unknown>> = [];
  let requests = 0, responses = 0, stopReason: string | null = null;
  const requestShapes: string[][] = [];
  let iso: Awaited<ReturnType<typeof launchIsolatedExtension>> | undefined;
  let cleanup: unknown;
  let status: 'PASS' | 'FAIL' | 'BLOCKED' = 'FAIL';
  let reason: string | undefined;

  try {
    try {
      iso = await launchIsolatedExtension({localOnly: true});
    } catch (error) {
      status = 'BLOCKED';
      reason = `isolation_entry_blocked: ${String(error instanceof Error ? error.message : error)}`;
      throw error;
    }

    // 本地测试页 A/B；标题只用于模型按真实 list_tabs 选择目标（属起点准备）。
    const targetA = await iso.newTarget(`${iso.fixtureOrigin}/page-a`);
    const targetB = await iso.newTarget(`${iso.fixtureOrigin}/page-b`);
    const untilReady = async (t: string) => {
      const end = Date.now() + 10_000;
      while (Date.now() < end) if (await iso!.evalIn(t, "document.readyState==='complete'")) return;
      throw new Error(`fixture page not ready: ${t}`);
    };
    await untilReady(targetA);
    await untilReady(targetB);
    await iso.evalIn(targetA, "document.title='当前页'");
    await iso.evalIn(targetB, "document.title='测试标签页'");
    const allTabs = await iso.swEval('chrome.tabs.query({})') as Array<{id: number; url: string}>;
    const tabA = allTabs.find(t => t.url.endsWith('/page-a'))!.id;
    const tabB = allTabs.find(t => t.url.endsWith('/page-b'))!.id;
    await iso.swEval(`chrome.tabs.query({}).then(ts=>{const blank=ts.find(t=>t.url==='about:blank'||t.url==='');return blank?chrome.tabs.remove(blank.id):null;})`);

    const readActive = async (): Promise<ReadState> => await iso!.swEval(`(async()=>{
      const t = await chrome.tabs.query({active:true, lastFocusedWindow:true});
      const w = t[0] ? await chrome.windows.get(t[0].windowId) : null;
      const a = await chrome.tabs.get(${tabA});
      const b = await chrome.tabs.get(${tabB});
      return {tabId:t[0]?.id??null, windowId:t[0]?.windowId??null, focused:w?.focused??null, aActive:a.active, bActive:b.active};
    })()`) as ReadState;
    const visibility = async (target: string): Promise<string> => await iso!.evalIn(target, 'document.visibilityState') as string;

    // ── 原宿主链：真实 ToolRpc 桥接扩展 SW 的生产 executeToolCall 入口 ─────────
    const rpc = new ToolRpc(frame => {
      bridgeEvents.push({at: Date.now(), kind: 'rpc-start', id: frame.id, name: frame.name});
      const args = [frame.id, frame.name, frame.params, frame.sessionId ?? 'main', frame.programId ?? null, 'default'];
      void iso!.swEval(`globalThis.__saCall(...${JSON.stringify(args)})`).then((r: any) => {
        bridgeEvents.push({at: Date.now(), kind: 'rpc-end', id: frame.id, name: frame.name, ok: r.ok, data: r.data, error: r.error, executionFact: r.executionFact});
        rpc.handleResult(frame.id, r.ok === true, r.data, r.error, r.executionFact);
      }, (e: unknown) => {
        bridgeEvents.push({at: Date.now(), kind: 'rpc-error', id: frame.id, error: String(e)});
        rpc.handleResult(frame.id, false, undefined, String(e));
      });
    });
    const raw: any = {
      isStreaming: false,
      prompt: () => undefined,
      agent: {state: {tools: [], messages: []}},
      sessionManager: {appendCustomEntry: () => {}, getBranch: () => []},
    };
    let wrapper: any;
    let currentCapsules: any[] = [];
    // SAFETY: 与 v23-switch-verification-live.mts / agent 测试相同的真实宿主装配：
    // 真实 BrowserAgentSession + 工具 + ToolRpc，仅 Pi prompt 层为内存替身（本票不测模型层）。
    wrapper = new (BrowserAgentSession as any)(raw, null, {
      emit: (event: any) => { if (event?.kind === 'execution_feedback' && event.feedback) currentCapsules.push(event.feedback); },
      setStatus: () => {},
    }, null, null, undefined, null, rpc);
    raw.agent.state.tools = createBrowserTools(rpc, undefined, undefined, undefined, {
      epoch: () => wrapper.executionEpoch(),
      canWrite: (id?: string) => wrapper.canWriteCurrentInput(id),
      assertCall: (name: string, params: Record<string, unknown>, id?: string) => wrapper.assertTaskResultExecution(name, params, id),
    });

    const prepareStart = async (scenario: string): Promise<{receipt: Receipt; pre: ReadState} | null> => {
      // 起点准备（与受测动作分开记录）：把工作页切回 A 并确认 A 活动、窗口聚焦。
      const setupCall = await iso!.tool('switch_tab', {tabId: tabA}, 'main') as {ok?: boolean; data?: Receipt};
      const pre = await readActive();
      const entry = {scenario, at: Date.now(), kind: 'setup', receipt: setupCall?.data ?? null, pre};
      setups.push(entry);
      if (setupCall?.ok !== true || pre.tabId !== tabA || pre.focused !== true || pre.aActive !== true) return null;
      return {receipt: setupCall.data ?? null, pre};
    };

    const start = await prepareStart('S1');
    if (!start) {
      status = 'BLOCKED';
      reason = 'start_state_blocked: 无法建立已聚焦窗口的 A 活动起点（不硬编码 focused=true）';
      throw new Error(reason);
    }

    // ── 真实 Jev：一次三问/输入，总上限 CAPS.jev；审计落盘 ────────────────────
    const shadowRoot = join(root, 'request-audit');
    const shadow = new RouteShadow({
      enabled: () => false, dailyLimit: () => CAPS.jev + 1, root: shadowRoot,
      fetch: async (...args) => {
        if (requests >= CAPS.jev) { stopReason = 'jev_cap'; throw new Error(stopReason); }
        requests++;
        requestShapes.push(Object.keys(JSON.parse(String(args[1]?.body)).questions).sort());
        return fetch(...args);
      },
    });

    for (const scenario of JOINT_SCENARIOS) {
      if (stopReason) { results.push({id: scenario.id, status: 'NOT_RUN', reason: stopReason}); continue; }
      // S2 起点：上一场景已切到 B，重新准备 A 起点（记录为 setup，不计入受测动作）。
      const prepared = scenario.id === 'S1' ? start : await prepareStart(scenario.id);
      if (!prepared) { results.push({id: scenario.id, status: 'FAIL', reason: 'start_state_invalid'}); continue; }

      const t = newTrace(); traces[scenario.id] = t;
      currentCapsules = [];
      const bridgeMarker = bridgeEvents.length;
      let connection: RealtimeVoiceConnection, closed = false, ready = false, endedReason = 'timeout';
      let startAt = 0, readyAt = 0, sentAt = 0, endedAt = 0;
      const clientBytes = new Map<string, number>();
      const playbackTimers = new Set<ReturnType<typeof setTimeout>>();
      const record = (list: Trace['provider'], e: any) => { if (!closed) list.push({...e, at: Date.now()}); };

      connection = new RealtimeVoiceConnection({
        key: stepKey, voiceId: scenario.id, voiceSpokenResultGate: true,
        connect: key => {
          const ws = new WebSocket(`wss://api.stepfun.com/v1/realtime?model=${MODEL}`, {headers: {Authorization: `Bearer ${key}`}});
          ws.on('message', raw2 => {
            try {
              const e = JSON.parse(raw2.toString());
              record(t.provider, e);
              if (e.type === 'response.created' && ++responses >= CAPS.responses) { stopReason = 'response_cap'; connection.close(); }
            } catch { /* 非 JSON 帧不进轨迹 */ }
          });
          const send = ws.send.bind(ws);
          ws.send = ((data: any) => { try { record(t.outgoing, JSON.parse(String(data))); } catch { /* 忽略 */ } return send(data); }) as typeof ws.send;
          return ws;
        },
        judgeRequest: async input => {
          const request: TraceEvent = {type: 'judgment', at: Date.now(), ...input, completedAt: null, judgment: null};
          t.judgments.push(request);
          try { return request.judgment = await shadow.judge({channel: 'voice', conversationId: 'joint', ...input, previous: [], taskRunning: false}, true); }
          finally { request.completedAt = Date.now(); }
        },
        log: e => record(t.logs, e),
        send: e => {
          record(t.client, e);
          if (e.type === 'ready') ready = true;
          if (e.type === 'audio') clientBytes.set(String(e.responseId), (clientBytes.get(String(e.responseId)) ?? 0) + Buffer.from(String(e.data), 'base64').length);
          if (e.type === 'response_done') {
            const timer = setTimeout(() => {
              playbackTimers.delete(timer);
              if (!closed) connection.handle({type: 'playback_done', responseId: e.responseId});
            }, Math.max(1, (clientBytes.get(String(e.responseId)) ?? 0) / 48));
            playbackTimers.add(timer);
          }
        },
        tools: {
          // 真实宿主链：BrowserAgentSession → ToolRpc → 扩展执行器 → 真实读回回执 + ExecutionFeedback。
          browserTool: async (call, signal) => {
            record(t.tools, {type: 'tool', name: call.name, args: call.args, callId: call.callId, inputId: call.inputId});
            return await wrapper.executeRealtimeBrowserTool(call.name, (call.args ?? {}) as Record<string, unknown>, signal, {inputId: call.inputId, runId: null});
          },
          browser_request: async () => ({ok: false, error: '联合探针未接委派任务'}),
          read_page: async () => ({ok: false, error: '请用 snapshot 读取页面'}),
          task_status: async () => ({ok: true, tasks: []}),
        },
      });

      try {
        startAt = Date.now();
        connection.start();
        const readyDeadline = Date.now() + CAPS.readyMs;
        while (!ready && Date.now() < readyDeadline && !t.client.some(e => e.type === 'closed') && !stopReason) await sleep(100);
        if (!ready) endedReason = 'not_ready';
        else {
          readyAt = Date.now();
          connection.handle({type: 'text', text: scenario.text}); // 文字入口（已有可用入口，非真人语音）
          sentAt = Date.now();
          const deadline = sentAt + CAPS.scenarioMs;
          let size = 0, lastActivity = Date.now();
          while (Date.now() < deadline) {
            if (Date.now() - startedAt >= CAPS.totalMs) stopReason = 'total_cap';
            if (stopReason) { endedReason = stopReason; break; }
            if (t.client.some(e => e.type === 'closed' || e.type === 'error')) { endedReason = 'connection_closed'; break; }
            const nextSize = t.provider.length + t.outgoing.length + t.client.length + t.logs.length;
            if (nextSize !== size) { size = nextSize; lastActivity = Date.now(); }
            if (isSettled(t) && Date.now() - lastActivity >= 2000) { endedReason = 'quiescent'; break; }
            await sleep(100);
          }
          endedAt = Date.now();
        }
      } finally {
        closed = true;
        for (const timer of playbackTimers) clearTimeout(timer);
        connection.close();
      }

      // 独立读取（受测动作之后，不经过回执）。
      const post = await readActive();
      const vis = {a: await visibility(targetA), b: await visibility(targetB)};
      const scenarioBridge = bridgeEvents.slice(bridgeMarker);
      const switchEnd = [...scenarioBridge].reverse().find(e => e.kind === 'rpc-end' && e.name === 'switch_tab');
      const receipt = (switchEnd?.data ?? null) as Receipt;
      const successCapsules = currentCapsules.filter(f => f.channel === 'capsule' && f.kind === 'success' && f.text === '切好了').length;
      const summary = summarize(scenario.id, t, endedReason);
      const jointReasons = jointChecks({
        id: scenario.id, summary, receipt, pre: prepared.pre, post, vis, successCapsules, tabA, tabB,
      });
      results.push({
        ...summary,
        jointReasons,
        receipt, independentRead: {pre: prepared.pre, post, vis},
        successCapsules,
        capsuleEvents: currentCapsules.map(f => ({id: f.id, kind: f.kind, text: f.text, capsuleCanCloseAction: f.capsuleCanCloseAction})),
        timings: {startAt, readyAt, sentAt, endedAt, readyMs: readyAt && startAt ? readyAt - startAt : null, sendToSettleMs: endedAt && sentAt ? endedAt - sentAt : null},
        setupRecorded: setups.some(s => s.scenario === scenario.id && s.kind === 'setup'),
      });
      for (const item of (results.at(-1) as any).audio as Array<{responseId: string}>) {
        for (const [label, events, type, field] of [
          ['provider', t.provider, 'response.audio.delta', 'delta'],
          ['delivered', t.client, 'audio', 'data'],
        ] as const) {
          const pcm = Buffer.concat(events.filter(e => e.type === type && (e.response_id ?? e.response?.id ?? e.responseId) === item.responseId).map(e => Buffer.from(e[field], 'base64')));
          await writeFile(join(root, `${scenario.id}-${hash(String(item.responseId)).slice(0, 12)}-${label}.pcm`), pcm);
        }
      }
      console.log(scenario.id, summary.status, summary.reduction ?? '', jointReasons.join(',') || 'joint-ok');
    }

    const after = await sourceHashes();
    const sourceChanged = JSON.stringify(before) !== JSON.stringify(after);
    const auditFiles = await readdir(shadowRoot).catch(() => [] as string[]);
    const requestAudit = (await Promise.all(auditFiles.map(async f => (await readFile(join(shadowRoot, f), 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l))))).flat();
    const dailyDistAfter = existsSync(dailyDistPath) ? hash(await readFile(dailyDistPath)) : null;
    try { if (iso) cleanup = await iso.close(); } catch (error) { cleanup = {status: 'FAIL', error: String(error)}; }
    const jointFailed = results.some(r => r.status !== 'PASS' || (r.jointReasons as string[]).length > 0);
    if (stopReason && results.some(r => r.status === 'NOT_RUN')) { status = 'FAIL'; reason = stopReason; }
    else if (jointFailed) { status = 'FAIL'; reason = 'scenario_or_joint_check_failed'; }
    else if (sourceChanged) { status = 'FAIL'; reason = 'source_changed'; }
    else if ((cleanup as any)?.status !== 'PASS') { status = 'FAIL'; reason = 'cleanup_failed'; }
    else { status = 'PASS'; }
    await write({
      status, reason, scope: 'real isolated Chrome switch + real StepFun/Jev request-gate in one chain; text entry (not human voice); local pages only',
      budget: {caps: CAPS, requests, requestShapes, responses, stopReason},
      sourceChanged, before, after,
      dailyDist: {before: dailyDistBefore, after: dailyDistAfter, unchanged: dailyDistBefore === dailyDistAfter},
      setupSeparation: setups, results, requestAudit, traces, cleanup,
    });
    console.log(summaryPath);
    return status === 'PASS' ? 0 : 1;
  } catch (error) {
    if (status !== 'BLOCKED') { status = 'FAIL'; reason = String(error instanceof Error ? error.message : error); }
    try { if (iso) cleanup = await iso.close(); } catch { /* 尽力清理 */ }
    await write({status, reason, results, setupSeparation: setups, cleanup});
    console.log(summaryPath);
    return status === 'BLOCKED' ? 2 : 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(error); process.exitCode = 1; });
}
