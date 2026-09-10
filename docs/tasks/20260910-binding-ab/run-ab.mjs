#!/usr/bin/env node
/**
 * 登记/目标绑定 A/B/C 的 18 次同模型交错对照编排（DeepSeek 执行侧）。
 *
 * 需要：可联网（MiniMax-M3，凭据来自 ~/.pi/agent/models.json）+ 可用 Chrome for Testing。
 * 本 worker 沙箱两者都没有（DNS/loopback 被拒、提权被拒），所以脚本只保证可评审、可离线自检。
 *
 *   node docs/tasks/20260910-binding-ab/run-ab.mjs --dry-run          # 只打印交错顺序与每轮 seed（不需要环境）
 *   node docs/tasks/20260910-binding-ab/run-ab.mjs --preflight-only   # 只做批前预检，不跑 18 次
 *   node docs/tasks/20260910-binding-ab/run-ab.mjs                    # 预检通过后跑 18 次（严格串行）
 *
 * 约束：串行、不并发；每条跑完立刻落盘；慢样本/失败样本一律保留；
 *      基础设施失败、产品失败、外层超时、脚手架启动失败分开记；每批唯一目录，不覆盖历史样本。
 */
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(HERE, '../../..');
const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const HAS = name => process.argv.includes(`--${name}`);

const COPY_ROOT = arg('root', '/tmp/ego-binding-ab-20260910');
const RUN_TIMEOUT_MS = Number(arg('runTimeoutMs', '420000'));
/** 发 SIGTERM 后给 harness 释放 Chrome/CDP/本地服务的宽限；到点仍未退出才强杀。 */
const STOP_GRACE_MS = Number(arg('stopGraceMs', '15000'));
const SLOW_MS = Number(arg('slowMs', '120000'));
const PREFLIGHT_TIMEOUT_MS = Number(arg('preflightTimeoutMs', '60000'));
/** 连续这么多条相同的脚手架启动错误就中止整批，避免 18 次空转。 */
const MAX_CONSECUTIVE_SETUP_FAILURES = Number(arg('maxConsecutiveSetupFailures', '3'));
/** 副本来自含 WIP 的工作区快照；commit 标注用，不从 .git 读。 */
const BASELINE_COMMIT = arg('baselineCommit', '40993d5');
const PREFLIGHT_ONLY = HAS('preflight-only') || HAS('preflightOnly');
const CANDIDATES = ['A', 'B', 'C'];
const SCENARIOS = ['state_environment', 'pick_target', 'delay_ready'];
const REPEATS = 2;
const RUNS_ROOT = arg('runsRoot', join(ROOT_DIR, 'docs/tasks/20260910-binding-ab/runs'));
const MODEL = 'minimax-cn/MiniMax-M3';

const SOURCE_FILES = [
  'agent/src/session.ts', 'agent/src/task-results.ts', 'agent/src/task-progress.ts',
  'agent/src/tools.ts', 'agent/src/conversation-manager.ts', 'agent/src/conversation-runtime.ts',
  'shared/task-results.ts',
];
const HARNESS_FILE = 'scripts/acceptance/harness-s2-run.mts';
const FIXTURE_FILE = 'scripts/acceptance/binding-ab-fixtures.mts';
const METRICS_FILE = 'scripts/acceptance/binding-ab-metrics.mts';
const EVIDENCE_FILE = 'scripts/acceptance/voice-evidence.mts';

/** 已知基础设施故障特征；命中才算 infra，其余一律 product_failure。外层超时不走这里，单列 timeout。 */
const INFRA_PATTERNS = [
  /ENOTFOUND|EAI_AGAIN|Could not resolve host|getaddrinfo/i,
  /EPERM|operation not permitted/i,
  /ECONNREFUSED|Failed to connect|ECONNRESET|socket hang up|ETIMEDOUT/i,
  /DevToolsActivePort|Google Chrome for Testing|chrome.*not found/i,
  /Cannot find module|ERR_MODULE_NOT_FOUND/i,
  /spawn .* ENOENT/i,
];
/** 脚手架/环境启动失败特征：模型与页面都还没跑起来；这类不能算产品淘汰。 */
const SETUP_PATTERNS = [
  /not a git repository/i,
  /Command failed: git/i,
  /Cannot find module|ERR_MODULE_NOT_FOUND/i,
  /DevToolsActivePort|Google Chrome for Testing|chrome.*not found/i,
  /spawn .* ENOENT/i,
  /EPERM|operation not permitted/i,
  /ENOTFOUND|EAI_AGAIN|Could not resolve host/i,
];
const classifyInfra = text => {
  if (!text) return null;
  const value = String(text);
  return INFRA_PATTERNS.some(re => re.test(value)) ? value.slice(0, 400) : null;
};
const setupSignature = text => {
  const value = String(text ?? '');
  const hit = SETUP_PATTERNS.find(re => re.test(value));
  return hit ? hit.source : null;
};

