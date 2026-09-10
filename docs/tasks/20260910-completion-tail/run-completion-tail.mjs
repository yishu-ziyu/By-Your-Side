#!/usr/bin/env node
/**
 * 收尾验收编排（任务结果齐备后 5 秒内结束）。
 *
 * 仅在宿主运行：本 worker 的沙箱对 loopback listen/connect 一律 EPERM，tsx 自身启动即失败。
 *
 *   node docs/tasks/20260910-completion-tail/run-completion-tail.mjs --preflight-only
 *   node docs/tasks/20260910-completion-tail/run-completion-tail.mjs --repro-a     # 未改动 A 上复现（3 场景各 1 次）
 *   node docs/tasks/20260910-completion-tail/run-completion-tail.mjs --suite       # A 与候选各 6 次交错，共 12 次
 *
 * 每个真实样本保存原始 stdout/stderr、退出码与收尾指标；旧批次只增不覆盖（每批唯一目录 + latest.json）。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = '/Users/mahaoxuan/Desktop/ego';
const RUNS_DIR = join(ROOT, 'docs/tasks/20260910-completion-tail/runs');
const COPY_ROOT = '/tmp/ego-completion-tail-20260910';
const CANDIDATES = ['A', 'candidate'];
const SCENARIOS = ['state_environment', 'pick_target', 'delay_ready'];
const HARNESS_FILE = 'scripts/acceptance/completion-tail-run.mts';
const THRESHOLD_MS = 5000;
const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const HAS = name => process.argv.includes(`--${name}`);
const RUN_TIMEOUT_MS = Number(arg('runTimeoutMs', '360000'));
const PREFLIGHT_TIMEOUT_MS = Number(arg('preflightTimeoutMs', '90000'));
const KILL_GRACE_MS = Number(arg('killGraceMs', '8000'));
const PREFLIGHT_ONLY = HAS('preflight-only') || HAS('preflightOnly');
const MODE = HAS('suite') ? 'suite' : HAS('repro-a') || HAS('reproA') ? 'repro-a' : PREFLIGHT_ONLY ? 'preflight' : null;

const nowIso = () => new Date().toISOString();
const batchId = () => {
  const d = new Date(), p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(Math.floor(Math.random() * 100000), 5)}`;
};
const sha256 = file => existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null;

/** 单一 settle：spawn 'error' 不保证再发 'exit'，超时先 SIGTERM 宽限再 SIGKILL。 */
function runChild(args, { cwd, env, timeoutMs }) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    let child, settled = false, timedOut = false, timer, killTimer, out = '', err = '';
    const finish = (settleReason, code, spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(killTimer);
      resolve({ code, signal: null, timedOut, settleReason, spawnError: spawnError ? String(spawnError.message ?? spawnError) : null, stdout: out, stderr: err, elapsedMs: Date.now() - startedAt });
    };
    try {
      child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      return finish('spawn_error', null, error);
    }
    child.stdout.on('data', b => { out += b; });
    child.stderr.on('data', b => { err += b; });
    child.on('error', error => finish('error', null, error));
    child.on('close', code => finish('close', code, null));
    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, KILL_GRACE_MS);
    }, timeoutMs);
  });
}

const childEnv = extra => ({ ...process.env, ...extra });
const lastJsonLine = text => {
  for (const line of text.trim().split('\n').reverse()) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { return JSON.parse(t); } catch { /* keep looking */ }
  }
  return null;
};

