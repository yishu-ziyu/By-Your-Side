/**
 * P0 本地 Agent 实机验收驱动。
 *
 * 隔离无头 Chrome（Chrome for Testing，独立 profile、临时扩展副本、随机扩展 ID）
 * + 生产 ConversationManager / runtime / 工具链（进程内，独立 native host 存储目录）
 * + 真实模型（~/.sideagent/config.json 的当前默认模型）
 * + eval/p0 本机虚构站点（createP0Fixture）。
 *
 * 仅连接 127.0.0.1；不接日常 Chrome、日常扩展、真实账号，不发真实报名/付款/消息。
 * 逐场景写入 out/acceptance/p0-local-agent/cases/<id>/ 证据并更新同目录 results.json。
 *
 * 用法：npx tsx scripts/acceptance/p0-local-agent-run.mts --headless [--case <id>]... [--report out/acceptance/p0-local-agent]
 * 变体：--resume-entry text 用真实侧栏输入框 Enter 驱动恢复；--variant corrupt-checkpoint 复测最新检查点损坏。
 */
import {execFileSync, spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {cp, mkdir, mkdtemp, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {WebSocketServer, WebSocket} from 'ws';
import {Type} from 'typebox';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {createCdp, fetchJson} from './cdp.mjs';
import {pairedAcceptedReceipt, roundFinding} from './round-evidence.mjs';
import {sleep, until} from './isolated-extension.mts';
import {ConversationManager} from '../../agent/src/conversation-manager.js';
import {ConversationStore} from '../../agent/src/conversation-store.js';
import {createConversationRuntime} from '../../agent/src/conversation-runtime.js';
import {loadConfig} from '../../agent/src/config.js';
import {TaskDispatcher, TaskReceiptStore} from '../../agent/src/task-dispatcher.js';
import {DEFAULT_PORT, PROTOCOL_VERSION, HOST_VERSION, STORAGE_SCHEMA_VERSION, parseClientMessage} from '../../shared/protocol.js';
import {createP0Fixture} from '../eval/lib/p0-fixture.js';
import {assertWithinBudget, loadBudget, loadSpend, recordSpend, remaining} from '../eval/lib/budget.js';
import {trackTempDir} from './temp-profile.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

const nowIso = () => new Date().toISOString();

// ── CLI ─────────────────────────────────────────────────────────────

if (!process.argv.includes('--headless')) throw new Error('需要显式 --headless：本驱动只允许无头隔离运行。');

const argOf = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);

  return index === -1 ? undefined : process.argv[index + 1];
};

const casesWanted: string[] = [];

for (let i = 0; i < process.argv.length; i += 1) if (process.argv[i] === '--case' && process.argv[i + 1]) casesWanted.push(process.argv[i + 1]!);

const reportDirArg = argOf('--report') ?? 'out/acceptance/p0-local-agent';

const reportDir = resolve(root, reportDirArg);

// 恢复入口：voice=生产语音路由（默认，首轮实机口径）；text=真实侧栏输入框 Enter（面板 task_action/start）。
const resumeEntryArg = argOf('--resume-entry') ?? 'voice';

if (!['voice', 'text'].includes(resumeEntryArg)) throw new Error(`未知 --resume-entry：${resumeEntryArg}（可用 voice | text）`);

const resumeEntry = resumeEntryArg as 'voice' | 'text';

// 故障变体：corrupt-checkpoint 复测最新检查点损坏；accept-kill 在“已接收”回执后、模型首条输出前杀宿主。
const variant = argOf('--variant') ?? '';

if (variant && !['corrupt-checkpoint', 'accept-kill'].includes(variant)) throw new Error(`未知 --variant：${variant}`);

// 写入确认：真实面板卡片上的选择（allow=模拟用户允许一次，deny=拒绝）；off 不动。
const writeConsentArg = argOf('--write-consent') ?? 'off';

if (!['off', 'allow', 'deny'].includes(writeConsentArg)) throw new Error(`未知 --write-consent：${writeConsentArg}（可用 off | allow | deny）`);

const writeConsent = writeConsentArg as 'off' | 'allow' | 'deny';

// ── 构建指纹（与 scripts/eval/p0.mts 相同口径）──────────────────────

const manifestText = await readFile(join(root, 'eval/p0/cases.json'), 'utf8');

const manifest = JSON.parse(manifestText) as {version: number; cases: Array<{id: string; task: string; fault: string; maxSideEffects: number; preserveRun: boolean}>};

const fingerprintPaths = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'agent/src', 'extension/src', 'shared', 'package.json', 'package-lock.json', 'agent/package.json', 'extension/package.json', 'extension/build.mjs', 'extension/manifest.json', 'extension/public', 'extension/static', 'eval/p0', 'scripts/eval/lib/p0-fixture.ts', 'scripts/acceptance/p0-fixture.mts', 'scripts/acceptance/p0-local-agent-run.mts', 'scripts/acceptance/round-evidence.mts'], {cwd: root, encoding: 'utf8'}).split('\0').filter(Boolean);

const fingerprintHash = createHash('sha256');

for (const path of [...new Set(fingerprintPaths)].sort()) {
  fingerprintHash.update(path).update('\0');

  try { fingerprintHash.update(await readFile(join(root, path))); } catch { fingerprintHash.update('[deleted]'); }

  fingerprintHash.update('\0');
}

const build = {
  head: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(),
  fingerprint: fingerprintHash.digest('hex'),
  manifestHash: sha256(manifestText),
};

const reportFile = join(reportDir, 'results.json');

if (!existsSync(reportFile)) throw new Error(`缺少未运行模板：请先执行 npm run eval:p0 -- --init ${reportDirArg}`);

const report = JSON.parse(await readFile(reportFile, 'utf8')) as any;

if (report.build?.fingerprint !== build.fingerprint || report.build?.manifestHash !== build.manifestHash || report.build?.head !== build.head) {
  throw new Error('代码或场景清单已变化：不能用旧构建的结果验收当前工作树，请重新 --init 到新目录。');
}

// ── 预算与模型 ───────────────────────────────────────────────────────

const budget = loadBudget();

const spendBefore = loadSpend();

const left = remaining(budget, spendBefore);

assertWithinBudget(budget, spendBefore);

const model = loadConfig().model ?? '(未配置)';

console.log(JSON.stringify({report: relative(root, reportDir), build: build.fingerprint.slice(0, 12), head: build.head.slice(0, 8), model, budgetLeft: left}));

// 统计本进程的模型 HTTP 调用（pi-ai 走 globalThis.fetch）。
let modelCalls = 0;

const realFetch = globalThis.fetch;

globalThis.fetch = ((input: any, init?: any) => {
  try {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);

    if (!/^https?:\/\/(127\.0\.0\.1|localhost)/.test(url)) modelCalls += 1;
  } catch { /* 忽略 */ }

  return realFetch(input, init);
}) as typeof fetch;

// ── 记录与证据 ───────────────────────────────────────────────────────

type TraceEvent = {at: number; kind: string; [key: string]: unknown};

class Recorder {
  readonly events: TraceEvent[] = [];
  push(kind: string, data: Record<string, unknown> = {}): void { this.events.push({at: Date.now(), kind, ...data}); }
}

const KEEP_CLIENT = new Set(['hello', 'user_message', 'steer', 'task_action', 'abort', 'takeover', 'handback', 'consent_decision', 'page_event', 'task_control_result']);

const _KEEP_SERVER = new Set(['hello_ok', 'hello_error', 'conversation_list', 'conversation_created', 'conversation_updated', 'status', 'task_control_result', 'model_info', 'consent_list', 'consent_request', 'team_status']);

const KEEP_AGENT_KINDS = new Set(['agent_start', 'agent_end', 'error', 'notice', 'tool_start', 'tool_end', 'tool_observation', 'tool_late_result', 'user_delivery', 'user_delivery_stream', 'text_delta', 'thinking_delta', 'turn_start', 'turn_end']);

function trimText(value: string): string { return value.length > 3000 ? `${value.slice(0, 3000)}…[+${value.length - 3000}]` : value; }

function traceServerMessage(msg: any): Record<string, unknown> {
  if (msg.type === 'conversation_list') return {type: msg.type, conversations: (msg.conversations ?? []).map((c: any) => ({id: c.id, title: c.title, state: c.state, checkpoint: c.checkpoint, runId: c.runId}))};

  if (msg.type !== 'agent_event') return msg;
  const e = msg.event ?? {};

  if (!KEEP_AGENT_KINDS.has(e.kind)) return {type: 'agent_event', conversationId: msg.conversationId, event: {kind: e.kind}};
  const keep: any = {type: 'agent_event', conversationId: msg.conversationId, sessionId: msg.sessionId, runId: msg.runId, event: {kind: e.kind}};

  for (const key of ['toolCallId', 'name', 'isError', 'executionFact', 'message', 'plan', 'receipt', 'target', 'tabId', 'workingTab', 'url', 'truncated', 'tabIds']) if (e[key] !== undefined) keep.event[key] = e[key];

  if (e.params !== undefined) keep.event.params = e.params;

  if (e.delivery !== undefined) keep.event.delivery = e.kind === 'user_delivery' && e.delivery?.text ? {...e.delivery, text: trimText(e.delivery.text)} : e.delivery;

  for (const key of ['resultText', 'text', 'delta']) if (typeof e[key] === 'string') keep.event[key] = trimText(e[key]);

  return keep;
}

async function writeEvidenceFile(dir: string, name: string, value: unknown): Promise<{kind: 'trace' | 'state'; path: string; sha256: string}> {
  const file = join(dir, name);
  const text = JSON.stringify(value, null, 2) + '\n';
  await writeFile(file, text);

  return {kind: name.startsWith('state') ? 'state' : 'trace', path: relative(reportDir, file), sha256: sha256(text)};
}

// ── 隔离浏览器 ───────────────────────────────────────────────────────

function resolveChrome(): string {
  const override = process.env.EGO_ACCEPTANCE_CHROME;

  if (override) return override;
  const base = join(homedir(), 'Library/Caches/ms-playwright');
  const suffix = 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
  const versions = existsSync(base) ? readdirSync(base).filter(name => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.slice('chromium-'.length)) - Number(a.slice('chromium-'.length))) : [];

  for (const version of versions) {
    const candidate = join(base, version, suffix);

    if (existsSync(candidate)) return candidate;
  }

  throw new Error('未找到 Chrome for Testing：请安装 Playwright 的 Chromium，或用 EGO_ACCEPTANCE_CHROME 指定。');
}

interface Iso {
  outDir: string; profile: string; extensionId: string; cdp: ReturnType<typeof createCdp>;
  swTargetId: string; swSession: string;
  swEval(expression: string, timeoutMs?: number): Promise<any>;
  evalIn(targetId: string, expression: string, timeoutMs?: number): Promise<any>;
  newTarget(url: string): Promise<string>;
  activateTarget(targetId: string): Promise<void>;
  targetInfo(targetId: string): Promise<{url: string; title?: string} | undefined>;
  closeTarget(targetId: string): Promise<void>;
  screenshot(targetId: string, file: string): Promise<void>;
  reattachSw(): Promise<boolean>;
  close(opts?: {keepDir?: boolean}): Promise<void>;
}