/** 交错顺序：block = repeat*3 + scenarioIndex；候选按 block 轮转，且同 block 的 A/B/C 共用同一 seed 与文案。 */
function plan() {
  const runs = [];
  let block = 0;
  for (let repeat = 0; repeat < REPEATS; repeat++) {
    for (const scenario of SCENARIOS) {
      const seed = `bindingab-20260910-b${block}`;
      const rotated = CANDIDATES.map((_, i) => CANDIDATES[(i + (block % CANDIDATES.length)) % CANDIDATES.length]);
      for (const candidate of rotated) runs.push({index: runs.length + 1, block, seed, candidate, scenario, repeat});
      block += 1;
    }
  }
  return runs;
}

const sha = file => existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null;
const candidateHashes = candidate => Object.fromEntries(SOURCE_FILES.map(rel => [rel, sha(join(COPY_ROOT, candidate, rel))]));
const artifactHashes = candidate => ({
  harness: sha(join(COPY_ROOT, candidate, HARNESS_FILE)),
  fixtures: sha(join(COPY_ROOT, candidate, FIXTURE_FILE)),
  metrics: sha(join(COPY_ROOT, candidate, METRICS_FILE)),
  evidence: sha(join(COPY_ROOT, candidate, EVIDENCE_FILE)),
});

function lastJsonLine(text) {
  const lines = text.trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) { try { return JSON.parse(lines[i]); } catch { /* keep looking */ } }
  return null;
}

const BATCH_ID = arg('batch', `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '')}-${process.pid}`);
const RUNS_DIR = join(RUNS_ROOT, BATCH_ID);
const childEnv = extra => ({...process.env, SIDEAGENT_BASELINE_COMMIT: BASELINE_COMMIT, ...extra});

/** 子进程单一 settle：error/exit/close 先到先算；超时先 SIGTERM 宽限再 SIGKILL。 */
async function runChild(args, {cwd, env, timeoutMs}) {
  const child = spawn(process.execPath, args, {cwd, env, stdio: ['ignore', 'pipe', 'pipe']});
  let log = '', spawnError = null, timedOut = false, settled = false, settleReason = null, resolveDone;
  const done = new Promise(res => { resolveDone = res; });
  const settle = reason => { if (!settled) { settled = true; settleReason = reason; resolveDone(reason); } };
  const waitSettle = ms => new Promise(res => { const t = setTimeout(res, ms); done.then(() => { clearTimeout(t); res(); }); });
  child.stdout.on('data', b => { log += b; });
  child.stderr.on('data', b => { log += b; });
  child.on('error', error => { spawnError = String(error); settle('error'); });
  child.on('exit', () => settle('exit'));
  child.on('close', () => settle('close'));
  const stop = async () => {
    if (spawnError) return;
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    await waitSettle(STOP_GRACE_MS);
    if (!settled) { try { child.kill('SIGKILL'); } catch { /* already gone */ } await waitSettle(3000); }
  };
  const timer = setTimeout(() => { timedOut = true; void stop().finally(() => settle('timeout')); }, timeoutMs);
  const startedAt = Date.now();
  await done;
  clearTimeout(timer);
  return {log, exitCode: child.exitCode, spawnError, timedOut, settleReason, elapsedMs: Date.now() - startedAt};
}