async function preflightCandidate(candidate) {
  const copy = join(COPY_ROOT, candidate);
  if (!existsSync(copy)) return { ok: false, error: `缺少副本 ${copy}` };
  if (!existsSync(join(copy, 'node_modules/tsx/dist/cli.mjs'))) return { ok: false, error: '缺少 node_modules/tsx/dist/cli.mjs（依赖软链）' };
  const run = await runChild([join(copy, 'node_modules/tsx/dist/cli.mjs'), join(copy, HARNESS_FILE), '--preflight'], { cwd: copy, env: childEnv({ SIDEAGENT_TAIL_CANDIDATE: candidate }), timeoutMs: PREFLIGHT_TIMEOUT_MS });
  const parsed = lastJsonLine(run.stdout);
  if (run.timedOut) return { ok: false, error: `preflight timeout ${PREFLIGHT_TIMEOUT_MS}ms`, elapsedMs: run.elapsedMs };
  if (!parsed?.preflight || parsed.ok !== true) {
    const lines = `${run.stdout}\n${run.stderr}`.split('\n').map(l => l.trim()).filter(Boolean);
    const meaningful = lines.find(l => /EPERM|Error:|error TS|Cannot find|not a git|ERR_MODULE_NOT_FOUND|Could not resolve/i.test(l)) ?? lines.find(l => /error|failed/i.test(l));
    return { ok: false, error: meaningful ?? lines[0] ?? 'preflight 无输出', elapsedMs: run.elapsedMs };
  }
  return { ok: true, elapsedMs: run.elapsedMs, evidence: parsed.evidence ?? null };
}

/** 12 项计划：block 共享 scenario/seed/文案；A 与候选在 block 内交换先后。 */
function buildPlan() {
  if (MODE === 'repro-a') return SCENARIOS.map((scenario, i) => ({ index: i + 1, block: 0, candidate: 'A', scenario, repeat: 0, seed: 'completion-tail-repro-a' }));
  const plan = [];
  let index = 0;
  for (let block = 0; block < 6; block++) {
    const scenario = SCENARIOS[block % 3], repeat = Math.floor(block / 3);
    const seed = `completion-tail-20260910-b${block}`;
    for (let slot = 0; slot < 2; slot++) {
      const candidate = CANDIDATES[(block + slot) % 2];
      plan.push({ index: ++index, block, candidate, scenario, repeat, seed });
    }
  }
  return plan;
}

function classify(run, parsed) {
  if (run.timedOut) return 'timeout';
  if (run.spawnError) return 'harness_setup_failure';
  if (/listen EPERM|EPERM: operation not permitted|Cannot find module|ERR_MODULE_NOT_FOUND/.test(`${run.stderr}${run.stdout}`)) return 'harness_setup_failure';
  if (/Could not resolve host|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/.test(`${run.stderr}${run.stdout}`)) return 'infra_failure';
  if (run.code !== 0 || !parsed) return 'product_failure';
  if (parsed.tailQualified === true) return 'ok';
  // 读数缺失（采样抛错 / 运行标记未见 / 无停机采样）是测量问题，不是产品淘汰；
  // 但它也绝不算通过——单独一类，主代理可据此决定是否修测量后重跑。
  if (parsed.harnessError) return 'harness_measurement_failure';
  if (parsed.ok !== true) return 'product_failure';
  return 'product_failure';
}