async function launchIso(opts: {token: string; profileDir?: string; extensionDir?: string}): Promise<Iso> {
  const outDir = opts.profileDir ? dirname(opts.profileDir) : await mkdtemp(join(tmpdir(), 'sideagent-p0-'));
  // A folder created here is removed on close() or at process end; a caller-supplied profile stays the caller's.
  const tempDir = opts.profileDir ? undefined : trackTempDir(outDir);
  const profile = opts.profileDir ?? join(outDir, 'profile');
  const extDir = opts.extensionDir ?? join(outDir, 'extension');

  if (!opts.profileDir) {
    await cp(resolve(root, 'extension/dist'), extDir, {recursive: true});
    const manifestPath = join(extDir, 'manifest.json');
    const extManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    delete extManifest.key;
    await writeFile(manifestPath, `${JSON.stringify(extManifest, null, 2)}\n`);
  }

  if (opts.profileDir) await rm(join(profile, 'DevToolsActivePort'), {force: true}).catch(() => {});

  const child = spawn(resolveChrome(), [
    '--headless=new', '--mute-audio', '--enable-unsafe-extension-debugging',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
    '--host-resolver-rules=MAP p0.test 127.0.0.1', '--no-proxy-server',
    '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required', 'about:blank',
  ], {stdio: 'ignore'});
  tempDir?.setChild(child);

  const port = await until(async () => {
    try { return (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; } catch { return undefined; }
  }, 20_000, 'Chrome 调试端口');

  const version = await until(async () => {
    try { return await fetchJson(`http://127.0.0.1:${port}/json/version`); } catch { return undefined; }
  }, 15_000, 'Chrome DevTools 就绪');

  const cdp = createCdp(version.webSocketDebuggerUrl);
  await cdp.ready();

  const iso: Iso = {
    outDir, profile, cdp, extensionId: '', swTargetId: '', swSession: '',
    swEval: async (expression, timeoutMs = 60_000) => {
      const r = await cdp.send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}, iso.swSession, timeoutMs);

      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);

      return r.result?.value;
    },
    evalIn: async (targetId, expression, timeoutMs = 60_000) => {
      const session = await cdp.attachSession(targetId);
      const r = await cdp.send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}, session, timeoutMs);

      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);

      return r.result?.value;
    },
    newTarget: async url => (await cdp.send('Target.createTarget', {url})).targetId as string,
    activateTarget: async targetId => { await cdp.send('Target.activateTarget', {targetId}); },
    targetInfo: async targetId => {
      try {
        const info = await cdp.send('Target.getTargetInfo', {targetId});

        return {url: info.targetInfo?.url ?? '', title: info.targetInfo?.title};
      } catch { return undefined; }
    },
    closeTarget: async targetId => { await cdp.send('Target.closeTarget', {targetId}).catch(() => {}); },
    screenshot: async (targetId, file) => {
      const session = await cdp.attachSession(targetId);
      const shot = await cdp.send('Page.captureScreenshot', {format: 'png'}, session);
      await writeFile(file, Buffer.from(shot.data as string, 'base64'));
    },
    reattachSw: async () => {
      const found = await until(async () => {
        const targets = await cdp.send('Target.getTargets');
        const candidates = targets.targetInfos.filter((t: any) => t.type === 'service_worker' && (t.url ?? '').startsWith('chrome-extension://'));

        for (const candidate of candidates) {
          const session = await cdp.attachSession(candidate.targetId);
          const probe = await cdp.send('Runtime.evaluate', {expression: 'chrome.runtime.getManifest().name', returnByValue: true}, session).catch(() => undefined);

          if (probe?.result?.value === 'By Your Side') return {targetId: candidate.targetId, session, url: candidate.url as string};
        }

        return undefined;
      }, 25_000, '扩展 service worker').catch(() => undefined);

      if (!found) return false;
      iso.swTargetId = found.targetId;
      iso.swSession = found.session;
      iso.extensionId = new URL(found.url).host;

      return true;
    },
    close: async (closeOpts?: {keepDir?: boolean}) => {
      child.kill('SIGKILL');
      await cdp.close().catch(() => {});

      if (!closeOpts?.keepDir) {
        if (tempDir) tempDir.release();
        else await rm(outDir, {recursive: true, force: true}).catch(() => {});
      }
    },
  };

  await iso.reattachSw();

  if (!iso.swSession) throw new Error('未找到隔离扩展的 service worker');
  await iso.swEval(`chrome.storage.local.set({sideagent_token:${JSON.stringify(opts.token)}})`, 15_000);

  return iso;
}

// ── 进程内伴随宿主（可停止/重启）────────────────────────────────────

class Host {
  manager!: ConversationManager;
  server!: WebSocketServer;
  client: WebSocket | undefined;
  hellos = 0;
  /** 延迟回执注入：命中时暂扣扩展回传的 tool_result，直到显式释放。 */
  holdToolResults = false;
  readonly heldToolResults: any[] = [];
  constructor(private readonly opts: {runtimeDir: string; token: string; recorder: Recorder; customTools?: any[]}) {}

  async start(): Promise<void> {
    const store = new ConversationStore(join(this.opts.runtimeDir, 'conversations'));
    this.manager = new ConversationManager(
      (id, emit, summary) => {
        const toolsExtra = this.opts.customTools ? {customTools: this.opts.customTools} : {};

        return createConversationRuntime(id, emit, summary?.model ?? model, {sessionManager: store.sessionManager(id), mode: summary?.mode, ...toolsExtra});
      },
      message => {
        this.opts.recorder.push('server_msg', {rawType: message?.type, msg: message?.type ? traceServerMessage(message) : message});

        try { this.client?.send(JSON.stringify(message)); } catch { /* 通道已断 */ }
      },
      store,
      undefined,
      undefined,
      new TaskDispatcher(new TaskReceiptStore(join(this.opts.runtimeDir, 'receipts'))),
    );
    await this.manager.ensureDefault();
    // 直接监听扩展内置的 ws 调试端口：隔离扩展（随机 ID、无 native host 清单）会自然回退到这里。
    this.server = new WebSocketServer({host: '127.0.0.1', port: DEFAULT_PORT});
    await new Promise<void>((res, rej) => { this.server.once('listening', res); this.server.once('error', rej); });
    this.server.on('connection', ws => {
      ws.on('message', raw => { void this.onFrame(ws, String(raw)); });
      ws.on('close', () => { if (this.client === ws) { this.client = undefined; this.opts.recorder.push('host_client_gone'); this.manager.disconnect(); } });
    });
  }

  private async onFrame(ws: WebSocket, raw: string): Promise<void> {
    const msg = parseClientMessage(raw);

    if (!msg) return;

    if (this.holdToolResults && msg.type === 'tool_result') {
      this.heldToolResults.push(msg);
      this.opts.recorder.push('tool_result_held', {id: msg.id});

      return;
    }

    if (KEEP_CLIENT.has(msg.type)) this.opts.recorder.push('client_msg', {msg});

    if (msg.type === 'hello') {
      if (msg.token !== this.opts.token) { ws.close();

 return; }

      this.client = ws;
      this.hellos += 1;
      this.opts.recorder.push('host_hello', {count: this.hellos});
      this.manager.reconnect();
      const session = this.manager.get('default')!.runtime.session;

      try {
        const models = await session.availableModels();

        const frames = [
          {type: 'hello_ok', version: PROTOCOL_VERSION, model: session.modelName(), models, hostVersion: HOST_VERSION, storageSchema: STORAGE_SCHEMA_VERSION, extensionVersion: '0.2.0'},
          {type: 'conversation_list', conversations: this.manager.list()},
        ];

        for (const frame of frames) { this.opts.recorder.push('server_msg', {rawType: frame.type, msg: frame}); ws.send(JSON.stringify(frame)); }

        this.manager.replayState(m => { this.opts.recorder.push('server_msg', {rawType: (m as any).type, msg: traceServerMessage(m)}); ws.send(JSON.stringify(m)); });
      } catch (error) {
        this.opts.recorder.push('host_hello_error', {error: String(error)});
      }

      return;
    }

    try { await this.manager.handleMessage(msg); }
    catch (error) { try { ws.send(JSON.stringify({type: 'agent_event', conversationId: (msg as any).conversationId, event: {kind: 'error', message: String(error)}})); } catch { /* 忽略 */ } }
  }

  /** 模拟伴随进程退出：先按生产语义保留检查点，再断开。 */
  async stop(): Promise<void> {
    this.opts.recorder.push('host_stop');

    try { this.manager.disconnect(); } catch { /* 忽略 */ }

    try { this.client?.close(); } catch { /* 忽略 */ }

    for (const client of this.server.clients) { try { client.terminate(); } catch { /* 忽略 */ } }

    await new Promise<void>(res => this.server.close(() => res()));
    this.manager.dispose();
    this.client = undefined;
  }

  /** 释放被扣住的工具回执（迟到读数场景）。 */
  releaseHeldToolResults(): number {
    this.holdToolResults = false;
    const held = this.heldToolResults.splice(0);

    for (const frame of held) {
      this.opts.recorder.push('tool_result_released', {id: frame.id});
      void this.manager.handleMessage(frame as any).catch(() => {});
    }

    return held.length;
  }

  async restart(): Promise<void> {
    await this.start();
    this.opts.recorder.push('host_restart', {});
  }
}

// ── 场景脚手架 ───────────────────────────────────────────────────────

interface FixtureBox { origin: string; localOrigin: string; seed: string; server: ReturnType<typeof createP0Fixture>; close(): Promise<void> }

async function startFixture(): Promise<FixtureBox> {
  const seed = randomUUID().replace(/-/g, '').slice(0, 8);
  const server = createP0Fixture(seed);
  await new Promise<void>(res => server.listen(0, '127.0.0.1', res));
  const port = (server.address() as any).port;

  return {
    // 浏览器侧用映射主机名（--host-resolver-rules → 127.0.0.1），以通过产品 fetch 的公网地址校验；
    // harness 自己（Node）用回环地址。
    origin: `http://p0.test:${port}`, localOrigin: `http://127.0.0.1:${port}`, seed, server,
    close: async () => { server.closeAllConnections(); await new Promise<void>(res => server.close(() => res())); },
  };
}

/** 队列场景的等待闸门工具：让一个任务在隔离环境里保持运行，供并发/排队观察。 */
function createBarrier(): {tool: any; entered: boolean; release: () => void} {
  let releaseFn!: () => void;
  const gate = new Promise<void>(resolve => { releaseFn = resolve; });

  const barrier: any = {
    entered: false,
    release: () => releaseFn(),
    tool: {
      name: 'await_fixture_release',
      label: '等待验收资料',
      description: 'Wait until the fixture releases the source page, then continue with the task.',
      parameters: Type.Object({}),
      execute: async () => {
        barrier.entered = true;
        await gate;

        return {content: [{type: 'text' as const, text: '资料已就绪，现在读取页面回答。'}], details: {}};
      },
    },
  };

  return barrier;
}

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** 起一个任务，等它推进到可观察点后重启宿主，留下中断检查点。 */
async function armCheckpoint(c: Case, text: string, ready: (c: Case) => Promise<boolean>, readyLabel: string): Promise<boolean> {
  await c.say(text);
  await c.waitProgress('default', p => p.state === 'running', 90_000, '任务开始运行');
  c.runIds.before = (await c.progress())?.runId ?? null;
  await until(async () => (await ready(c)) || undefined, 150_000, readyLabel);
  await c.restartHost();
  const p = await c.progress();

  return c.check('断连后保留原 runId 的中断检查点', p?.state === 'interrupted' && p?.runId === c.runIds.before, {state: p?.state, runId: p?.runId, expected: c.runIds.before});
}

/** 检查点是否已真正落盘：accepted 前的原子 acceptance 或后续 task-results 任一存在即可恢复。 */
async function checkpointDurable(c: Case, conversationId = 'default'): Promise<boolean> {
  const pointer = join(c.runtimeDir, 'conversations', conversationId, 'session-path.txt');

  if (!existsSync(pointer)) return false;
  const file = (await readFile(pointer, 'utf8')).trim();

  if (!existsSync(file)) return false;
  const text=await readFile(file, 'utf8');

  return text.includes('"sideagent-task-acceptance-v1"')||text.includes('"sideagent-task-results-v1"');
}

/** 时间老化（模拟）：改写隔离会话文件里检查点条目的时间戳。 */
async function ageCheckpoint(c: Case, conversationId: string, deltaMs: number): Promise<number> {
  const pointer = join(c.runtimeDir, 'conversations', conversationId, 'session-path.txt');

  if (!existsSync(pointer)) return 0;
  const file = (await readFile(pointer, 'utf8')).trim();

  if (!existsSync(file)) return 0;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
    let changed = 0;

    const aged = lines.map(line => {
      try {
        const entry = JSON.parse(line);

        if (entry?.type === 'custom' && ['sideagent-task-acceptance-v1','sideagent-task-results-v1', 'sideagent-recovery-attachments-v1'].includes(entry.customType)) {
          if (typeof entry.timestamp === 'string') entry.timestamp = new Date(Date.now() - deltaMs).toISOString();
          else entry.timestamp = Date.now() - deltaMs;
          changed += 1;

          return JSON.stringify(entry);
        }

        return line;
      } catch { return line; }
    });

    if (changed > 0) {
      await writeFile(file, aged.join('\n') + '\n');

      return changed;
    }

    await sleep(800);
  }

  return 0;
}

/** 读取隔离会话文件，提取"恢复时是否真的带上了原图"的原始证据摘要。 */
async function sessionResumeEvidence(c: Case, conversationId: string): Promise<any> {
  const pointer = join(c.runtimeDir, 'conversations', conversationId, 'session-path.txt');

  if (!existsSync(pointer)) return {error: 'no session pointer'};
  const file = (await readFile(pointer, 'utf8')).trim();

  if (!existsSync(file)) return {error: 'no session file'};
  const entries = (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return {parseError: true}; } });

  const summary = entries.map(entry => {
    if (entry?.type === 'custom') {
      const snapshot=entry.customType==='sideagent-task-acceptance-v1'?entry.data?.snapshot:entry.data;

      const customExtra = ['sideagent-task-acceptance-v1','sideagent-task-results-v1'].includes(entry.customType) ? {requirements: snapshot?.recoveryInput?.requirements?.length ?? 0, attachmentKeys: snapshot?.recoveryInput?.attachmentKeys?.length ?? 0} : {};

      return {kind: 'custom', customType: entry.customType, ...customExtra};
    }

    const message = entry?.message ?? entry;

    if (message?.role) {
      const content = Array.isArray(message.content) ? message.content : [];
      const imagePart = content.find((part: any) => part?.type === 'image');

      return {
        kind: 'message', role: message.role,
        parts: content.map((part: any) => part?.type ?? typeof part),
        imageBytes: imagePart ? String(imagePart.data ?? imagePart.image ?? '').length : 0,
        text: content.map((part: any) => (part?.type === 'text' ? String(part.text ?? '') : '')).join('').slice(0, 300),
      };
    }

    return {kind: entry?.type ?? 'unknown'};
  });

  return {file, total: entries.length, entries: summary.slice(-16)};
}