/** 批前预检：每个副本只跑 harness --preflight（初始化快照身份，不碰模型/Chrome）。 */
async function preflightCandidate(candidate) {
  const copy = join(COPY_ROOT, candidate);
  if (!existsSync(copy)) return {ok: false, error: `副本不存在: ${copy}`};
  for (const rel of [HARNESS_FILE, FIXTURE_FILE, METRICS_FILE, EVIDENCE_FILE]) {
    if (!existsSync(join(copy, rel))) return {ok: false, error: `缺少脚手架文件: ${rel}`};
  }
  if (!existsSync(join(copy, 'node_modules/tsx/dist/cli.mjs'))) return {ok: false, error: '缺少 node_modules/tsx/dist/cli.mjs'};
  const run = await runChild([join(copy, 'node_modules/tsx/dist/cli.mjs'), join(copy, HARNESS_FILE), '--preflight'], {cwd: copy, env: childEnv({SIDEAGENT_AB_CANDIDATE: candidate}), timeoutMs: PREFLIGHT_TIMEOUT_MS});
  const parsed = lastJsonLine(run.log);
  if (run.spawnError) return {ok: false, error: `spawn_error: ${run.spawnError}`, elapsedMs: run.elapsedMs};
  if (run.timedOut) return {ok: false, error: `preflight timeout: ${PREFLIGHT_TIMEOUT_MS}ms`, elapsedMs: run.elapsedMs};
  if (!parsed?.preflight || parsed.ok !== true) {
    const lines = run.log.trim().split('\n').filter(Boolean);
    const firstError = lines.find(line => /error|fatal|failed|not a git|EPERM|not found/i.test(line)) ?? lines[0] ?? 'preflight 无输出';
    const compact = `${firstError}${lines.length > 1 ? ` … ${lines.at(-1)}` : ''}`.slice(0, 300);
    return {ok: false, error: compact, elapsedMs: run.elapsedMs};
  }
  return {ok: true, elapsedMs: run.elapsedMs, evidence: parsed.evidence};
}

function row(run, {exitCode, result, tail, logPath, elapsedMs, infraFailure, spawnError, timedOut, settleReason, setupFailure}) {
  const metrics = result?.scenarioMetrics ?? result?.environmentMetrics ?? null;
  const ok = result?.ok === true;
  const bucket = setupFailure ? 'harness_setup_failure' : timedOut ? 'timeout' : infraFailure ? 'infra_failure' : ok ? 'ok' : 'product_failure';
  return {
    index: run.index, block: run.block, seed: run.seed,
    candidate: run.candidate, scenario: run.scenario, repeat: run.repeat,
    model: MODEL, reasoning: 'medium',
    exitCode, settleReason: settleReason ?? null,
    timedOut: !!timedOut, slow: elapsedMs >= SLOW_MS,
    ok, bucket,
    infraFailure: infraFailure ?? null, spawnError: spawnError ?? null, setupFailure: setupFailure ?? null,
    productFailure: !ok && !infraFailure && !timedOut && !setupFailure,
    note: setupFailure ? `harness_setup_failure 待环境修复后重跑：${setupFailure}`
      : timedOut ? `timeout 待审：≥${RUN_TIMEOUT_MS}ms 未完成，慢样本保留` : null,
    elapsedMs,
    totalMs: result?.finishedAt != null && result?.requestAt != null ? result.finishedAt - result.requestAt : metrics?.totalMs ?? null,
    modelTurns: metrics?.modelTurns ?? null,
    registrationOnlyTurns: metrics?.registrationOnlyTurns ?? null,
    turnsWithRegistration: metrics?.turnsWithRegistration ?? null,
    registrationCalls: metrics?.registrationCalls ?? null,
    topLevelToolCalls: metrics?.topLevelToolCalls ?? null,
    browserRunCalls: metrics?.browserRunCalls ?? null,
    browserRunSubsteps: metrics?.browserRunSubsteps ?? null,
    writeCalls: metrics?.writeCalls ?? null,
    failedWrites: metrics?.failedWrites ?? null,
    jsCalls: metrics?.jsCalls ?? null,
    readCalls: metrics?.readCalls ?? null,
    firstObservationMs: metrics?.firstObservationMs ?? null,
    firstObservationTool: metrics?.firstObservationTool ?? null,
    // 首次动作尝试（tool_start，含被 preflight 拒绝的尝试）；不是“首次真实动作”。
    firstAttemptMs: metrics?.firstAttemptMs ?? null,
    firstAttemptTool: metrics?.firstAttemptTool ?? null,
    // 首次真实 RPC 下发（来自 report.tools）；首动作比较优先用下面的 DOM 事件时刻。
    firstDispatchMs: metrics?.firstDispatchMs ?? null,
    firstDispatchTool: metrics?.firstDispatchTool ?? null,
    firstDispatchOk: metrics?.firstDispatchOk ?? null,
    firstDomActionMs: metrics?.firstDomActionMs ?? null,
    firstDomActionSource: metrics?.firstDomActionSource ?? null,
    pauseMs: metrics?.pauseMs ?? null,
    usage: metrics?.usage ?? null, usageAvailable: metrics?.usageAvailable ?? false,
    usageSource: metrics?.usageSource ?? 'not_available',
    checks: result?.checks ?? null,
    sideEffects: result?.sideEffects ?? null,
    wordingObservations: result?.wordingObservations ?? null,
    answer: result?.answer ?? null,
    out: result?.out ?? tail?.out ?? null, logPath,
  };
}