async function runOne(item, batchDir) {
  const copy = join(COPY_ROOT, item.candidate);
  const run = await runChild([join(copy, 'node_modules/tsx/dist/cli.mjs'), join(copy, HARNESS_FILE), `--case=${item.scenario}`], {
    cwd: copy,
    env: childEnv({ SIDEAGENT_TAIL_SEED: item.seed, SIDEAGENT_TAIL_CANDIDATE: item.candidate, SIDEAGENT_TAIL_BLOCK: String(item.block) }),
    timeoutMs: RUN_TIMEOUT_MS,
  });
  const parsed = lastJsonLine(run.stdout);
  const bucket = classify(run, parsed);
  const stem = `${String(item.index).padStart(2, '0')}-${item.candidate}-${item.scenario}-r${item.repeat}`;
  writeFileSync(join(batchDir, `${stem}.log`), `${run.stdout}\n--- stderr ---\n${run.stderr}\n`);
  const row = {
    index: item.index, block: item.block, seed: item.seed, candidate: item.candidate, scenario: item.scenario, repeat: item.repeat,
    exitCode: run.code, settleReason: run.settleReason, timedOut: run.timedOut, spawnError: run.spawnError, bucket,
    elapsedMs: run.elapsedMs, logPath: join(batchDir, `${stem}.log`),
    tailQualified: parsed?.tailQualified ?? null, tailOk: parsed?.tail?.ok ?? null, tailWaitMs: parsed?.tail?.tailWaitMs ?? null,
    panelFullBodyMs: parsed?.tail?.tFullBodyMs ?? null, runtimeStopMs: parsed?.tail?.tRuntimeStopMs ?? null, tEndMs: parsed?.tail?.tEndMs ?? null,
    tResultsReadyMs: parsed?.tail?.tResultsReadyMs ?? null, pageCorrect: parsed?.pageCorrect ?? null,
    resultReadyEvidence: parsed?.tailDetails?.resultReadyEvidence ?? null, turnsAfterDelivery: parsed?.tailDetails?.turnsAfterDelivery ?? null,
    preDeliveryObserveCalls: parsed?.tailDetails?.preDeliveryObserveCalls ?? null, preDeliveryRegistrationCalls: parsed?.tailDetails?.preDeliveryRegistrationCalls ?? null,
    answer: parsed?.answer ?? null, checks: parsed?.checks ?? null, error: parsed?.error ?? null,
    harnessError: parsed?.harnessError ?? null, answerFacts: parsed?.answerFacts ?? null, samplingErrors: parsed?.samplingErrors ?? null,
  };
  writeFileSync(join(batchDir, `${stem}.json`), JSON.stringify({ ...row, report: parsed ?? null }, null, 2));
  return row;
}

function aggregate(rows) {
  const totals = { runs: rows.length, ok: 0, productFailure: 0, infraFailure: 0, harnessSetupFailure: 0, harnessMeasurementFailure: 0, timeout: 0 };
  for (const r of rows) {
    if (r.bucket === 'ok') totals.ok++;
    else if (r.bucket === 'timeout') totals.timeout++;
    else if (r.bucket === 'infra_failure') totals.infraFailure++;
    else if (r.bucket === 'harness_setup_failure') totals.harnessSetupFailure++;
    else if (r.bucket === 'harness_measurement_failure') totals.harnessMeasurementFailure++;
    else totals.productFailure++;
  }
  const perCandidate = {};
  for (const candidate of CANDIDATES) {
    const mine = rows.filter(r => r.candidate === candidate);
    const successes = mine.filter(r => r.bucket === 'ok' && r.tailQualified === true);
    // 严格门：六条都必须 tailQualified 且带有限完整 tailWaitMs；缺计时/事后违规都不得靠其余样本掩盖。
    const waits = mine.map(r => r.tailWaitMs);
    const allOk = mine.length === 6 && mine.every(r => r.tailQualified === true);
    const allFinite = waits.length === 6 && waits.every(v => typeof v === 'number' && Number.isFinite(v));
    perCandidate[candidate] = {
      runs: mine.length, successes: successes.length,
      maxTailWaitMs: allFinite ? Math.max(...waits) : null,
      allOk, allFinite,
      qualified: allOk && allFinite && Math.max(...waits) <= THRESHOLD_MS,
      tailWaits: mine.map(r => ({ index: r.index, scenario: r.scenario, repeat: r.repeat, qualified: r.tailQualified, tailWaitMs: r.tailWaitMs, bucket: r.bucket })),
    };
  }
  return { totals, perCandidate, thresholdMs: THRESHOLD_MS };
}