class Case {
  readonly recorder = new Recorder();
  readonly checks: Array<{name: string; ok: boolean; detail?: string}> = [];
  readonly dir: string;
  readonly runtimeDir: string;
  readonly startedAt = nowIso();
  endedAt = '';
  iso: Iso | undefined;
  host: Host | undefined;
  fixture: FixtureBox | undefined;
  panelTarget: string | undefined;
  readonly pages: Array<{target: string; url: string}> = [];
  modelCallsBefore = modelCalls;
  readonly token = randomUUID();
  runIds: Record<string, string | null | undefined> = {};
  metrics: any = null;
  stateExtra: Record<string, unknown> = {};
  barrier: ReturnType<typeof createBarrier> | undefined;
  /** 场景声明为"恢复失败"的次数与用户纠正次数（人工核对后由场景填写）。 */
  recoveryFailures = 0;
  userCorrections = 0;
  constructor(readonly id: string, readonly definition: {task: string; fault: string; maxSideEffects: number; preserveRun: boolean}, readonly evidenceId = id) {
    this.dir = join(reportDir, 'cases', evidenceId);
    this.runtimeDir = join(reportDir, 'runtime', `${evidenceId}-${Date.now()}`);
  }

  check(name: string, ok: boolean, detail?: unknown): boolean {
    const text = detail === undefined ? undefined : typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 800);
    const detailExtra = text ? {detail: text} : {};
    this.checks.push({name, ok, ...detailExtra});

    if (!ok) console.log(`  FAIL-CHECK ${this.id}: ${name}${text ? ` — ${text.slice(0, 300)}` : ''}`);

    return ok;
  }

  note(text: string): void { this.recorder.push('note', {text}); }

  eventsSince(mark: number): TraceEvent[] { return this.recorder.events.slice(mark); }

  hasServerEvent(events: TraceEvent[], pred: (msg: any) => boolean): boolean {
    return events.some(e => e.kind === 'server_msg' && pred((e as any).msg));
  }

  toolStarts(name?: string, events: TraceEvent[] = this.recorder.events): any[] {
    return events.flatMap(e => (e.kind === 'server_msg' && (e as any).msg?.type === 'agent_event' && (e as any).msg.event?.kind === 'tool_start' && (!name || (e as any).msg.event?.name === name)) ? [(e as any).msg.event] : []);
  }

  async say(text: string): Promise<void> {
    if (!this.iso || !this.panelTarget) throw new Error('面板尚未打开');
    this.recorder.push('user_utterance', {text});
    const count = () => this.recorder.events.filter(e => e.kind === 'client_msg' && ['task_action', 'user_message', 'steer'].includes((e as any).msg?.type)).length;
    const before = count();
    await this.iso.evalIn(this.panelTarget, `(()=>{const input=document.querySelector('#input');input.value=${JSON.stringify(text)};input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true;})()`);
    await until(() => count() > before || undefined, 15_000, `消息已发出：${text.slice(0, 30)}`);
  }

  /** 复测恢复入口：默认走生产语音路由；--resume-entry text 时走真实侧栏输入框 Enter（面板 task_action/start）。返回文字入口实际发出的 task_action。 */
  async resume(text = '继续原任务', conversationId = 'default'): Promise<any | undefined> {
    if (resumeEntry !== 'text') { await this.voiceInput(text, conversationId);

 return undefined; }

    if (conversationId && (await this.selectedConversation()) !== conversationId) await this.selectConversation(conversationId);
    const mark = this.recorder.events.length;
    await this.say(text);

    return this.eventsSince(mark).filter(e => e.kind === 'client_msg' && (e as any).msg?.type === 'task_action').map(e => (e as any).msg).at(-1);
  }

  /** 沿真实面板通道重发同一条客户端消息（同 requestId），用于幂等重发检查。 */
  async resendPanelClient(msg: unknown): Promise<void> {
    await this.iso!.evalIn(this.panelTarget!, `(()=>{window.probePort=window.probePort??chrome.runtime.connect({name:'sideagent-panel'});window.probePort.postMessage({kind:'client',msg:${JSON.stringify(msg)}});return true;})()`);
  }

  /**
   * 真实面板确认卡片上的选择：--write-consent allow/deny 时由驱动作为模拟用户点卡片按钮
   * （卡片不可用时退回同一条面板通道），并把看到的请求与决定记入 trace。
   */
  watchWriteConsents(mode: 'allow' | 'deny'): () => void {
    let stopped = false;
    const seen = new Set<string>();

    const loop = async () => {
      while (!stopped) {
        try {
          for (const event of [...this.recorder.events]) {
            if (event.kind !== 'server_msg') continue;
            const msg = (event as any).msg;

            if (msg?.type !== 'consent_request' || msg.request?.kind !== 'write') continue;
            const request = msg.request as {id: string; conversationId: string};

            if (seen.has(request.id)) continue;
            seen.add(request.id);
            this.recorder.push('write_consent_seen', {request: msg.request});
            const allow = mode === 'allow';
            let clicked = false;

            for (let attempt = 0; attempt < 4 && !clicked; attempt += 1) {
              if (attempt) await sleep(400);
              clicked = await this.clickConsentButton(request.id, allow ? '.consent-allow' : '.consent-reject');
            }

            this.recorder.push('write_consent_decision', {requestId: request.id, allow, via: clicked ? 'panel-card' : 'panel-port'});

            if (!clicked) await this.resendPanelClient({type: 'consent_decision', conversationId: request.conversationId, requestId: request.id, allow}).catch(() => {});
          }
        } catch { /* 面板可能正在重开 */ }

        await sleep(400);
      }
    };

    void loop();

    return () => { stopped = true; };
  }

  async clickConsentButton(requestId: string, selector: string): Promise<boolean> {
    if (!this.panelTarget) return false;

    return await this.iso!.evalIn(this.panelTarget, `(()=>{const card=[...document.querySelectorAll('.consent-card')].find(el=>el.dataset.requestId===${JSON.stringify(requestId)});const btn=card&&card.querySelector(${JSON.stringify(selector)});if(btn instanceof HTMLButtonElement&&!btn.disabled){btn.click();return true;}return false;})()`).catch(() => false) as boolean;
  }

  /** 从某条日志位置起的 snapshot 工具启动事件（恢复读页的唯一标识）。 */
  snapshotStartsSince(since: number): any[] {
    return this.eventsSince(since).filter(e => e.kind === 'server_msg' && (e as any).msg?.type === 'agent_event' && (e as any).msg.event?.kind === 'tool_start' && (e as any).msg.event?.name === 'snapshot').map(e => (e as any).msg.event);
  }

  /** 走真实面板中止按钮；不可用时退回 stopping 发送键或面板端口 abort。 */
  async panelAbort(): Promise<void> {
    if (!this.iso || !this.panelTarget) throw new Error('面板尚未打开');

    const via = await this.iso.evalIn(this.panelTarget, `(()=>{
      const abort=document.querySelector('#abort-btn');
      if(abort&&!abort.hidden&&abort.getClientRects().length){abort.click();return 'abort-btn';}
      const send=document.querySelector('#send-btn');
      if(send&&send.classList.contains('stopping')){send.click();return 'send-btn';}
      if(window.probePort){window.probePort.postMessage({kind:'client',msg:{type:'abort'}});return 'port';}
      return 'none';
    })()`);

    this.note(`面板取消：${via}`);
    await until(() => this.recorder.events.some(e => e.kind === 'client_msg' && (e as any).msg?.type === 'abort') || undefined, 8_000, '取消已发出').catch(() => {});
    await sleep(400);
  }

  async progress(conversationId = 'default'): Promise<any> { return this.host?.manager.getTaskProgress(conversationId) ?? null; }

  async waitProgress(conversationId: string, pred: (p: any) => boolean, ms: number, label: string): Promise<any> {
    return await until(() => { const p = this.host?.manager.getTaskProgress(conversationId);

 return p && pred(p) ? p : undefined; }, ms, label);
  }

  /** 最近一次正式交付（finding）。 */
  delivery(conversationId = 'default', kind = 'finding'): any {
    return [...this.recorder.events].reverse().find(e => e.kind === 'server_msg' && (e as any).msg?.type === 'agent_event' && (e as any).msg.conversationId === conversationId && (e as any).msg.event?.kind === 'user_delivery' && (e as any).msg.event.delivery?.kind === kind);
  }

  deliveries(conversationId = 'default', kind = 'finding'): any[] {
    return this.recorder.events.filter(e => e.kind === 'server_msg' && (e as any).msg?.type === 'agent_event' && (e as any).msg.conversationId === conversationId && (e as any).msg.event?.kind === 'user_delivery' && (e as any).msg.event.delivery?.kind === kind).map(e => (e as any).msg.event.delivery);
  }

  async waitFinding(conversationId = 'default', ms = 150_000): Promise<any | undefined> {
    return await until(() => this.deliveries(conversationId).at(-1), ms, `正式交付 ${conversationId}`).catch(() => undefined);
  }

  async waitIdle(conversationId = 'default', ms = 150_000): Promise<any | undefined> {
    return await this.waitProgress(conversationId, p => p.state === 'idle', ms, `任务空闲 ${conversationId}`).catch(() => undefined);
  }

  async waitAgentEnd(conversationId = 'default', ms = 150_000): Promise<void> {
    await until(() => this.recorder.events.some(e => e.kind === 'server_msg' && (e as any).msg?.type === 'agent_event' && (e as any).msg.conversationId === conversationId && (e as any).msg.event?.kind === 'agent_end') || undefined, ms, `agent_end ${conversationId}`);
  }

  async openPage(path: string, opts: {activate?: boolean} = {}): Promise<string> {
    if (!this.iso || !this.fixture) throw new Error('环境未就绪');
    const url = this.fixture.origin + path;
    const target = await this.iso.newTarget(url);
    this.pages.push({target, url});

    if (opts.activate !== false) {
      // URL is not a tab identity: recovery tests can intentionally have two
      // tabs with the same URL after a browser/profile restart. Activate the
      // exact CDP target we just created so the panel context and later checks
      // refer to the same page instance.
      await this.iso.activateTarget(target);
      await until(async () => (await this.activeUrl()) === url || undefined, 8_000, `激活新标签页 ${url}`);
    }

    return target;
  }

  async activateUrl(url: string): Promise<number | undefined> {
    const tabId = await until(async () => {
      const tabs = await this.iso!.swEval('chrome.tabs.query({})') as any[];

      return (tabs ?? []).find((t: any) => t.url === url)?.id;
    }, 8_000, `标签页就绪 ${url}`).catch(() => undefined);

    if (typeof tabId === 'number') await this.iso!.swEval(`chrome.tabs.update(${tabId},{active:true})`);

    return tabId as number | undefined;
  }

  async activeUrl(): Promise<string | undefined> {
    const tabs = await this.iso!.swEval('chrome.tabs.query({active:true,lastFocusedWindow:true})') as any[];

    return tabs?.[0]?.url;
  }

  async pageText(target: string): Promise<string> { return await this.iso!.evalIn(target, 'document.body.innerText'); }

  async pageValue(target: string, selector: string): Promise<string> {
    return await this.iso!.evalIn(target, `(()=>{const el=document.querySelector(${JSON.stringify(selector)});return el?(el.value??el.textContent??''):null;})()`);
  }

  async screenshotState(target: string, name: string): Promise<string> {
    const file = join(this.dir, name);
    await this.iso!.screenshot(target, file);
    this.recorder.push('screenshot', {path: relative(reportDir, file)});

    return relative(reportDir, file);
  }

  async fixtureState(): Promise<any> { return await realFetch(`${this.fixture!.localOrigin}/api/state`).then(r => r.json()); }
  async fixturePost(path: string, body: unknown): Promise<any> { return await realFetch(`${this.fixture!.localOrigin}${path}`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)}).then(r => r.json()).catch(error => ({error: String(error)})); }

  async panelText(): Promise<string> { return await this.iso!.evalIn(this.panelTarget!, 'document.body.innerText'); }

  async openPanel(): Promise<string> {
    const target = await this.iso!.newTarget(`chrome-extension://${this.iso!.extensionId}/sidepanel.html`);
    this.panelTarget = target;
    await until(async () => await this.iso!.evalIn(target, `document.readyState==='complete' && !!document.querySelector('#input')`) || undefined, 15_000, '侧栏面板');
    await this.ensurePanelPort();

    return target;
  }

  /** 只建立一条面板调试端口；不触发上游重连（重连会把运行中的任务标记为中断）。 */
  async ensurePanelPort(): Promise<void> {
    await this.iso!.evalIn(this.panelTarget!, `(()=>{window.probePort=window.probePort??chrome.runtime.connect({name:'sideagent-panel'});return true;})()`).catch(() => {});
  }

  /** 用户语音输入（产品提示语即是"说'继续原任务'"；恢复/修订都走这条真实入口）。 */
  async voiceInput(text = '继续原任务', conversationId = 'default'): Promise<any> {
    if (!this.host) throw new Error('宿主未就绪');
    const context = await this.activeContext();
    this.recorder.push('user_utterance', {text, via: 'voice', conversationId, context});

    const inputExtra = context ? {input: {context}} : {};

    const route = {
      voiceId: 'test-voice', requestId: randomUUID(), turn: 1, runId: (await this.progress(conversationId))?.runId ?? null,
      ...inputExtra,
      targets: this.host.manager.voiceTargets(),
      onInputDecision: () => {}, reportStage: () => {},
    };

    const result = await this.host.manager.routeVoiceInput(conversationId, text, Date.now(), () => true, route).catch(error => ({error: String(error)}));
    this.recorder.push('voice_route', {text, conversationId, result});

    return result;
  }

  async activeTabId(): Promise<number | undefined> {
    const tabs = await this.iso!.swEval('chrome.tabs.query({active:true,lastFocusedWindow:true})') as any[];

    return tabs?.[0]?.id;
  }

  async activeContext(): Promise<{tabId: number; title: string; url: string} | undefined> {
    const tabs = await this.iso?.swEval('chrome.tabs.query({active:true,lastFocusedWindow:true})').catch(() => undefined) as any[] | undefined;
    const tab = tabs?.[0];

    return tab ? {tabId: tab.id, title: tab.title ?? '', url: tab.url ?? ''} : undefined;
  }

  async forceReconnect(): Promise<void> {
    this.note('harness_retry：连接断开时由面板通道触发一次重连');
    await this.iso!.evalIn(this.panelTarget!, `(()=>{window.probePort=window.probePort??chrome.runtime.connect({name:'sideagent-panel'});window.probePort.postMessage({kind:'retry'});return true;})()`).catch(() => {});
  }

  /** 用户切回某个会话（与面板菜单同一通道）。 */
  async selectConversation(id: string): Promise<void> {
    await this.iso!.evalIn(this.panelTarget!, `(()=>{window.probePort=window.probePort??chrome.runtime.connect({name:'sideagent-panel'});window.probePort.postMessage({kind:'select_conversation',conversationId:${JSON.stringify(id)}});return true;})()`);
    await until(async () => (await this.selectedConversation()) === id || undefined, 10_000, `切换会话 ${id}`);
  }

  async waitHostHellos(count: number, ms = 25_000): Promise<boolean> {
    try { await until(() => (this.host?.hellos ?? 0) >= count || undefined, ms, `宿主第 ${count} 次 hello`);

 return true; } catch { return false; }
  }

  /** 首次连接建立：先等自动重连，超时后用面板通道触发一次（开机阶段无任务，重连是安全的）。 */
  async awaitHostConnected(ms = 30_000): Promise<boolean> {
    if ((this.host?.hellos ?? 0) > 0) return true;

    if (await this.waitHostHellos(1, 5_000)) return true;
    await this.forceReconnect();

    return await this.waitHostHellos(1, ms);
  }

  /** 重启宿主；等待扩展重连（超时则触发一次面板重试）。 */
  async restartHost(): Promise<void> {
    const before = this.host!.hellos;
    await this.host!.stop();
    await this.host!.restart();
    let ok = await this.waitHostHellos(before + 1, 12_000);

    if (!ok) { await this.forceReconnect(); ok = await this.waitHostHellos(before + 1, 20_000); }

    this.check(`宿主重启后扩展重连（第 ${before + 1} 次 hello）`, ok);
    await sleep(500);
  }

  /** 扩展侧重启（同 profile 重启隔离浏览器）：扩展后端与 WS 连接重启，chrome.storage 与扩展身份保留；
   *  页面会丢失，需重新打开——等价于用户重启浏览器后重连。不经 chrome.runtime.reload()（该隔离加载方式下会屏蔽扩展）。 */
  async relaunchBrowser(): Promise<void> {
    const profile = this.iso!.profile;
    const extensionDir = join(profile, '..', 'extension');
    const before = this.host!.hellos;
    this.note('注入：同 profile 重启隔离浏览器（扩展侧重启；不触碰日常 Chrome/扩展）');
    await this.iso!.close({keepDir: true}).catch(() => {});
    this.iso = await launchIso({token: this.token, profileDir: profile, extensionDir: resolve(extensionDir)});
    this.panelTarget = undefined;
    await this.openPanel();
    let ok = await this.waitHostHellos(before + 1, 8_000);

    if (!ok) { await this.forceReconnect(); ok = await this.waitHostHellos(before + 1, 25_000); }

    this.check(`扩展侧重启后重新连上宿主（第 ${before + 1} 次 hello）`, ok);
    await this.selectConversation('default').catch(() => {});
    this.check('重启后能切回原会话', (await this.selectedConversation()) === 'default', await this.selectedConversation());
  }

  async selectedConversation(): Promise<string | undefined> {
    return await this.iso!.swEval("chrome.storage.session.get('selectedConversationId').then(s=>s.selectedConversationId??'default')");
  }

  /** 用户点击「新会话」，等待选择真正切过去。 */
  async newConversation(): Promise<string> {
    const before = await this.selectedConversation();
    await this.iso!.evalIn(this.panelTarget!, `(()=>{document.querySelector('#conversation-new').click();return true;})()`);

    const id = await until(async () => { const current = await this.selectedConversation();

 return current && current !== before ? current : undefined; }, 15_000, '新会话');

    this.note(`用户新建会话：${id}`);

    return id;
  }

  /** 通过真实文件选择器通道（CDP setFileInputFiles）给面板附一张图。 */
  async panelAttachFile(file: string): Promise<void> {
    const session = await this.iso!.cdp.attachSession(this.panelTarget!);
    await this.iso!.cdp.send('DOM.enable', {}, session);
    const {root: doc} = await this.iso!.cdp.send('DOM.getDocument', {}, session);
    const {nodeId} = await this.iso!.cdp.send('DOM.querySelector', {nodeId: doc.nodeId, selector: '#file-input'}, session);
    await this.iso!.cdp.send('DOM.setFileInputFiles', {files: [file], nodeId}, session);
    await until(async () => await this.iso!.evalIn(this.panelTarget!, `!document.querySelector('#attachments-strip').hidden`) || undefined, 10_000, '附件就绪');
  }

  /** 用隔离浏览器渲染一张带文字的 PNG（不依赖外部图片工具）。 */
  async makeTextImage(text: string, name: string): Promise<string> {
    const target = await this.iso!.newTarget(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><body style="font:64px/1.6 system-ui;padding:40px">${text}</body>`)}`);
    await sleep(400);
    const file = join(this.dir, name);
    await this.iso!.screenshot(target, file);
    await this.iso!.closeTarget(target);

    return file;
  }

  async snapshotProgress(label: string, conversationId = 'default'): Promise<void> {
    const snapshot = await this.progress(conversationId);
    (this.stateExtra.progress ??= {})[label] = snapshot;
  }
}