const totalsOf = (rows, aborted) => ({
  runs: rows.length, ok: rows.filter(r => r.ok).length,
  productFailure: rows.filter(r => r.productFailure).length,
  infraFailure: rows.filter(r => r.infraFailure).length,
  harnessSetupFailure: rows.filter(r => r.bucket === 'harness_setup_failure').length,
  timeout: rows.filter(r => r.timedOut).length,
  slow: rows.filter(r => r.slow).length,
  aborted: aborted ? 1 : 0,
});

const planned = plan();
if (HAS('dry-run')) {
  console.log(JSON.stringify({
    copyRoot: COPY_ROOT, model: MODEL, runTimeoutMs: RUN_TIMEOUT_MS, stopGraceMs: STOP_GRACE_MS,
    baselineCommit: BASELINE_COMMIT,
    batchId: BATCH_ID, runsDir: RUNS_DIR,
    interleaving: 'block = repeat*3 + scenarioIndex；候选按 block%3 轮转；同 block 共用 seed/文案/fixture',
    runs: planned, perCandidate: planned.filter(r => r.candidate === 'A').length,
  }, null, 2));
  process.exit(0);
}

if (PREFLIGHT_ONLY) {
  const results = {};
  for (const candidate of CANDIDATES) results[candidate] = await preflightCandidate(candidate);
  const ok = CANDIDATES.every(candidate => results[candidate].ok);
  console.log(JSON.stringify({preflightOnly: true, copyRoot: COPY_ROOT, baselineCommit: BASELINE_COMMIT, ok, results}, null, 2));
  process.exit(ok ? 0 : 1);
}

mkdirSync(RUNS_ROOT, {recursive: true});
if (existsSync(RUNS_DIR) && readdirSync(RUNS_DIR).length > 0) {
  throw new Error(`批次目录已存在且非空，拒绝覆盖历史样本：${RUNS_DIR}（用 --batch=<新名字>）`);
}
mkdirSync(RUNS_DIR, {recursive: true});

const writtenAt = () => new Date().toISOString();
const flush = () => {
  const totals = totalsOf(rows, aborted);
  writeFileSync(join(RUNS_DIR, 'index.partial.json'), JSON.stringify({
    batchId: BATCH_ID, batchDir: RUNS_DIR, copyRoot: COPY_ROOT, model: MODEL, reasoning: 'medium',
    generatedAt: writtenAt(), baseline, preflight, aborted, totals, rows,
  }, null, 2));
  writeFileSync(join(RUNS_ROOT, 'latest.json'), JSON.stringify({
    batchId: BATCH_ID, batchDir: RUNS_DIR, generatedAt: writtenAt(), totals,
    aborted: aborted ? aborted.reason : null,
  }, null, 2));
};
const finish = (reason, code) => {
  const totals = totalsOf(rows, aborted);
  const index = {
    batchId: BATCH_ID, batchDir: RUNS_DIR, copyRoot: COPY_ROOT, model: MODEL, reasoning: 'medium',
    generatedAt: writtenAt(), baseline, preflight, aborted,
    interleaving: 'block = repeat*3 + scenarioIndex；候选按 block%3 轮转；同 block 共用 seed/文案/fixture',
    sourceDriftDuringRun: Object.fromEntries(CANDIDATES.map(c => [c, JSON.stringify(baseline[c].source) !== JSON.stringify(candidateHashes(c)) || JSON.stringify(baseline[c].artifacts) !== JSON.stringify(artifactHashes(c))])),
    totals, rows,
  };
  writeFileSync(join(RUNS_DIR, 'index.json'), JSON.stringify(index, null, 2));
  writeFileSync(join(RUNS_ROOT, 'latest.json'), JSON.stringify({batchId: BATCH_ID, batchDir: RUNS_DIR, generatedAt: writtenAt(), totals, aborted: aborted ? aborted.reason : null, index: join(RUNS_DIR, 'index.json')}, null, 2));
  console.log(JSON.stringify({batchId: BATCH_ID, stopReason: reason, totals, index: join(RUNS_DIR, 'index.json')}));
  process.exit(code);
};

const baseline = Object.fromEntries(CANDIDATES.map(c => [c, {source: candidateHashes(c), artifacts: artifactHashes(c)}]));
const rows = [];
let aborted = null;