function snapshotHashes() {
  const files = ['agent/src/session.ts', 'agent/src/task-results.ts', 'agent/src/task-progress.ts', 'agent/src/tools.ts', 'agent/src/conversation-manager.ts', 'agent/src/conversation-runtime.ts', 'agent/src/browser-program.ts', 'shared/task-results.ts', 'scripts/acceptance/completion-tail-run.mts', 'scripts/acceptance/completion-tail-metrics.mts', 'scripts/acceptance/completion-tail-fixtures.mts'];
  const out = {};
  for (const candidate of CANDIDATES) out[candidate] = Object.fromEntries(files.map(f => [f, sha256(join(COPY_ROOT, candidate, f))]));
  return out;
}

async function main() {
  if (!MODE) { console.error('用法：--preflight-only | --repro-a | --suite'); process.exit(2); }
  if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });

  const preflight = {};
  for (const candidate of CANDIDATES) preflight[candidate] = await preflightCandidate(candidate);
  const baseline = snapshotHashes();
  if (PREFLIGHT_ONLY) {
    const ok = CANDIDATES.every(c => preflight[c].ok);
    console.log(JSON.stringify({ preflightOnly: true, copyRoot: COPY_ROOT, ok, results: preflight, baseline }, null, 2));
    process.exit(ok ? 0 : 1);
  }
  if (MODE === 'repro-a' && !preflight.A.ok) { console.log(JSON.stringify({ ok: false, aborted: 'preflight_failed', preflight }, null, 2)); process.exit(1); }
  if (MODE === 'suite' && !CANDIDATES.every(c => preflight[c].ok)) { console.log(JSON.stringify({ ok: false, aborted: 'preflight_failed', preflight }, null, 2)); process.exit(1); }
  console.log(`preflight ok: ${CANDIDATES.map(c => `${c}=${preflight[c].elapsedMs}ms`).join(' ')}`);

  const id = batchId();
  const batchDir = join(RUNS_DIR, id);
  mkdirSync(batchDir, { recursive: true });
  const plan = buildPlan();
  const rows = [];
  let aborted = null, consecutive = null, consecutiveCount = 0;

  for (const item of plan) {
    const row = await runOne(item, batchDir);
    rows.push(row);
    console.log(`#${row.index} ${row.candidate} ${row.scenario} r${row.repeat} -> ${row.bucket} tail=${row.tailWaitMs ?? 'n/a'} qualified=${row.tailQualified}${row.harnessError ? ` harnessError=${row.harnessError}` : ''}`);
    writeFileSync(join(batchDir, 'index.partial.json'), JSON.stringify({ batchId: id, mode: MODE, generatedAt: nowIso(), totals: aggregate(rows).totals, rows }, null, 2));
    if (row.bucket === 'harness_setup_failure' || row.bucket === 'harness_measurement_failure' || row.bucket === 'infra_failure') {
      const signature = `${row.bucket}:${(row.error ?? row.spawnError ?? row.harnessError ?? row.bucket).toString().slice(0, 160)}`;
      consecutiveCount = signature === consecutive ? consecutiveCount + 1 : 1;
      consecutive = signature;
      if (consecutiveCount >= 3) { aborted = { reason: 'repeated_startup_failure', signature, at: nowIso() }; break; }
    } else { consecutive = null; consecutiveCount = 0; }
  }

  const summary = { batchId: id, batchDir, mode: MODE, model: 'minimax-cn/MiniMax-M3', generatedAt: nowIso(), baseline, preflight, aborted, ...aggregate(rows), rows };
  writeFileSync(join(batchDir, 'index.json'), JSON.stringify(summary, null, 2));
  writeFileSync(join(RUNS_DIR, 'latest.json'), JSON.stringify({ batchId: id, batchDir, mode: MODE, generatedAt: nowIso(), totals: summary.totals, perCandidate: summary.perCandidate, aborted }, null, 2));
  console.log(JSON.stringify({ batchId: id, batchDir, totals: summary.totals, perCandidate: summary.perCandidate, aborted }, null, 2));
  process.exit(0);
}

main().catch(error => { console.error(String(error?.stack ?? error)); process.exit(1); });