// ── 场景实现 ─────────────────────────────────────────────────────────

const CASES: Record<string, (c: Case) => Promise<void>> = {
  async research(c) {
    const page = await c.openPage('/research');
    await c.say('读取三家方案，按预算与退换条件选出合适的一家，并给出逐页依据。');
    await c.waitProgress('default', p => p.state === 'running', 60_000, '任务开始运行');
    c.runIds.before = (await c.progress())?.runId ?? null;
    const finding = await c.waitFinding('default', 240_000);
    c.check('研究任务给出正式交付', !!finding, finding?.text?.slice(0, 160));
    const text = String(finding?.text ?? '');
    c.check('答案选择预算内且支持退换的海风方案', text.includes('海风'), text.slice(0, 200));
    const mentions = ['青松', '远山'].filter(name => text.includes(name)).length;
    c.check('答案给出逐页依据（至少两页的名称与条件）', mentions >= 2 && /退换|预算/.test(text), `提及 ${mentions}/2 家`);
    const state = await c.fixtureState();
    c.check('只读研究没有产生任何写入', state.sideEffects === 0, state);
    const after = await c.progress();
    c.runIds.after = after?.runId ?? null;
    c.check('任务结束后为空闲状态', after?.state === 'idle', after?.state);
    await c.screenshotState(page, 'research-final.png');
  },

  async 'form-readback'(c) {
    const form = await c.openPage('/form');
    await c.say('把测试姓名填成「测试甲」，方案选「海风」，保存一次，然后核对保存回执。');
    await c.waitProgress('default', p => p.state === 'running', 90_000, '任务开始运行');
    c.runIds.before = (await c.progress())?.runId ?? null;
    const finding = await c.waitFinding('default', 240_000);
    c.runIds.after = (await c.progress())?.runId ?? null;
    const state = await c.fixtureState();
    const record = state.records?.[0];
    c.check('保存动作实际发生一次', state.sideEffects === 1, {sideEffects: state.sideEffects});
    c.check('没有重复写入', state.duplicateWrites === 0, state);
    c.check('没有错页写入', state.wrongPageWrites === 0, state);
    c.check('写入内容与要求一致', record?.name === '测试甲' && record?.choice === 'b' && record?.page === '/form', record);
    c.check('给出正式交付', !!finding, finding?.text?.slice(0, 120));
    const delivery = String(finding?.text ?? '');
    c.check('交付核对了保存回执', /回执|已保存|receipt|测试甲/i.test(delivery), delivery.slice(0, 160));
    c.check('页面显示保存结果', /测试甲/.test(await c.pageText(form)));
    c.check('任务结束后为空闲状态', (await c.progress())?.state === 'idle', (await c.progress())?.state);
    c.check('任务身份未被替换', c.runIds.after === c.runIds.before, {before: c.runIds.before, after: c.runIds.after});
    await c.screenshotState(form, 'form-readback.png');
  },

  async 'receipt-loss'(c) {
    const form = await c.openPage('/form');
    await c.fixturePost('/api/fault', {dropNextReceipt: true});
    c.note('注入：dropNextReceipt=true（下一次保存先落服务端再断回执）');
    await c.say('在页面上把测试姓名填成「测试乙」，方案选「青松」，保存一次。');
    await c.waitProgress('default', p => p.state === 'running', 90_000, '任务开始运行');
    c.runIds.before = (await c.progress())?.runId ?? null;
    await until(async () => ((await c.fixtureState()).sideEffects >= 1) || undefined, 180_000, '保存已落到服务端');
    await c.snapshotProgress('after-write');
    await sleep(150);
    const steerMark = c.recorder.events.length;
    const steerAtMs = Date.now();
    await c.say('先不要重复保存；查一下测试站点 /api/state 的真实状态，把已有记录内容告诉我，再按情况继续。');

    // 只认插话窗口内、与已发出请求编号配对的 accepted/applied 回执；按 action 或旧回执都不算送达。
    const steerReceipts = () => c.eventsSince(steerMark)
      .filter(e => e.kind === 'server_msg' && (e as any).msg?.type === 'agent_event' && (e as any).msg.event?.receipt)
      .map(e => (e as any).msg.event.receipt as {requestId?: string; action?: string; status?: string});

    const steerRequestIds = () => c.eventsSince(steerMark)
      .filter(e => e.kind === 'client_msg' && (e as any).msg?.type === 'task_action' && (e as any).msg.request?.action === 'steer')
      .map(e => (e as any).msg.request?.requestId as string | undefined)
      .filter((id): id is string => typeof id === 'string');

    const steered = await until(() => pairedAcceptedReceipt(steerReceipts(), steerRequestIds()) || undefined, 30_000, 'steer accepted/applied').then(() => true).catch(() => false);
    c.check('补充要求作为同一任务的修改送达（steer 回执 accepted/applied）', steered, {requests: steerRequestIds(), receipts: steerReceipts().slice(-2)});
    await c.waitIdle('default', 240_000);
    // 后续查询只认新窗口；正式交付必须是插话后、且晚于本轮查询组合的 finding，不能采到旧交付。
    const readTools = ['fetch', 'navigate', 'snapshot', 'js', 'read_element', 'browser_run'];
    const readStarts = () => c.eventsSince(steerMark).filter(e => e.kind === 'server_msg' && (e as any).msg?.type === 'agent_event' && (e as any).msg.event?.kind === 'tool_start' && readTools.includes((e as any).msg.event?.name));

    const roundDeliveries = () => c.eventsSince(steerMark)
      .filter(e => e.kind === 'server_msg' && (e as any).msg?.type === 'agent_event' && (e as any).msg.event?.kind === 'user_delivery' && (e as any).msg.event.delivery?.kind === 'finding')
      .map(e => (e as any).msg.event.delivery as {kind?: string; runId?: string | null; composedAt?: number; text?: string});

    const queryAtMs = readStarts()[0]?.at;
    const finding = await until(() => roundFinding(roundDeliveries(), c.runIds.before, Math.max(steerAtMs, queryAtMs ?? steerAtMs)) || undefined, 30_000, '插话后正式交付').catch(() => undefined);
    c.check('插话轮次给出新的正式交付', !!finding, finding?.text?.slice(0, 160) ?? `窗口内交付=${roundDeliveries().length}`);
    const state = await c.fixtureState();
    c.check('整个场景只写入一次', state.sideEffects === 1, {sideEffects: state.sideEffects});
    c.check('没有重复保存', state.duplicateWrites === 0, state);
    c.check('没有错页写入', state.wrongPageWrites === 0, state);
    const record = (state.records ?? [])[0] as {name?: string; choice?: string; page?: string} | undefined;
    const all = String(finding?.text ?? '');
    const mentionsChoice = !!record?.choice && new RegExp(`(?:^|[^\\w])${record.choice}(?:[^\\w]|$)`, 'i').test(all);
    c.check('后续交付提到服务端已有记录', /测试乙/.test(all), all.slice(0, 200));
    c.check('正式交付与服务端实际记录一致', !!record && all.includes(String(record.name)) && (all.includes('青松') || mentionsChoice), {record, text: all.slice(0, 200)});
    c.check('后续查询过服务端或页面状态', readStarts().length > 0);
    c.runIds.after = (await c.progress())?.runId ?? null;
    c.check('查询与继续沿用原任务身份', c.runIds.after === c.runIds.before, {before: c.runIds.before, after: c.runIds.after});
    c.userCorrections = 1;
    c.snapshotProgress('after-query');
    await c.screenshotState(form, 'receipt-loss.png');
  },

  async 'panel-reopen'(c) {
    const page = await c.openPage('/research');
    await c.say('跨三个页面读取方案：分别打开三家方案页，汇总每家的价格和退换条件后告诉我。');
    await c.waitProgress('default', p => p.state === 'running', 90_000, '任务开始运行');
    c.runIds.before = (await c.progress())?.runId ?? null;
    await sleep(2500);
    await c.iso!.closeTarget(c.panelTarget!);
    c.note('用户关闭侧栏（任务继续在宿主侧执行）');
    c.panelTarget = undefined;
    await sleep(2000);
    const p1 = await c.progress();
    c.check('关闭侧栏不打断运行（仍在运行）', p1?.state === 'running', p1?.state);
    await c.openPanel();
    const selected = await c.selectedConversation();
    c.note(`重开侧栏后面板按产品行为进入会话：${selected}（原任务仍在 default 继续）`);

    // 产品行为：重开侧栏默认新开一段空会话；运行中的任务必须继续在原会话执行。
    if (selected && selected !== 'default') {
      const emptyProgress = await c.progress(selected);
      c.check('重开侧栏创建的是空会话，没有新任务', !emptyProgress || emptyProgress.runId === null, emptyProgress?.runId ?? null);
    }

    const finding = await c.waitFinding('default', 240_000);
    c.runIds.after = (await c.progress())?.runId ?? null;
    c.check('运行中的任务继续并给出正式交付', !!finding, finding?.text?.slice(0, 120));
    c.check('没有新建任务（runId 未变化）', c.runIds.after === c.runIds.before, {before: c.runIds.before, after: c.runIds.after});
    const state = await c.fixtureState();
    c.check('只读任务没有副作用', state.sideEffects === 0, state);
    c.check('任务结束时为空闲', (await c.progress())?.state === 'idle', (await c.progress())?.state);
    // 用户切回原会话可看到结果（不重复执行）
    await c.selectConversation('default').catch(() => {});

    const shown = await until(async () => { const text = await c.panelText();

 return /海风|方案/.test(text) ? text : undefined; }, 15_000, '切回后看到原任务结果').catch(() => undefined);

    c.check('切回原会话能看到已完成结果', !!shown, (shown ?? '').slice(-160));
    await c.screenshotState(page, 'panel-reopen.png');
  },

  async 'extension-reload'(c) {
    const form = await c.openPage('/form');
    const _formUrl = c.fixture!.origin + '/form';
    await c.say('把测试姓名填成「测试丙」，方案选「远山」，先不要保存；填好后把表单当前内容读一遍告诉我。');
    await c.waitProgress('default', p => p.state === 'running', 90_000, '任务开始运行');
    c.runIds.before = (await c.progress())?.runId ?? null;
    await until(async () => ((await c.pageValue(form, '#name')) === '测试丙') || undefined, 180_000, '姓名已填入');
    const mark = c.recorder.events.length;
    await c.relaunchBrowser();
    await sleep(5000);
    const afterReload = c.eventsSince(mark);
    const auto = afterReload.filter(e => e.kind === 'server_msg' && (e as any).msg?.type === 'agent_event' && ['agent_start', 'tool_start', 'user_delivery'].includes((e as any).msg.event?.kind));
    c.check('重连后没有自动执行（无 agent_start / 工具 / 交付）', auto.length === 0, auto.slice(0, 2).map((e: any) => e.msg.event.kind));
    const p1 = await c.progress();
    c.check('扩展侧重启后保留原 runId 的中断检查点', p1?.state === 'interrupted' && p1?.runId === c.runIds.before, {state: p1?.state, runId: p1?.runId});
    // 页面随浏览器重启丢失；用户重新打开原页面
    const form2 = await c.openPage('/form');
    const mark2 = c.recorder.events.length;
    await c.resume();
    await until(() => c.eventsSince(mark2).some(e => e.kind === 'server_msg' && (e as any).msg?.type === 'agent_event' && (e as any).msg.event?.kind === 'tool_start' && (e as any).msg.event?.name === 'snapshot') || undefined, 150_000, '恢复先读取页面');
    const p2 = await c.progress();
    c.check('明确继续后沿原检查点启动（不新开任务）', p2?.runId === c.runIds.before, {runId: p2?.runId, expected: c.runIds.before});
    await c.waitFinding('default', 240_000).catch(() => undefined);
    await c.waitIdle('default', 90_000).catch(() => undefined);
    c.runIds.after = (await c.progress())?.runId ?? null;
    const state = await c.fixtureState();
    c.check('全程没有保存（副作用为零）', state.sideEffects === 0, state);
    c.check('恢复后在新页面重新完成填写', (await c.pageValue(form2, '#name')) === '测试丙', await c.pageValue(form2, '#name'));
    c.check('任务身份全程不变', c.runIds.after === c.runIds.before, {before: c.runIds.before, after: c.runIds.after});
    await c.screenshotState(form2, 'extension-reload.png');
  },

  async 'host-restart'(c) {
    const form = await c.openPage('/form');
    const formUrl = c.fixture!.origin + '/form';
    const autoSince = (mark: number) => c.eventsSince(mark).filter(e => e.kind === 'server_msg' && (e as any).msg?.type === 'agent_event' && ['agent_start', 'tool_start', 'user_delivery'].includes((e as any).msg.event?.kind));
    const autoChecks: Array<{boundary: string; count: number}> = [];
    // 边界一：工具前（任务刚被接收）
    await c.say('把测试姓名填成「测试丁」，方案选「海风」，保存一次。');
    await until(async () => (await c.progress())?.runId || undefined, 30_000, '任务已被接收');
    c.runIds.before = (await c.progress())?.runId ?? null;
    // 场景声明为“工具前注入”：先等检查点真正落盘，否则杀宿主测的是“接收后未落盘”窗口（会话文件尚未创建），
    // 会把驱动竞态当成产品丢失检查点。
    await until(async () => (await checkpointDurable(c)) || undefined, 30_000, '检查点已落盘（工具前注入前置）');
    c.note(`边界一注入（工具前）：已见工具 ${c.toolStarts().length} 个，runId=${c.runIds.before}`);
    let mark = c.recorder.events.length;
    await c.restartHost();
    await sleep(2500);
    autoChecks.push({boundary: '工具前', count: autoSince(mark).length});
    let p = await c.progress();
    c.check('边界一：重启后保留原 runId 的中断检查点', p?.state === 'interrupted' && p?.runId === c.runIds.before, {state: p?.state, runId: p?.runId});
    c.snapshotProgress('restart-1');
    // 恢复并推进到写入派发
    await c.activateUrl(formUrl);
    const resumeSent = await c.resume();

    if (resumeEntry === 'text') {
      const request = (resumeSent as any)?.request;
      c.check('面板实际发送 task_action/start（source=text、原文“继续原任务”）', request?.action === 'start' && request?.source === 'text' && request?.text === '继续原任务', request);
      const requestId = request?.requestId as string | undefined;

      const resolved = requestId
        ? await until(() => { const r = c.host!.manager.dispatcher.get('default', requestId);

 return r?.action === 'resume' ? r : undefined; }, 120_000, '文字恢复回执').catch(() => undefined)
        : undefined;

      c.check('同一条 task_action/start 被解析为 resume 且沿用原 runId', resolved?.status === 'accepted' && resolved?.runId === c.runIds.before, resolved);

      if (requestId) {
        await c.resendPanelClient(resumeSent);
        await sleep(1500);
        const repeated = c.host!.manager.dispatcher.get('default', requestId);
        c.check('同编号重发返回原回执，没有另开任务', repeated?.action === 'resume' && repeated?.status === 'accepted' && repeated?.runId === c.runIds.before, repeated);
        const conflictMark = c.recorder.events.length;
        await c.resendPanelClient({...resumeSent, request: {...request, text: '另外做个新的只读任务。'}});
        const conflict = await until(() => c.eventsSince(conflictMark).some(e => e.kind === 'server_msg' && (e as any).msg?.type === 'agent_event' && (e as any).msg.event?.kind === 'notice' && String((e as any).msg.event?.message ?? '').includes('同一请求编号')) || undefined, 20_000, '同编号改内容被拒').catch(() => undefined);
        c.check('同编号但内容变化仍拒绝，任务身份不变', !!conflict && (await c.progress())?.runId === c.runIds.before, {conflict: !!conflict, runId: (await c.progress())?.runId});
      }
    }

    await until(async () => {
      const st = await c.fixtureState();

      if (st.sideEffects >= 1) return true;

      return c.eventsSince(mark).some(e => e.kind === 'server_msg' && (e as any).msg?.type === 'agent_event' && (e as any).msg.event?.kind === 'tool_start' && ['click', 'fill', 'type_text', 'js', 'browser_run'].includes((e as any).msg.event?.name) && /save|保存|#save/.test(JSON.stringify((e as any).msg.event?.params ?? {}))) ? true : undefined;
    }, 300_000, '保存被派发或已落服务端');
    await sleep(200);
    c.note('边界二注入（写入派发后尚无回执）');
    mark = c.recorder.events.length;
    await c.restartHost();
    await sleep(2500);
    autoChecks.push({boundary: '派发后', count: autoSince(mark).length});
    p = await c.progress();
    c.check('边界二：重启后保留原 runId 的中断检查点', p?.state === 'interrupted' && p?.runId === c.runIds.before, {state: p?.state, runId: p?.runId});
    c.snapshotProgress('restart-2');
    // 第二次恢复：先核对未知写入，不得直接重放
    await c.activateUrl(formUrl);
    await c.resume();

    const settled = await until(async () => {
      const st = await c.progress();
      const finding = c.deliveries('default').at(-1);

      if (finding && (st?.state === 'idle' || st?.state === 'interrupted')) return true;

      if (st?.state === 'idle') return true;

      return undefined;
    }, 300_000, '写入确认后任务收束').catch(() => undefined);

    c.check('边界二恢复后任务收束', !!settled);
    c.snapshotProgress('after-second-resume');
    // 边界三：已确认写入后重启
    c.note('边界三注入（已确认写入后）');
    mark = c.recorder.events.length;
    await c.restartHost();
    await sleep(2500);
    autoChecks.push({boundary: '回执后', count: autoSince(mark).length});
    const p3 = await c.progress();

    if (p3?.state === 'interrupted') {
      await c.activateUrl(formUrl);
      await c.resume();
      await c.waitFinding('default', 240_000).catch(() => undefined);
      await c.waitIdle('default', 90_000).catch(() => undefined);
    }

    await sleep(1000);
    const finalState = await c.fixtureState();
    c.check('全程只写入一次', finalState.sideEffects === 1, {sideEffects: finalState.sideEffects});
    c.check('没有重复写入', finalState.duplicateWrites === 0, finalState);
    c.check('没有错页写入', finalState.wrongPageWrites === 0, finalState);
    c.runIds.after = (await c.progress())?.runId ?? null;
    c.check('三次重启后任务身份不变', c.runIds.after === c.runIds.before, {before: c.runIds.before, after: c.runIds.after});
    const auto = autoChecks.filter(x => x.count > 0);
    c.check('每次重启后都无自动重放', auto.length === 0, autoChecks);
    c.stateExtra.boundaries = autoChecks;
    await c.screenshotState(form, 'host-restart.png');
  },

  async 'wrong-page'(c) {
    const form = await c.openPage('/form');
    const formUrl = c.fixture!.origin + '/form';
    const otherUrl = c.fixture!.origin + '/other';
    await armCheckpoint(c, '把测试姓名填成「测试戊」，方案选「青松」，先不要保存；填好后把表单当前内容读一遍告诉我。',
      async cc => ((await cc.pageValue(form, '#name')) === '测试戊'), '姓名已填入（重启前）');
    await c.openPage('/other');
    await c.activateUrl(otherUrl);
    let mark = c.recorder.events.length;
    await c.resume();
    await sleep(3000);
    const p1 = await c.progress();
    c.check('当前页换成另一张表单时恢复被拒绝且检查点保留', p1?.state === 'interrupted' && p1?.runId === c.runIds.before, {state: p1?.state, runId: p1?.runId});
    const early = c.eventsSince(mark).filter(e => e.kind === 'server_msg' && (e as any).msg?.type === 'agent_event' && (e as any).msg.event?.kind === 'tool_start' && ['snapshot', 'read_element', 'browser_run', 'click', 'fill', 'type_text', 'js'].includes((e as any).msg.event?.name));
    c.check('拒绝发生在任何页面动作之前', early.length === 0, early.map((e: any) => e.msg.event.name));
    const afterReject = await c.fixtureState();
    c.check('没有往新页面写入', afterReject.sideEffects === 0 && afterReject.wrongPageWrites === 0, afterReject);
    // 回到原 URL 的新标签才允许重新核对
    await c.iso!.closeTarget(form);
    const form2 = await c.openPage('/form');
    await c.activateUrl(formUrl);
    mark = c.recorder.events.length;
    await c.resume();
    await until(() => c.eventsSince(mark).some(e => e.kind === 'server_msg' && (e as any).msg?.type === 'agent_event' && (e as any).msg.event?.kind === 'tool_start' && (e as any).msg.event?.name === 'snapshot') || undefined, 150_000, '新标签重新核对（先读页）');
    await c.waitFinding('default', 240_000).catch(() => undefined);
    await c.waitIdle('default', 90_000).catch(() => undefined);
    c.runIds.after = (await c.progress())?.runId ?? null;
    const finalState = await c.fixtureState();
    c.check('全程零写入', finalState.sideEffects === 0 && finalState.wrongPageWrites === 0, finalState);
    c.check('恢复后沿原任务身份续接', c.runIds.after === c.runIds.before, {before: c.runIds.before, after: c.runIds.after});
    c.check('新标签里表单是已完成的内容', (await c.pageValue(form2, '#name')) === '测试戊', await c.pageValue(form2, '#name'));
    await c.screenshotState(form2, 'wrong-page.png');
  },

  async 'refresh-login'(c) {
    const form = await c.openPage('/form');
    const formUrl = c.fixture!.origin + '/form';
    const loginUrl = c.fixture!.origin + '/login';
    await armCheckpoint(c, '把测试姓名填成「测试庚」，方案选「远山」，先不要保存。',
      async cc => ((await cc.pageValue(form, '#name')) === '测试庚'), '姓名已填入（重启前）');
    const tabId = await c.activateUrl(formUrl);
    await c.iso!.swEval(`chrome.tabs.update(${tabId},{url:${JSON.stringify(loginUrl)}})`);
    await until(async () => (await c.activeUrl()) === loginUrl || undefined, 20_000, '已跳到登录入口');
    let mark = c.recorder.events.length;
    await c.resume();
    await sleep(3000);
    const p1 = await c.progress();
    c.check('页面跳到登录入口后恢复被拒且检查点保留', p1?.state === 'interrupted' && p1?.runId === c.runIds.before, {state: p1?.state, runId: p1?.runId});
    const early = c.eventsSince(mark).filter(e => e.kind === 'server_msg' && (e as any).msg?.type === 'agent_event' && (e as any).msg.event?.kind === 'tool_start');
    c.check('拒绝发生在任何工具动作之前', early.length === 0, early.map((e: any) => e.msg.event.name));
    // 用户把页面带回原 URL
    await c.iso!.swEval(`chrome.tabs.update(${tabId},{url:${JSON.stringify(formUrl)}})`);
    await until(async () => (await c.activeUrl()) === formUrl || undefined, 20_000, '回到原表单页');
    await c.activateUrl(formUrl);
    mark = c.recorder.events.length;
    await c.resume();
    await until(() => c.eventsSince(mark).some(e => e.kind === 'server_msg' && (e as any).msg?.type === 'agent_event' && (e as any).msg.event?.kind === 'tool_start' && (e as any).msg.event?.name === 'snapshot') || undefined, 150_000, '恢复重新读取当前页面');
    await c.waitFinding('default', 240_000).catch(() => undefined);
    await c.waitIdle('default', 90_000).catch(() => undefined);
    c.runIds.after = (await c.progress())?.runId ?? null;
    const state = await c.fixtureState();
    c.check('全程零写入', state.sideEffects === 0, state);
    c.check('回到原页面后沿原任务身份续接', c.runIds.after === c.runIds.before, {before: c.runIds.before, after: c.runIds.after});
    c.check('恢复后在新的页面状态上继续填写', (await c.pageValue(form, '#name')) === '测试庚', await c.pageValue(form, '#name'));
    await c.screenshotState(form, 'refresh-login.png');
  },

  async 'resume-cancel'(c) {
    const form = await c.openPage('/form');
    const formUrl = c.fixture!.origin + '/form';
    await armCheckpoint(c, '把测试姓名填成「测试辛」，方案选「青松」，先不要保存。',
      async cc => ((await cc.pageValue(form, '#name')) === '测试辛'), '姓名已填入（重启前）');
    await c.activateUrl(formUrl);
    c.host!.holdToolResults = true;
    c.note('注入：暂扣扩展回传的 tool_result，模拟恢复读页尚未返回');
    const mark = c.recorder.events.length;
    const resumeSent = await c.resume();
    await until(() => c.host!.heldToolResults.length > 0 || undefined, 90_000, '恢复读页的回执被扣留');

    if (resumeEntry === 'text') {
      const request = (resumeSent as any)?.request;
      c.check('面板实际发送 task_action/start（source=text）', request?.action === 'start' && request?.source === 'text', request);
      c.check('恢复读页在慢回执窗口内只发出一次', c.snapshotStartsSince(mark).length === 1, c.snapshotStartsSince(mark).length);
      await c.resendPanelClient(resumeSent);
      await sleep(1500);
      c.check('同编号重发没有触发第二次读页或新启动', c.snapshotStartsSince(mark).length === 1 && c.host!.heldToolResults.length === 1, {snapshots: c.snapshotStartsSince(mark).length, held: c.host!.heldToolResults.length});
    }

    const during = c.progress();
    const duringEvents = c.eventsSince(mark);
    c.check('读页返回前没有启动模型（无 agent_start）', !duringEvents.some(e => e.kind === 'server_msg' && (e as any).msg?.type === 'agent_event' && (e as any).msg.event?.kind === 'agent_start'), duringEvents.slice(0, 2));
    c.check('读页未返回时检查点仍是中断', (await during)?.state === 'interrupted', (await during)?.state);
    const cancelAt = Date.now();
    await c.panelAbort();
    await sleep(1200);
    const afterCancel = await c.progress();
    c.check('取消在慢读返回前生效（控制不等待读页）', afterCancel?.state === 'aborted', afterCancel?.state);
    const released = c.host!.releaseHeldToolResults();
    c.check('迟到读数确实存在并被释放', released >= 1, released);
    await sleep(5000);
    const afterRelease = c.eventsSince(mark);
    const lateModel = afterRelease.filter(e => e.kind === 'server_msg' && (e as any).msg?.type === 'agent_event' && (e as any).msg.event?.kind === 'agent_start' && e.at > cancelAt);
    c.check('迟到读数没有启动模型', lateModel.length === 0, lateModel.length);
    const state = await c.fixtureState();
    c.check('迟到读数没有新增写入', state.sideEffects === 0, state);
    c.runIds.after = (await c.progress())?.runId ?? null;
    c.check('取消后仍保留原任务身份', c.runIds.after === c.runIds.before, {before: c.runIds.before, after: c.runIds.after});
    c.snapshotProgress('after-cancel-release');
    await c.screenshotState(form, 'resume-cancel.png');
  },

  async 'queue-recovery'(c) {
    const barrier = c.barrier!;
    const _researchUrl = c.fixture!.origin + '/research';
    const research = await c.openPage('/research');
    await c.say('先调用 await_fixture_release 等待资料就绪，然后读取当前页面标题并回答。');
    await until(() => barrier.entered || undefined, 150_000, '任务一进入等待');
    c.check('任务一已占用运行名额', (await c.progress())?.state === 'running', (await c.progress())?.state);
    // 用户切到另一张标签页后用语音提出两个独立只读要求
    const otherUrl = c.fixture!.origin + '/other';
    await c.openPage('/other');
    const tabId = await c.activeTabId();

    const makeRoute = () => ({
      voiceId: 'test-voice', requestId: randomUUID(), turn: 1, runId: null,
      input: {context: {tabId, title: '另一张表单', url: otherUrl}, attachments: [{id: 'queue-image', name: 'queue.png', type: 'image' as const, mimeType: 'image/png', dataBase64: PNG_BASE64}]},
      targets: c.host!.manager.voiceTargets(),
      onInputDecision: () => {}, reportStage: () => {},
    });

    c.note('用户语音（文本由测试侧提供，路由/分类/排队为真实生产路径）：两次独立要求，附带合成附件');
    const result1 = await c.host!.manager.routeVoiceInput('default', '另外再做一件独立的事，只看不写：读取 /other 页面的标题，单独告诉我。', Date.now(), () => true, makeRoute()).catch(error => ({error: String(error)}));
    c.recorder.push('voice_route', {result: result1});
    c.check('第一条独立要求被受理', !(result1 as any).error, (result1 as any).error);
    const result2 = await c.host!.manager.routeVoiceInput('default', '另外再做一件独立的事，只看不写：读取 /research 页面上的预算数字，单独告诉我。', Date.now(), () => true, makeRoute()).catch(error => ({error: String(error)}));
    c.recorder.push('voice_route', {result: result2});
    c.check('第二条独立要求被受理', !(result2 as any).error, (result2 as any).error);
    const queueDir = join(c.runtimeDir, 'receipts', 'requirements');

    const readJobs = async (): Promise<any[]> => {
      if (!existsSync(queueDir)) return [];

      return readdirSync(queueDir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(queueDir, f), 'utf8')));
    };

    await until(async () => { const jobs = await readJobs();

 return jobs.length >= 2 ? jobs : undefined; }, 90_000, '两个独立任务已登记');
    let jobs = await readJobs();
    c.check('两个独立要求都带各自文本与附件', jobs.length >= 2 && jobs.every(j => (j.request?.text ?? '').length > 0) && jobs.some(j => (j.request?.attachments ?? []).length > 0),
      jobs.map(j => ({id: j.request.conversationId, text: (j.request.text ?? '').slice(0, 40), att: (j.request.attachments ?? []).length})));
    const queuedJobs = jobs.filter(j => j.state === 'queued');
    c.check('有未启动的待办（两个运行、一个未启动）', jobs.filter(j => ['starting', 'running'].includes(j.state)).length >= 1 && queuedJobs.length >= 1,
      jobs.map(j => ({id: j.request.conversationId, state: j.state})));
    c.stateExtra.queueBeforeRestart = jobs;
    const suspendedJob = queuedJobs[0]!;
    const suspendedId: string = suspendedJob.request.conversationId;
    const suspendedText: string = suspendedJob.request.text;
    await c.restartHost();
    await sleep(1500);
    jobs = await readJobs();
    const suspended = jobs.find(j => j.request.conversationId === suspendedId);
    c.check('重启后未启动项转为 suspended', suspended?.state === 'suspended', suspended?.state);
    c.check('未启动项原要求完整保留', (suspended?.request?.text ?? '').includes((suspendedText ?? '').slice(0, 10)), suspended?.request?.text);
    c.check('未启动项附件保留', (suspended?.request?.attachments ?? []).length >= 1, (suspended?.request?.attachments ?? []).length);
    c.stateExtra.queueAfterRestart = jobs;
    const markRestart = c.recorder.events.length;
    await sleep(5000);
    const autoStarted = c.eventsSince(markRestart).filter(e => e.kind === 'server_msg' && (e as any).msg?.type === 'agent_event' && (e as any).msg.event?.kind === 'agent_start' && (e as any).msg.conversationId === suspendedId);
    c.check('重启后未启动项没有自动开始', autoStarted.length === 0, autoStarted.length);
    // 用户明确重新安排这一项
    await c.activateUrl(otherUrl);

    const receipt = await c.host!.manager.dispatchTaskAction({
      requestId: randomUUID(), conversationId: suspendedId, source: 'voice', action: 'resume',
      expectedRunId: null, context: {tabId, title: '另一张表单', url: otherUrl},
    } as any);

    c.recorder.push('queue_resume_receipt', {receipt});
    c.check('明确继续后待办重新排队', receipt?.status === 'queued' || receipt?.status === 'accepted', receipt);
    const finding = await c.waitFinding(suspendedId, 300_000).catch(() => undefined);
    const jobProgress = await c.progress(suspendedId);
    c.check('未启动项按原要求执行并交付', !!finding, finding?.text?.slice(0, 120));
    c.check('恢复后的要求仍含原文', (jobProgress?.recoveryInput?.requirements ?? []).join('\n').includes((suspendedText ?? '').slice(0, 10)), jobProgress?.recoveryInput?.requirements);
    c.check('恢复后的附件键保留', (jobProgress?.recoveryInput?.attachmentKeys ?? []).length >= 1, jobProgress?.recoveryInput?.attachmentKeys);
    barrier.release();
    await c.waitIdle('default', 120_000).catch(() => undefined);

    for (const job of await readJobs()) await c.waitIdle(job.request.conversationId, 30_000).catch(() => undefined);
    const state = await c.fixtureState();
    c.check('三个只读任务全程零写入', state.sideEffects === 0, state);
    c.runIds.before = null;
    c.runIds.after = (await c.progress(suspendedId))?.runId ?? null;
    c.snapshotProgress('suspended-job', suspendedId);
    await c.screenshotState(research, 'queue-recovery.png');
  },

  async 'aged-checkpoint'(c) {
    const form = await c.openPage('/form');
    const formUrl = c.fixture!.origin + '/form';
    await armCheckpoint(c, '读取当前测试账户：如果是 A 就把测试姓名填「测试庚」；如果是 B 就填「测试辛」。只填姓名，不要保存。',
      async cc => (((await cc.pageValue(form, '#name')) ?? '').length > 0) || cc.toolStarts().length > 0, '任务已有页面动作');
    const aged = await ageCheckpoint(c, 'default', 26 * 3600 * 1000);
    c.check('检查点条目时间戳已改为 26 小时前（模拟老化）', aged >= 1, aged);
    c.note('时间老化是模拟：直接改写隔离会话文件中检查点条目的 timestamp，不是真实隔夜运行');
    await c.fixturePost('/api/account', {account: 'B'});
    const tabId = await c.activateUrl(formUrl);
    await c.iso!.swEval(`chrome.tabs.reload(${tabId})`).catch(() => {});
    await until(async () => ((await c.pageValue(form, '#account')) === 'B') || undefined, 20_000, '页面已变化（账户 B）');
    const mark = c.recorder.events.length;
    await c.resume();
    await until(() => c.eventsSince(mark).some(e => e.kind === 'server_msg' && (e as any).msg?.type === 'agent_event' && (e as any).msg.event?.kind === 'tool_start' && (e as any).msg.event?.name === 'snapshot') || undefined, 150_000, '恢复重新读取页面');
    // 预期：不把旧页面状态当当前事实。恢复后既可能按账户 B 完成填写，也可能因未决写入保持只读并如实报告当前事实。
    const filled = await until(async () => ((await c.pageValue(form, '#name')) === '测试辛') || undefined, 240_000, '按当前账户 B 填写').catch(() => undefined);
    await c.waitIdle('default', 90_000).catch(() => undefined);
    const agedDelivery = String(c.deliveries('default').at(-1)?.text ?? '');
    const sawCurrentAccount = /账户\s*\**B|当前.*B/i.test(agedDelivery);
    const claimedStale = /账户\s*\**A[a-zA-Z]?\s*[，。]/.test(agedDelivery);

    if (filled) c.check('恢复后按当前页面（账户 B）填写而不是旧读数', true, '测试辛');
    else c.check('恢复后如实报告当前页面事实（账户 B、未据旧读数写入）', sawCurrentAccount && !claimedStale, agedDelivery.slice(0, 200));
    c.runIds.after = (await c.progress())?.runId ?? null;
    const state = await c.fixtureState();
    c.check('恢复后没有保存（副作用为零）', state.sideEffects === 0, state);
    c.check('检查点老化后仍沿用原任务身份', c.runIds.after === c.runIds.before, {before: c.runIds.before, after: c.runIds.after});
    c.snapshotProgress('after-aged-resume');
    await c.screenshotState(form, 'aged-checkpoint.png');
  },

  async 'attachments-corrections'(c) {
    const formUrl = c.fixture!.origin + '/form';
    // 无关历史任务：在 default 会话完成
    await c.openPage('/research');
    await c.say('只读任务：读取当前页面标题，一句话告诉我，不要做别的。');
    const firstFinding = await c.waitFinding('default', 180_000).catch(() => undefined);
    c.check('无关历史任务先完成', !!firstFinding, firstFinding?.text?.slice(0, 80));
    await c.waitIdle('default', 60_000).catch(() => undefined);
    const otherRun = (await c.progress('default'))?.runId;
    const otherMarks = c.recorder.events.length;
    // 新会话：图片任务
    const cid = await c.newConversation();
    const form = await c.openPage('/form');
    await c.activateUrl(formUrl);
    const image = await c.makeTextImage('测试姓名：测试己', 'original-name.png');
    await c.panelAttachFile(image);
    c.check('附件已进入面板', await c.iso!.evalIn(c.panelTarget!, `!document.querySelector('#attachments-strip').hidden`));
    await c.say('按照我附上的图片，把表单里的测试姓名填上；方案先不要选，也不要保存。');
    await c.waitProgress(cid, p => p.state === 'running', 90_000, '图片任务开始运行');
    c.runIds.before = (await c.progress(cid))?.runId ?? null;
    await until(async () => ((((await c.pageValue(form, '#name')) ?? '').length > 0) || c.toolStarts('fill').length + c.toolStarts('type_text').length > 0) || undefined, 180_000, '任务已开始填写或读取');
    await c.restartHost();
    const p1 = await c.progress(cid);
    c.check('重启后保留图片任务检查点', p1?.state === 'interrupted' && p1?.runId === c.runIds.before, {state: p1?.state, runId: p1?.runId});
    await c.voiceInput('补充修改：方案改成「远山」，其余不变，仍然不要保存。', cid);

    const p2 = await until(async () => {
      const p = await c.progress(cid);

      return p && p.runId === c.runIds.before && (p.recoveryInput?.requirements?.length ?? 0) >= 2 ? p : undefined;
    }, 90_000, '修订已累积到原任务').catch(() => undefined);

    c.check('修订保存到原任务（runId 不变、要求累积）', !!p2, (await c.progress(cid))?.recoveryInput);
    c.check('原图附件键仍在任务里', (p2?.recoveryInput?.attachmentKeys ?? []).length >= 1, p2?.recoveryInput?.attachmentKeys);
    await c.activateUrl(formUrl);
    const mark = c.recorder.events.length;
    await c.resume('继续原任务', cid);
    await until(() => c.eventsSince(mark).some(e => e.kind === 'server_msg' && (e as any).msg?.type === 'agent_event' && (e as any).msg.event?.kind === 'tool_start' && (e as any).msg.event?.name === 'snapshot') || undefined, 150_000, '恢复重新读取页面');
    const resumeError = c.eventsSince(mark).find(e => e.kind === 'server_msg' && (e as any).msg?.type === 'agent_event' && (e as any).msg.event?.kind === 'error' && /附件尚未恢复/.test(String((e as any).msg.event?.message ?? '')));
    c.check('恢复没有因附件缺失失败关闭', !resumeError, resumeError ? String((resumeError as any).msg.event.message) : undefined);
    await until(async () => ((await c.pageValue(form, '#name')) === '测试己') || undefined, 240_000, '按原图填写姓名').catch(() => undefined);
    await c.waitIdle(cid, 120_000).catch(() => undefined);
    const name = await c.pageValue(form, '#name');
    const choice = await c.pageValue(form, '#choice');
    c.check('按原图填写的姓名保留', name === '测试己', name);
    c.check('按补充修订选择远山', choice === 'c', choice);
    const state = await c.fixtureState();
    c.check('始终没有保存', state.sideEffects === 0, state);
    c.runIds.after = (await c.progress(cid))?.runId ?? null;
    c.check('图片任务全程沿用原身份', c.runIds.after === c.runIds.before, {before: c.runIds.before, after: c.runIds.after});
    const otherProgress = await c.progress('default');
    const otherEvents = c.eventsSince(otherMarks).filter(e => e.kind === 'server_msg' && (e as any).msg?.type === 'agent_event' && (e as any).msg.conversationId === 'default' && ['agent_start', 'tool_start'].includes((e as any).msg.event?.kind));
    c.check('无关历史任务没有复活（无新执行）', otherEvents.length === 0 && otherProgress?.runId === otherRun, {events: otherEvents.length, runId: otherProgress?.runId, before: otherRun});
    c.stateExtra.sessionResume = await sessionResumeEvidence(c, cid);
    await c.screenshotState(form, 'attachments-corrections.png');
  },
};