// ---- 批前预检：任一副本脚手架起不来就整批不跑 ----
const preflight = {};
for (const candidate of CANDIDATES) preflight[candidate] = await preflightCandidate(candidate);
if (!CANDIDATES.every(candidate => preflight[candidate].ok)) {
  writeFileSync(join(RUNS_DIR, 'preflight.json'), JSON.stringify(preflight, null, 2));
  aborted = {reason: 'preflight_failed', at: writtenAt(), candidates: CANDIDATES.filter(candidate => !preflight[candidate].ok)};
  flush();
  console.error(`预检失败，整批未跑：${JSON.stringify(aborted)}`);
  finish('preflight_failed', 1);
}
console.log(`preflight ok: ${CANDIDATES.map(c => `${c}=${preflight[c].elapsedMs}ms`).join(' ')}`);

let lastSetupSignature = null;
let consecutiveSetupFailures = 0;
for (const run of planned) {
  const copy = join(COPY_ROOT, run.candidate);
  if (!existsSync(copy)) {
    rows.push(row(run, {exitCode: null, logPath: null, elapsedMs: 0, infraFailure: `副本不存在: ${copy}`, settleReason: 'precheck'}));
    flush(); continue;
  }
  const stem = `${String(run.index).padStart(2, '0')}-${run.candidate}-${run.scenario}-r${run.repeat}`;
  const logPath = join(RUNS_DIR, `${stem}.log`);
  const outcome = await runChild([join(copy, 'node_modules/tsx/dist/cli.mjs'), join(copy, HARNESS_FILE), `--case=${run.scenario}`], {
    cwd: copy,
    env: childEnv({SIDEAGENT_AB_SEED: run.seed, SIDEAGENT_AB_CANDIDATE: run.candidate, SIDEAGENT_AB_BLOCK: String(run.block)}),
    timeoutMs: RUN_TIMEOUT_MS,
  });
  const {log, exitCode, spawnError, timedOut, settleReason, elapsedMs} = outcome;
  writeFileSync(logPath, log);
  const tail = lastJsonLine(log);
  const result = tail?.out && existsSync(join(tail.out, 'result.json')) ? JSON.parse(readFileSync(join(tail.out, 'result.json'), 'utf8')) : null;
  const errorText = `${tail?.error ?? ''}\n${result?.error ?? ''}\n${log.slice(-4000)}`;
  // 子进程可能在产出任何 JSON 之前就死于基础设施/脚手架错误；回看日志尾部，但仍只认已知特征。
  const infraFailure = spawnError ? `spawn_error: ${spawnError}` : classifyInfra(errorText);
  const gotModel = (result?.scenarioMetrics?.modelTurns ?? result?.environmentMetrics?.modelTurns ?? 0) > 0 || !!result?.answer;
  const signature = setupSignature(errorText);
  const setupFailure = !gotModel && signature ? signature : null;
  const entry = row(run, {exitCode, result: result ?? tail, tail, logPath, elapsedMs, infraFailure, spawnError, timedOut, settleReason, setupFailure});
  writeFileSync(join(RUNS_DIR, `${stem}.json`), JSON.stringify({...entry, stdoutTail: tail}, null, 2));
  rows.push(entry);
  if (entry.bucket === 'harness_setup_failure') {
    consecutiveSetupFailures = entry.setupFailure === lastSetupSignature ? consecutiveSetupFailures + 1 : 1;
    lastSetupSignature = entry.setupFailure;
  } else {
    consecutiveSetupFailures = 0;
    lastSetupSignature = null;
  }
  flush();
  console.log(`${String(run.index).padStart(2, '0')}/18 ${run.candidate} ${run.scenario} r${run.repeat} seed=${run.seed} exit=${exitCode} bucket=${entry.bucket} ms=${elapsedMs}`);
  if (consecutiveSetupFailures >= MAX_CONSECUTIVE_SETUP_FAILURES) {
    aborted = {reason: 'consecutive_harness_setup_failure', signature: lastSetupSignature, atIndex: run.index, count: consecutiveSetupFailures, at: writtenAt()};
    console.error(`连续 ${consecutiveSetupFailures} 条相同脚手架启动失败（${lastSetupSignature}），中止整批以免空转。`);
    finish('consecutive_harness_setup_failure', 1);
  }
}

const totals = totalsOf(rows, aborted);
finish('completed', totals.productFailure + totals.infraFailure + totals.timeout + totals.harnessSetupFailure === 0 ? 0 : 1);