// ── 故障变体：最新检查点损坏 ────────────────────────────────────────

/** 变体：最新检查点条目损坏时的真实行为（面板提示、阻止执行、原文件与其他会话）。 */
async function corruptCheckpoint(c: Case): Promise<void> {
  const form = await c.openPage('/form');
  await c.say('把测试姓名填成「测试壬」，方案选「青松」，先不要保存；填好后把表单当前内容读一遍告诉我。');
  await c.waitProgress('default', p => p.state === 'running', 90_000, '任务开始运行');
  c.runIds.before = (await c.progress())?.runId ?? null;
  await until(async () => (((await c.pageValue(form, '#name')) ?? '').length > 0) || c.toolStarts().length > 0 || undefined, 180_000, '任务已有页面动作');
  await c.restartHost();
  const baseline = await c.progress();
  c.check('损坏前基线：重启后仍是原 runId 的中断检查点', baseline?.state === 'interrupted' && baseline?.runId === c.runIds.before, {state: baseline?.state, runId: baseline?.runId});
  const pointer = join(c.runtimeDir, 'conversations', 'default', 'session-path.txt');
  const file = (await readFile(pointer, 'utf8')).trim();
  const beforeBytes = await readFile(file, 'utf8');
  // 必须在宿主已经停下时注入：生产 disconnect 会再写一条有效检查点，先写会被顶掉。
  const hellosBefore = c.host!.hellos;
  await c.host!.stop();
  SessionManager.open(file).appendCustomEntry('sideagent-task-results-v1', {private_checkpoint_fixture: 'corrupt-latest'});
  const corruptBytes = await readFile(file, 'utf8');
  c.check('最新条目已注入损坏（原有字节保留）', corruptBytes.startsWith(beforeBytes) && corruptBytes !== beforeBytes);
  c.note('注入：在隔离会话文件末尾追加一条无效的 sideagent-task-results-v1（最新条目损坏；宿主已停）');
  await c.host!.restart();
  let reconnected = await c.waitHostHellos(hellosBefore + 1, 12_000);

  if (!reconnected) { await c.forceReconnect(); reconnected = await c.waitHostHellos(hellosBefore + 1, 20_000); }

  c.check('损坏后扩展重连到新宿主', reconnected);
  await sleep(800);
  const entry = c.host!.manager.get('default');
  c.check('损坏后会话明确标记为不可恢复（不是当作没有检查点）', entry?.summary.checkpoint === 'unavailable', entry?.summary);
  const blockedProgress = await c.progress();
  // 验收要求是“不静默当作没有检查点、不回退到旧账本”：允许 error 占位，但不得出现原 runId/目标/结果，也不得假装 interrupted/running。
  const noOldData = blockedProgress === null || ((blockedProgress.runId ?? null) === null && (blockedProgress.results ?? []).length === 0 && !['running', 'interrupted'].includes(blockedProgress.state));
  c.check('损坏后没有伪造空白进度或回退到旧账本（无原 runId/结果）', noOldData, blockedProgress);
  const panel = await c.panelText();
  c.check('面板显示检查点无法恢复（不静默）', panel.includes('原任务检查点无法恢复'), panel.slice(-400));
  const mark = c.recorder.events.length;
  await c.say('继续原任务').catch(() => {});
  await sleep(1500);
  const refusedContinue = c.eventsSince(mark).find(e => e.kind === 'server_msg' && (e as any).msg?.type === 'agent_event' && ['error', 'notice'].includes((e as any).msg.event?.kind) && String((e as any).msg.event?.message ?? '').includes('原任务检查点无法恢复'));
  c.check('文字“继续原任务”被明确拒绝且保留原任务记录', !!refusedContinue, refusedContinue ? String((refusedContinue as any).msg.event.message).slice(0, 120) : undefined);
  await c.say('另外做个新任务：读取当前页面标题。').catch(() => {});
  await sleep(1500);
  const startedHere = c.eventsSince(mark).some(e => e.kind === 'server_msg' && (e as any).msg?.type === 'agent_event' && (e as any).msg.event?.kind === 'agent_start');
  c.check('该会话的新任务也被阻止（未启动模型）', !startedHere);
  const fileAfterAttempts = await readFile(file, 'utf8');
  c.check('原 Pi 文件未被覆盖或清空', fileAfterAttempts === corruptBytes);
  await c.restartHost();
  await sleep(800);
  const replayed = c.eventsSince(mark).some(e => e.kind === 'server_msg' && (e as any).msg?.type === 'agent_event' && (e as any).msg.event?.kind === 'error' && String((e as any).msg.event?.message ?? '').includes('原任务检查点无法恢复'));
  c.check('重连后再次提示恢复失败', replayed);
  c.check('重连后原文件仍未变化', (await readFile(file, 'utf8')) === corruptBytes);
  const cid = await c.newConversation();
  await c.say('只读任务：读取当前页面标题，一句话告诉我，不要做别的。');
  const finding = await c.waitFinding(cid, 180_000).catch(() => undefined);
  c.check('其他新会话仍可创建并正常执行', !!finding, finding?.text?.slice(0, 100));
  const newRunId = (await c.progress(cid))?.runId ?? null;
  c.check('新会话有自己的任务身份', !!newRunId && newRunId !== c.runIds.before, {after: newRunId, before: c.runIds.before});
  // 报告契约按宿主重启场景校验 preserveRun：受损会话的原身份未被新任务替换（summary 仍保留原 runId）。
  c.runIds.after = c.host!.manager.get('default')?.summary.runId ?? null;
  c.check('受损会话身份未被新任务替换', c.runIds.after === c.runIds.before, {after: c.runIds.after, before: c.runIds.before});
  c.stateExtra.newConversationRunId = newRunId;
  c.stateExtra.checkpointCorruption = {file: relative(reportDir, file), bytesBefore: beforeBytes.length, bytesCorrupted: corruptBytes.length, bytesAfterAttempts: fileAfterAttempts.length, bytesAfterReconnect: (await readFile(file, 'utf8')).length};
  await c.screenshotState(form, 'corrupt-checkpoint.png');
}

/** 变体：恰好“已接收”回执后、模型首条输出前杀宿主；检查点必须在回执时已可恢复。 */
async function hostRestartAcceptKill(c: Case): Promise<void> {
  const form = await c.openPage('/form');
  const requestText = '把测试姓名填成「测试己」，方案选「青松」，保存一次。';
  const mark = c.recorder.events.length;
  await c.say(requestText);
  const accepted = await until(() => c.eventsSince(mark).find(event => event.kind === 'server_msg' && (event as any).msg?.type === 'agent_event' && (event as any).msg.event?.kind === 'notice' && (event as any).msg.event?.receipt?.action === 'start' && (event as any).msg.event.receipt.status === 'accepted') || undefined, 30_000, '“已接收”回执').catch(() => undefined);
  c.check('任务收到 accepted 回执', !!accepted, accepted ? String((accepted as any).msg.event.message).slice(0, 120) : undefined);
  const receipt = accepted ? (accepted as any).msg.event.receipt as {requestId: string; runId: string | null} : undefined;
  c.runIds.before = receipt?.runId ?? null;
  // 不等待模型首条输出或任何延迟：回执当下检查点就必须已经可恢复。
  c.check('回执时检查点已在 Pi 文件里（不等模型输出）', await checkpointDurable(c));
  const hellosBefore = c.host!.hellos;
  await c.host!.stop();
  await c.host!.restart();
  let connected = await c.waitHostHellos(hellosBefore + 1, 12_000);

  if (!connected) { await c.forceReconnect(); connected = await c.waitHostHellos(hellosBefore + 1, 20_000); }

  c.check('立即重启后扩展重连', connected);
  await sleep(500);
  const restored = await c.progress();
  c.check('重启后恢复原 runId 的中断检查点', restored?.state === 'interrupted' && restored?.runId === c.runIds.before, {state: restored?.state, runId: restored?.runId, expected: c.runIds.before});
  c.check('完整要求已恢复', (restored?.recoveryInput?.requirements ?? []).includes(requestText), restored?.recoveryInput?.requirements);
  const taskAction = c.eventsSince(mark).filter(event => event.kind === 'client_msg' && (event as any).msg?.type === 'task_action').map(event => (event as any).msg).at(-1);
  const runBeforeReplay = c.host!.manager.get('default')?.summary.runId ?? null;

  if (taskAction && receipt) {
    await c.resendPanelClient(taskAction);
    await sleep(1500);
    const replay = c.host!.manager.dispatcher.get('default', receipt.requestId);
    c.check('同编号重发返回原回执', replay?.status === 'accepted' && replay.runId === receipt.runId, replay);
  } else c.check('能取到面板实际发送的 task_action 与回执', false);
  c.check('重发没有换任务身份', (c.host!.manager.get('default')?.summary.runId ?? null) === runBeforeReplay, {after: c.host!.manager.get('default')?.summary.runId, before: runBeforeReplay});
  c.runIds.after = c.host!.manager.get('default')?.summary.runId ?? null;
  await c.screenshotState(form, 'accept-kill.png');
}

// ── 主流程 ───────────────────────────────────────────────────────────

async function collectState(c: Case): Promise<any> {
  const state: any = {case: c.id, fixture: null, activeUrl: undefined, tabs: [], panelText: undefined, ...c.stateExtra};

  try { if (c.fixture) state.fixture = await c.fixtureState(); } catch { /* 已关闭 */ }

  if (c.iso) {
    try {
      state.tabs = await c.iso.swEval(`(async()=>{const tabs=await chrome.tabs.query({});const out=[];for(const t of tabs){if(!/^https?:/.test(t.url??''))continue;let text='';let values={};try{const r=await chrome.scripting.executeScript({target:{tabId:t.id},func:()=>document.body.innerText});text=String(r?.[0]?.result??'');const v=await chrome.scripting.executeScript({target:{tabId:t.id},func:()=>{const out={};for(const el of document.querySelectorAll('input,select,textarea,output')){const key=el.id||el.name||el.tagName;out[key]=el.value??el.textContent;}return out;}});values=v?.[0]?.result??{};}catch(e){text='[read failed: '+String(e)+']';}out.push({url:t.url,title:t.title,text:text.slice(0,6000),values});}return out;})()`, 45_000);
    } catch (error) { state.tabsError = String(error); }

    try { state.activeUrl = await c.activeUrl(); } catch { /* 忽略 */ }

    try { state.panelText = (await c.panelText()).slice(0, 6000); } catch { /* 忽略 */ }
  }

  return state;
}

async function runCase(id: string): Promise<void> {
  const definition = manifest.cases.find(item => item.id === id);

  if (!definition) throw new Error(`未知场景：${id}`);

  const implementation = variant === 'corrupt-checkpoint' && id === 'host-restart' ? corruptCheckpoint
    : variant === 'accept-kill' && id === 'host-restart' ? hostRestartAcceptKill
    : CASES[id];

  if (!implementation) { console.log(`SKIP ${id}（尚未实现驱动）`);

 return; }

  const c = new Case(id, definition, variant ? `${id}-${variant}` : id);
  c.barrier = id === 'queue-recovery' ? createBarrier() : undefined;
  await mkdir(c.dir, {recursive: true});
  await mkdir(c.runtimeDir, {recursive: true});
  console.log(`CASE ${id} — ${definition.task}`);
  let infrastructureError: string | undefined;

  try {
    c.fixture = await startFixture();
    const customToolsExtra = id === 'queue-recovery' ? {customTools: [c.barrier!.tool]} : {};
    c.host = new Host({runtimeDir: c.runtimeDir, token: c.token, recorder: c.recorder, ...customToolsExtra});
    await c.host.start();
    c.iso = await launchIso({token: c.token});
    await c.openPanel();
    c.check('隔离扩展已连上宿主', await c.awaitHostConnected(), '面板通道触发重连后仍未建立连接');
    console.log(`  环境就绪 fixture=${c.fixture.origin} profile=${c.iso.profile}`);
    const stopWriteConsents = writeConsent === 'off' ? undefined : c.watchWriteConsents(writeConsent);

    try {
      await implementation(c);
    } finally {
      stopWriteConsents?.();
    }
  } catch (error) {
    infrastructureError = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
    c.check('场景执行未抛出意外错误', false, infrastructureError.split('\n')[0]);
    console.error(`  CASE ${id} 执行中断：${infrastructureError}`);
  }

  c.endedAt = nowIso();

  try {
    const fixtureSnapshot = await collectState(c).catch(error => ({error: String(error)}));

    if (c.metrics === null) {
      const fixture = (fixtureSnapshot as any).fixture;
      c.metrics = {
        expectedOutcome: !infrastructureError && c.checks.every(x => x.ok),
        sideEffects: fixture?.sideEffects ?? 0,
        duplicateWrites: fixture?.duplicateWrites ?? 0,
        wrongPageWrites: fixture?.wrongPageWrites ?? 0,
        recoveryFailures: c.recoveryFailures,
        userCorrections: c.userCorrections,
      };
    }

    const trace = {
      case: id, definition, variant: {resumeEntry, mode: variant || null}, model, startedAt: c.startedAt, endedAt: c.endedAt,
      modelCallDelta: modelCalls - c.modelCallsBefore,
      fixture: c.fixture ? {seed: c.fixture.seed, origin: c.fixture.origin} : null,
      runIds: c.runIds,
      checks: c.checks,
      events: c.recorder.events,
      infrastructureError: infrastructureError ?? null,
    };

    const traceEvidence = await writeEvidenceFile(c.dir, 'trace.json', trace);
    const stateEvidence = await writeEvidenceFile(c.dir, 'state.json', fixtureSnapshot);
    const failed = c.checks.filter(item => !item.ok);
    const status: 'PASS' | 'FAIL' = !infrastructureError && failed.length === 0 && c.metrics.expectedOutcome === true ? 'PASS' : 'FAIL';
    const record = report.cases.find((item: any) => item.id === id);

    if (!record) throw new Error(`报告缺少场景 ${id}`);
    Object.assign(record, {
      status,
      startedAt: c.startedAt,
      endedAt: c.endedAt,
      beforeRunId: (c.runIds.before as string | null) ?? null,
      afterRunId: (c.runIds.after as string | null) ?? null,
      metrics: c.metrics,
      evidence: [traceEvidence, stateEvidence],
      notes: [
        resumeEntry === 'text' ? '恢复入口变体：真实侧栏输入框 Enter（面板 task_action/start）' : '',
        variant ? `故障变体：${variant}` : '',
        infrastructureError ? `infrastructure: ${infrastructureError.split('\n')[0]}` : '',
        ...failed.map(f => `未通过：${f.name}${f.detail ? `（${f.detail.slice(0, 200)}）` : ''}`),
      ].filter(Boolean).join('；'),
    });
    report.environment = {isolated: true, headless: true, realModelUsed: true, model};
    const staged = `${reportFile}.${process.pid}.tmp`;
    await writeFile(staged, JSON.stringify(report, null, 2) + '\n');
    await rename(staged, reportFile);
    console.log(`  ${status} ${id}${resumeEntry === 'text' ? '（文字入口）' : ''}${variant ? `（${variant}）` : ''}（模型调用 +${modelCalls - c.modelCallsBefore}，检查 ${c.checks.filter(x => x.ok).length}/${c.checks.length}，副作用 ${c.metrics.sideEffects}/${definition.maxSideEffects}）`);
  } finally {
    // 收尾：关闭浏览器/宿主/站点
    await c.iso?.close().catch(() => {});

    try { await c.host?.stop(); } catch { /* 忽略 */ }

    await c.fixture?.close().catch(() => {});
  }
}

async function main(): Promise<void> {
  const order = manifest.cases.map(item => item.id);
  const selected = casesWanted.length ? order.filter(id => casesWanted.includes(id)) : order;

  if (!selected.length) throw new Error('没有匹配的场景');

  for (const id of selected) {
    try { await runCase(id); }
    catch (error) { console.error(`CASE ${id} 驱动失败：${error instanceof Error ? error.stack : error}`); }
  }

  const calls = modelCalls;
  const cost = Math.round(calls * 0.04 * 100) / 100;

  if (calls > 0) {
    try { recordSpend({model_calls: calls, cost, note: `p0-local-agent ${selected.join(',')}`}); }
    catch (error) { console.error(`预算记录失败：${String(error)}`); }
  }

  console.log(JSON.stringify({done: selected, modelCalls: calls, estimatedCostUsd: cost}));
  process.exit(0);
}

await main();
