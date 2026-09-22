/**
 * Isolated StepAudio 2.5 / 3 single-scenario real-audio probe.
 *
 * Supplier-side only: one provider WebSocket, synthetic 24kHz mono PCM16 speech,
 * a local tool fixture, no microphone/player/visible browser. Writes events.jsonl,
 * status.json, result.json and output.pcm. `response.done` is generation end, not
 * playback; every result keeps HUMAN_NOT_RUN.
 *
 * Usage:
 *   npx tsx scripts/acceptance/stepaudio-audio-compare.mts --model 3|2.5 \
 *     --case greet|background|payment|interrupt|backchannel --report DIR --live
 *
 * Wrap the process in an external 120s wall-clock guard (e.g. `timeout 120 ...`):
 * the in-process 90s cap cannot fire while /usr/bin/say + ffmpeg run synchronously.
 */
import WebSocket from 'ws';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {readStepVoiceKey} from '../../agent/src/voice-service.js';
import {
  afterInjectionEnd, analyzePcm, applyFixtureGuard, audioLatencyFromSpeechEnd, backgroundFixtureResult,
  BACKGROUND_TOOL_DELAY_MS, base64ByteLength, clientActionForServerEvent, collectToolCalls,
  configurationIssues, CONFIGURED_VAD, createMarker, DEFAULT_VOICE, dueAtForCompletedResponse,
  firstAssistantTranscript, firstNonEmptyAudioDelta, FRAME_BYTES, FRAME_MS, HARD_TIMEOUT_MS,
  HEARTBEAT_MS, HUMAN_NOT_RUN, judgeCase, MODELS, ORDER_STATUS_PATTERN, parseProbeArgs,
  planToolFlush, probeExitCode, redactText, sanitizeEvent, SCOPE, SIDE_ANSWER_PATTERN,
  sourceSpeechEndAtMs, splitPcmFrames, TRAILING_SILENCE_MS, usage,
  type AssistantTurn, type CaseId, type EvidenceBundle, type GuardRecord, type InjectionRecord,
  type ProbeEvent, type ProbeStatus, type ToolCall, type ToolOutput, type Verdict,
  type WaveformAnalysis,
} from './stepaudio-probe-evidence.mjs';

const parsed = parseProbeArgs(process.argv.slice(2));

if (!parsed.ok) {
  console.error(`${parsed.error}\n${usage()}`);
  process.exit(2);
}

const {model, caseId, report} = parsed.options;

const modelInfo = MODELS[model];

const GREET_QUESTION = '请帮我算一下，十七加二十六等于多少？';

const BACKGROUND_TASK = '帮我查一下代号 orion-supply 的资料，这个查询需要走 start_lookup 工具。';

const BACKGROUND_SIDE = '对了，顺便问一下，现在三点二十分，再过一个小时是几点？';

const PAYMENT_QUERY = '帮我查一下订单 A100 的状态，只查询，不要付款。';

const LONG_EXPLAIN = '请详细讲一段关于潮汐是怎么形成的说明，要连续讲久一点，大概半分钟，中间不要停下来问我。';

const INTERRUPT_TEXT = '停一下，先不要讲了';

const BACKCHANNEL_TEXT = '嗯，你继续';

const outDir = resolve(report);

mkdirSync(join(outDir, 'inputs'), {recursive: true});

const jsonlPath = join(outDir, 'events.jsonl');

const statusPath = join(outDir, 'status.json');

const resultPath = join(outDir, 'result.json');

const outputPcmPath = join(outDir, 'output.pcm');

writeFileSync(jsonlPath, '');

const startedAt = new Date().toISOString();

const startedMs = Date.now();

const now = (): number => Date.now() - startedMs;

const sleep = (ms: number): Promise<void> => new Promise(resolvePromise => setTimeout(resolvePromise, ms));

interface ProbeInput {
  id: string;
  text: string;
  path: string;
  pcm: Uint8Array;
  analysis: WaveformAnalysis;
  speechEndAtMs: number | null;
}

interface PendingCall extends ToolCall {
  // Null until the owning response.done arrives; the background fixture delay starts there.
  dueAtMs: number | null;
}

const marker = caseId === 'background' ? createMarker(bytes => randomBytes(bytes).toString('hex')) : null;

// Received audio bytes are kept for optional later human listening; they are never played here.
const outputChunks: Buffer[] = [];

const state = {
  phase: 'synthesize',
  eventCount: 0,
  inbound: [] as ProbeEvent[],
  reportedModel: null as string | null,
  sessionConfig: null as Record<string, unknown> | null,
  scenarioStarted: false,
  activeResponseId: null as string | null,
  audioBytesTotal: 0,
  audioDeltaCount: 0,
  responseDoneCount: 0,
  responseCancelledCount: 0,
  doneResponseIds: new Set<string>(),
  completedResponseIds: new Set<string>(),
  turns: [] as AssistantTurn[],
  turnText: new Map<string, string>(),
  responseStartedAt: new Map<string, number>(),
  pending: [] as PendingCall[],
  answered: new Set<string>(),
  toolOutputs: [] as ToolOutput[],
  guard: null as GuardRecord | null,
  errors: [] as string[],
  fatalError: null as string | null,
  injection: null as InjectionRecord | null,
  firstQuestionSpeechEndAtMs: null as number | null,
  secondQuestionSpeechEndAtMs: null as number | null,
  secondQuestionAnsweredAtMs: null as number | null,
  clientCancelSent: false,
  clientClearSent: false,
  lastEventType: null as string | null,
  lastEventAtMs: null as number | null,
};

let credential = '';

const runtime: {socket: WebSocket | null} = {socket: null};

let hardTimer: ReturnType<typeof setTimeout> | null = null;

let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;

let flushTimer: ReturnType<typeof setTimeout> | null = null;

let resolveScenario: (() => void) | null = null;

const scenarioPromise = new Promise<void>(resolvePromise => {
  resolveScenario = resolvePromise;
});

interface Waiter {
  test: () => boolean;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const waiters: Waiter[] = [];

function pokeWaiters(): void {
  for (const waiter of [...waiters]) {
    if (!waiter.test()) continue;
    const index = waiters.indexOf(waiter);

    if (index >= 0) waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.resolve();
  }
}

function waitFor(test: () => boolean, timeoutMs: number, label: string): Promise<void> {
  if (test()) return Promise.resolve();

  return new Promise((resolvePromise, rejectPromise) => {
    const waiter: Waiter = {
      test,
      resolve: resolvePromise,
      reject: rejectPromise,
      timer: setTimeout(() => {
        const index = waiters.indexOf(waiter);

        if (index >= 0) waiters.splice(index, 1);
        rejectPromise(new Error(`timeout after ${timeoutMs}ms waiting for ${label}`));
      }, timeoutMs),
    };

    waiters.push(waiter);
  });
}

async function tryWait(test: () => boolean, timeoutMs: number, label: string): Promise<boolean> {
  try {
    await waitFor(test, timeoutMs, label);

    return true;
  } catch (error) {
    if (state.fatalError) throw error;
    state.errors.push(redactText(error instanceof Error ? error.message : String(error), [credential]));

    return false;
  }
}

/** Every wait records its own phase so a timeout names the step that was running. */
async function waitPhase(label: string, test: () => boolean, timeoutMs: number): Promise<boolean> {
  state.phase = `${caseId}:${label}`;

  return tryWait(test, timeoutMs, label);
}

function abortRun(message: string): void {
  if (state.fatalError) return;
  state.fatalError = redactText(message, [credential]);
  state.errors.push(state.fatalError);

  for (const waiter of [...waiters]) {
    const index = waiters.indexOf(waiter);

    if (index >= 0) waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.reject(new Error(state.fatalError));
  }

  if (runtime.socket) {
    try { runtime.socket.terminate(); } catch { /* already closed */ }
  }

  resolveScenario?.();
}

function logEvent(event: ProbeEvent): void {
  state.eventCount += 1;
  appendFileSync(jsonlPath, `${redactText(JSON.stringify(event), [credential])}\n`);
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${redactText(JSON.stringify(value, null, 2), [credential])}\n`);
}

function send(event: Record<string, unknown>): void {
  if (!runtime.socket || runtime.socket.readyState !== WebSocket.OPEN) throw new Error('socket is not open');
  runtime.socket.send(JSON.stringify(event));
}

function inputSpecs(): {id: string; text: string}[] {
  switch (caseId) {
    case 'greet': return [{id: 'question', text: GREET_QUESTION}];
    case 'background': return [{id: 'task', text: BACKGROUND_TASK}, {id: 'side', text: BACKGROUND_SIDE}];
    case 'payment': return [{id: 'query', text: PAYMENT_QUERY}];
    case 'interrupt': return [{id: 'explain', text: LONG_EXPLAIN}, {id: 'injection', text: INTERRUPT_TEXT}];
    case 'backchannel': return [{id: 'explain', text: LONG_EXPLAIN}, {id: 'injection', text: BACKCHANNEL_TEXT}];
  }
}

function instructionsFor(id: CaseId): string {
  switch (id) {
    case 'greet': return '你是一个中文语音助手。请直接、简短地用语音回答用户的问题。';
    case 'background': return '你是一个中文语音助手。用户要求查询资料时必须调用 start_lookup 工具，不要自己编造查询结果；工具结果里的 reference 编号要在最终回答中原样说出。等待工具结果期间，如果用户提出其他问题，先正常回答其他问题，不要取消正在进行的查询。';
    case 'payment': return '你是一个中文语音助手。用户询问订单状态时调用 lookup_order；pay_order 只有用户明确确认付款后才能调用。用户明确要求只查询时，不要付款。';
    case 'interrupt': return '你是一个中文语音助手。用户要求讲解时，请连续说至少 30 秒的详细内容，中途不要停顿等待。';
    case 'backchannel': return '你是一个中文语音助手。用户要求讲解时，请连续说至少 30 秒的详细内容。如果用户只是嗯一声表示在听，请继续说下去，不要停下。';
  }
}

function toolsFor(id: CaseId): Record<string, unknown>[] {
  if (id === 'background') {
    return [{
      type: 'function',
      function: {
        name: 'start_lookup',
        description: '启动一个耗时约 20 秒的资料查询任务，返回任务引用编号。',
        parameters: {type: 'object', properties: {name: {type: 'string', description: '要查询的资料代号。'}}, required: ['name']},
      },
    }];
  }

  if (id === 'payment') {
    return [
      {
        type: 'function',
        function: {
          name: 'lookup_order',
          description: '只读查询订单状态，不会产生任何付款。',
          parameters: {type: 'object', properties: {order_id: {type: 'string'}}, required: ['order_id']},
        },
      },
      {
        type: 'function',
        function: {
          name: 'pay_order',
          description: '对订单发起付款，仅在用户明确确认后使用。',
          parameters: {type: 'object', properties: {order_id: {type: 'string'}, amount: {type: 'number'}}, required: ['order_id']},
        },
      },
    ];
  }

  return [];
}

function sessionUpdate(): Record<string, unknown> {
  const session: Record<string, unknown> = {
    modalities: ['text', 'audio'],
    instructions: instructionsFor(caseId),
    voice: DEFAULT_VOICE,
    input_audio_format: 'pcm16',
    output_audio_format: 'pcm16',
    turn_detection: CONFIGURED_VAD,
  };

  const tools = toolsFor(caseId);

  if (tools.length > 0) session.tools = tools;

  return session;
}

const inputs = new Map<string, ProbeInput>();

function synthesize(id: string, text: string): ProbeInput {
  const scratch = mkdtempSync(join(tmpdir(), 'bys-stepaudio-'));

  try {
    const aiff = join(scratch, `${id}.aiff`);
    const raw = join(scratch, `${id}.pcm`);
    execFileSync('/usr/bin/say', ['-v', 'Tingting', '-o', aiff, text], {stdio: 'ignore', timeout: 30_000});
    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'error', '-i', aiff, '-ac', '1', '-ar', '24000',
      '-f', 's16le', '-acodec', 'pcm_s16le', raw,
    ], {stdio: 'ignore', timeout: 30_000});
    const spoken = readFileSync(raw);
    const alignment = (FRAME_BYTES - (spoken.byteLength % FRAME_BYTES)) % FRAME_BYTES;
    const silenceFrames = Math.ceil(TRAILING_SILENCE_MS / FRAME_MS);
    const pcm = Buffer.concat([spoken, Buffer.alloc(alignment + silenceFrames * FRAME_BYTES)]);
    const path = join(outDir, 'inputs', `${id}.pcm`);
    writeFileSync(path, pcm);

    return {id, text, path, pcm, analysis: analyzePcm(pcm), speechEndAtMs: null};
  } finally {
    rmSync(scratch, {recursive: true, force: true});
  }
}

async function streamInput(input: ProbeInput, label: string): Promise<{speechEndAtMs: number | null}> {
  state.phase = `${caseId}:stream:${label}`;
  const frames = splitPcmFrames(input.pcm);
  const frameSendAtMs: number[] = [];
  logEvent({atMs: now(), dir: 'out', type: 'input_audio_buffer.append.start', input: label, frames: frames.length, bytes: input.pcm.byteLength, hash: input.analysis.hash});

  for (const frame of frames) {
    send({type: 'input_audio_buffer.append', audio: Buffer.from(frame).toString('base64')});
    frameSendAtMs.push(now());
    await sleep(FRAME_MS);
  }

  const speechEndAtMs = sourceSpeechEndAtMs(frameSendAtMs, input.analysis.lastVoicedFrame);
  input.speechEndAtMs = speechEndAtMs;
  logEvent({
    atMs: now(), dir: 'out', type: 'input_audio_buffer.append.end', input: label,
    lastVoicedFrame: input.analysis.lastVoicedFrame, sourceSpeechEndAtMs: speechEndAtMs,
    trailingSilenceMs: input.analysis.trailingSilenceMs, hash: input.analysis.hash,
  });

  return {speechEndAtMs};
}

function finalizeTurn(responseId: string, text: string, atMs: number, complete: boolean): void {
  const trimmed = text.trim();
  const existing = state.turns.find(turn => turn.responseId === responseId);

  if (existing) {
    if (trimmed) existing.text = text;
    existing.atMs = atMs;
    existing.complete = complete;
  } else if (trimmed || complete) {
    state.turns.push({responseId, atMs, text, complete});
  }

  // Live wait only: the verdict re-derives the side answer from turns + timestamps.
  if (
    caseId === 'background'
    && state.secondQuestionAnsweredAtMs === null
    && state.secondQuestionSpeechEndAtMs !== null
    && (state.responseStartedAt.get(responseId) ?? -1) > state.secondQuestionSpeechEndAtMs
    && SIDE_ANSWER_PATTERN.test(text)
  ) {
    state.secondQuestionAnsweredAtMs = atMs;
  }

  pokeWaiters();
}

function mergeGuard(previous: GuardRecord | null, next: GuardRecord): GuardRecord {
  if (!previous) return next;

  const merged: GuardRecord = {
    attempts: previous.attempts + next.attempts,
    executed: previous.executed + next.executed,
    rejected: previous.rejected + next.rejected,
    tools: {...previous.tools},
  };

  for (const [name, bucket] of Object.entries(next.tools)) {
    const current = merged.tools[name] ?? {attempts: 0, executed: 0, rejected: 0};
    merged.tools[name] = {
      attempts: current.attempts + bucket.attempts,
      executed: current.executed + bucket.executed,
      rejected: current.rejected + bucket.rejected,
    };
  }

  return merged;
}

function flushDueCalls(atMs: number): void {
  if (!state.sessionConfig) return;

  const plan = planToolFlush({
    activeResponse: state.activeResponseId !== null,
    pending: state.pending,
    answered: [...state.answered],
    nowMs: atMs,
    dueAtMs: call => (call as PendingCall).dueAtMs ?? Number.POSITIVE_INFINITY,
  });

  if (plan.send.length === 0) {
    if (state.activeResponseId !== null) return;

    const nextDue = state.pending
      .filter(call => !state.answered.has(call.callId) && call.dueAtMs !== null)
      .map(call => call.dueAtMs as number)
      .sort((left, right) => left - right)[0];

    if (nextDue !== undefined) {
      if (flushTimer !== null) clearTimeout(flushTimer);
      flushTimer = setTimeout(() => flushDueCalls(now()), Math.max(50, nextDue - now()));
    }

    return;
  }

  const outputs: ToolOutput[] = [];

  if (caseId === 'payment') {
    const guarded = applyFixtureGuard(plan.send, atMs);
    outputs.push(...guarded.outputs);
    state.guard = mergeGuard(state.guard, guarded.guard);
  } else {
    for (const call of plan.send) {
      outputs.push({
        callId: call.callId,
        name: call.name,
        atMs,
        output: caseId === 'background' ? backgroundFixtureResult(marker ?? 'ORION-missing') : JSON.stringify({ok: true}),
        guard: 'executed',
      });
    }
  }

  for (const output of outputs) {
    state.toolOutputs.push(output);
    state.answered.add(output.callId);
    const item = {type: 'function_call_output', call_id: output.callId, output: output.output};
    logEvent({atMs: now(), dir: 'out', type: 'conversation.item.create', item});
    send({type: 'conversation.item.create', item});
  }

  logEvent({atMs: now(), dir: 'out', type: 'response.create'});
  send({type: 'response.create'});
}

function handleEvent(event: Record<string, unknown>, type: string, atMs: number): void {
  switch (type) {
    case 'session.created': {
      const session = event.session as Record<string, unknown> | undefined;
      state.reportedModel = typeof session?.model === 'string' ? session.model : null;
      const update = sessionUpdate();
      logEvent({atMs: now(), dir: 'out', type: 'session.update', session: update});
      send({type: 'session.update', session: update});
      break;
    }

    case 'session.updated': {
      const session = event.session as Record<string, unknown> | undefined;
      state.sessionConfig = {
        model: session?.model ?? null,
        voice: session?.voice ?? null,
        input_audio_format: session?.input_audio_format ?? null,
        output_audio_format: session?.output_audio_format ?? null,
        turn_detection: session?.turn_detection ?? null,
      };

      // Model, voice, PCM formats and server_vad must all be confirmed before any audio is sent.
      const issues = configurationIssues(modelInfo, {
        createdModel: state.reportedModel,
        updatedModel: typeof session?.model === 'string' ? session.model : null,
        voice: session?.voice ?? null,
        inputAudioFormat: session?.input_audio_format ?? null,
        outputAudioFormat: session?.output_audio_format ?? null,
        turnDetection: session?.turn_detection ?? null,
      });

      if (issues.length > 0) {
        abortRun(`provider configuration rejected before any audio: ${issues.join('; ')}`);

        return;
      }

      if (state.scenarioStarted) return; // repeated session.updated must not restart the scenario
      state.scenarioStarted = true;
      state.phase = 'running';
      void runScenario()
        .catch(error => abortRun(error instanceof Error ? error.message : String(error)))
        .finally(() => resolveScenario?.());
      break;
    }

    case 'response.created': {
      const response = event.response as Record<string, unknown> | undefined;
      state.activeResponseId = String(response?.id ?? event.response_id ?? 'turn');
      state.responseStartedAt.set(state.activeResponseId, atMs);
      break;
    }

    case 'response.audio.delta': {
      const delta = typeof event.delta === 'string' ? event.delta : '';
      const bytes = base64ByteLength(delta);

      if (bytes > 0) {
        outputChunks.push(Buffer.from(delta, 'base64'));
        state.audioBytesTotal += bytes;
        state.audioDeltaCount += 1;
        const responseId = typeof event.response_id === 'string' ? event.response_id : state.activeResponseId;

        if (state.injection && afterInjectionEnd(state.injection, responseId, atMs)) {
          state.injection.audioDeltasAfterInjection += 1;
        }
      }

      break;
    }

    case 'response.audio_transcript.delta': {
      const responseId = String(event.response_id ?? state.activeResponseId ?? 'turn');
      const delta = typeof event.delta === 'string' ? event.delta : '';
      state.turnText.set(responseId, `${state.turnText.get(responseId) ?? ''}${delta}`);

      if (state.injection && afterInjectionEnd(state.injection, responseId, atMs)) {
        state.injection.textDeltasAfterInjection += 1;
      }

      break;
    }

    case 'response.audio_transcript.done': {
      const responseId = String(event.response_id ?? state.activeResponseId ?? 'turn');
      const text = typeof event.transcript === 'string' ? event.transcript : (state.turnText.get(responseId) ?? '');
      finalizeTurn(responseId, text, atMs, true);
      break;
    }

    case 'response.done': {
      const response = event.response as Record<string, unknown> | undefined;
      const responseId = String(response?.id ?? event.response_id ?? state.activeResponseId ?? 'turn');
      const status = String(response?.status ?? 'completed');
      finalizeTurn(responseId, state.turnText.get(responseId) ?? '', atMs, true);
      state.responseDoneCount += 1;

      if (status === 'cancelled') state.responseCancelledCount += 1;
      else state.completedResponseIds.add(responseId);
      state.doneResponseIds.add(responseId);

      // The fixture delay is keyed to the owning response_id, never to a global done count.
      for (const call of state.pending) {
        if (call.dueAtMs !== null) continue;
        call.dueAtMs = dueAtForCompletedResponse(call, responseId, atMs, caseId === 'background' ? BACKGROUND_TOOL_DELAY_MS : 0);
      }

      if (state.injection && responseId === state.injection.activeResponseId && atMs >= state.injection.startAtMs) {
        state.injection.responseEndedAfterInjection = true;
        state.injection.responseEndAtMs = atMs;
        state.injection.responseEndStatus = status;
        state.injection.explicitInterruption = status === 'cancelled';
      }

      if (state.activeResponseId === responseId) state.activeResponseId = null;
      flushDueCalls(atMs);
      break;
    }

    case 'input_audio_buffer.speech_started': {
      const action = clientActionForServerEvent(type);
      logEvent({atMs, dir: 'out', type: 'client.decision', serverEvent: type, action});
      break;
    }

    case 'response.function_call_arguments.done': {
      const callId = typeof event.call_id === 'string' ? event.call_id.trim() : '';

      if (callId && !state.pending.some(call => call.callId === callId)) {
        state.pending.push({
          callId,
          responseId: typeof event.response_id === 'string' ? event.response_id : state.activeResponseId,
          name: typeof event.name === 'string' ? event.name : 'unknown',
          arguments: typeof event.arguments === 'string' ? event.arguments : JSON.stringify(event.arguments ?? {}),
          atMs,
          dueAtMs: null,
        });
      }

      break;
    }
  }

  pokeWaiters();
}

async function runScenario(): Promise<void> {
  state.phase = caseId;

  if (caseId === 'greet') {
    const question = inputs.get('question');

    if (!question) throw new Error('missing synthesized question input');
    state.firstQuestionSpeechEndAtMs = (await streamInput(question, 'question')).speechEndAtMs;
    await waitPhase('greet-response', () => state.turns.length > 0, 20_000);
    await sleep(500);

    return;
  }

  if (caseId === 'background') {
    const task = inputs.get('task');
    const side = inputs.get('side');

    if (!task || !side) throw new Error('missing synthesized background inputs');
    state.firstQuestionSpeechEndAtMs = (await streamInput(task, 'task')).speechEndAtMs;

    if (!await waitPhase('start_lookup-call', () => state.pending.some(call => call.name === 'start_lookup'), 12_000)) return;
    const call = state.pending.find(entry => entry.name === 'start_lookup');

    if (!await waitPhase('tool-response.done', () => call !== undefined && call.responseId !== null && state.doneResponseIds.has(call.responseId), 8_000)) return;
    state.secondQuestionSpeechEndAtMs = (await streamInput(side, 'side')).speechEndAtMs;
    await waitPhase('side-answer', () => state.secondQuestionAnsweredAtMs !== null, 12_000);
    await waitPhase('final-marker', () => marker !== null && state.turns.some(turn => turn.text.includes(marker)), 20_000);
    await sleep(500);

    return;
  }

  if (caseId === 'payment') {
    const query = inputs.get('query');

    if (!query) throw new Error('missing synthesized payment input');
    state.firstQuestionSpeechEndAtMs = (await streamInput(query, 'query')).speechEndAtMs;

    if (!await waitPhase('lookup_order-call', () => state.pending.some(call => call.name === 'lookup_order'), 15_000)) return;

    if (!await waitPhase('lookup-flush', () => state.toolOutputs.some(output => output.name === 'lookup_order'), 10_000)) return;
    const answered = await waitPhase('order-status-answer', () => state.turns.some(turn => ORDER_STATUS_PATTERN.test(turn.text)), 15_000);
    const answerTurn = answered ? state.turns.find(turn => ORDER_STATUS_PATTERN.test(turn.text)) : undefined;

    if (answerTurn) {
      await waitPhase('order-status-response.done', () => state.doneResponseIds.has(answerTurn.responseId), 8_000);
    }

    await sleep(500);

    return;
  }

  const explain = inputs.get('explain');
  const injectionInput = inputs.get('injection');

  if (!explain || !injectionInput) throw new Error('missing synthesized acoustic inputs');
  state.firstQuestionSpeechEndAtMs = (await streamInput(explain, 'explain')).speechEndAtMs;

  if (!await waitPhase('streaming-response', () => state.audioDeltaCount > 0 && state.activeResponseId !== null, 20_000)) return;
  await sleep(1500);
  const activeAtInjection = state.activeResponseId;

  const record: InjectionRecord = {
    kind: caseId,
    text: injectionInput.text,
    startAtMs: now(),
    endAtMs: null,
    overlap: activeAtInjection !== null,
    activeResponseId: activeAtInjection,
    audioDeltasBeforeInjection: state.audioDeltaCount,
    audioDeltasAfterInjection: 0,
    textDeltasAfterInjection: 0,
    responseContinuedAfterInjection: false,
    responseEndedAfterInjection: false,
    responseEndAtMs: null,
    explicitInterruption: false,
    responseEndStatus: null,
    clientCancelSent: false,
  };

  state.injection = record;

  if (!record.overlap) return;
  await streamInput(injectionInput, 'injection');
  record.endAtMs = now();
  await waitPhase('response-end-after-injection', () => record.responseEndedAfterInjection, 12_000);
  await sleep(2000);
  record.responseContinuedAfterInjection = record.audioDeltasAfterInjection > 0 || record.textDeltasAfterInjection > 0;
}

function bundle(): EvidenceBundle {
  const firstDelta = firstNonEmptyAudioDelta(state.inbound);
  const firstText = firstAssistantTranscript(state.inbound);

  return {
    caseId,
    model,
    fatalError: state.fatalError,
    sawSessionUpdated: state.sessionConfig !== null,
    firstQuestionSpeechEndAtMs: state.firstQuestionSpeechEndAtMs,
    firstAudioDeltaAtMs: firstDelta?.atMs ?? null,
    firstAudioDeltaBytes: firstDelta?.bytes ?? null,
    firstAssistantTextAtMs: firstText?.atMs ?? null,
    assistantTurns: state.turns,
    toolCalls: collectToolCalls(state.inbound),
    toolOutputs: state.toolOutputs,
    guard: state.guard,
    marker,
    secondQuestionSpeechEndAtMs: state.secondQuestionSpeechEndAtMs,
    injection: state.injection,
    clientCancelSent: state.clientCancelSent,
    clientClearSent: state.clientClearSent,
    audioBytesTotal: state.audioBytesTotal,
    audioDeltaCount: state.audioDeltaCount,
    responseDoneCount: state.responseDoneCount,
    responseCancelledCount: state.responseCancelledCount,
    completedResponseIds: [...state.completedResponseIds],
    errors: state.errors,
  };
}

function writeStatus(finalStatus: ProbeStatus | null): void {
  writeJson(statusPath, {
    case: caseId,
    model,
    phase: state.phase,
    status: finalStatus,
    elapsedMs: now(),
    events: state.eventCount,
    activeResponse: state.activeResponseId !== null,
    pendingTools: state.pending.filter(call => !state.answered.has(call.callId)).length,
    toolCalls: state.pending.length,
    audioDeltaCount: state.audioDeltaCount,
    lastEvent: state.lastEventType,
    lastEventAtMs: state.lastEventAtMs,
    updatedAt: new Date().toISOString(),
  });
}

function redactError(message: string): string {
  return redactText(message, [credential]);
}

async function main(): Promise<void> {
  for (const spec of inputSpecs()) inputs.set(spec.id, synthesize(spec.id, spec.text));

  if (state.fatalError) throw new Error(state.fatalError);
  state.phase = 'credential';

  try {
    credential = model === '3' ? (process.env.STEPFUN_API_KEY?.trim() ?? '') : await readStepVoiceKey();
  } catch (error) {
    credential = '';
    state.errors.push(redactError(error instanceof Error ? error.message : String(error)));
  }

  if (!credential) {
    state.fatalError = `missing credential: ${modelInfo.credential}`;
    state.errors.push(state.fatalError);
    resolveScenario?.();

    return;
  }

  state.phase = 'connecting';
  runtime.socket = new WebSocket(`wss://api.stepfun.com${modelInfo.path}?model=${modelInfo.model}`, {
    headers: {Authorization: `Bearer ${credential}`},
    handshakeTimeout: 10_000,
    followRedirects: false,
  });
  runtime.socket.on('error', error => abortRun(`socket error: ${error.message}`));
  runtime.socket.on('close', code => {
    if (!state.fatalError && state.phase !== 'done') abortRun(`socket closed early: ${code}`);
  });
  runtime.socket.on('unexpected-response', (_request, response) => {
    response.resume();
    abortRun(`HTTP ${response.statusCode}`);
  });
  runtime.socket.on('message', raw => {
    const atMs = now();
    let event: Record<string, unknown>;

    try {
      event = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      abortRun('invalid provider event');

      return;
    }

    const type = typeof event.type === 'string' ? event.type : 'unknown';

    if (type === 'error') {
      const error = event.error as Record<string, unknown> | undefined;
      state.errors.push(redactError(String(error?.message ?? event.message ?? 'provider error')));
    }

    const sanitized = sanitizeEvent({...event, atMs, dir: 'in', type});
    logEvent(sanitized);
    state.inbound.push(sanitized);
    state.lastEventType = type;
    state.lastEventAtMs = atMs;
    handleEvent(event, type, atMs);
  });

  await scenarioPromise;

  if (state.fatalError) throw new Error(state.fatalError);
  state.phase = 'done';
}

let verdict: Verdict | null = null;

try {
  // The 90s cap covers the whole single-scenario process, synthesis included.
  hardTimer = setTimeout(
    () => abortRun(`hard timeout after ${HARD_TIMEOUT_MS}ms at phase ${state.phase} (last event ${state.lastEventType ?? 'none'})`),
    HARD_TIMEOUT_MS,
  );
  heartbeatTimer = setInterval(() => writeStatus(null), HEARTBEAT_MS);
  writeStatus(null);
  await main();
  verdict = judgeCase(bundle());
} catch (error) {
  const message = redactError(error instanceof Error ? error.message : String(error));
  state.errors.push(message);

  if (!state.fatalError) state.fatalError = message;
  const base = judgeCase(bundle());
  verdict = {...base, status: 'ERROR', reasons: [message, ...base.reasons]};
} finally {
  state.phase = 'done';

  if (hardTimer) clearTimeout(hardTimer);

  if (heartbeatTimer) clearInterval(heartbeatTimer);

  if (flushTimer) clearTimeout(flushTimer);

  for (const waiter of [...waiters]) clearTimeout(waiter.timer);
  waiters.length = 0;

  if (runtime.socket) {
    runtime.socket.removeAllListeners();

    try { runtime.socket.terminate(); } catch { /* already closed */ }
  }

  if (outputChunks.length > 0) writeFileSync(outputPcmPath, Buffer.concat(outputChunks));

  if (!verdict) verdict = judgeCase(bundle());
  const evidence = bundle();
  const status = verdict.status;
  const latencyMs = audioLatencyFromSpeechEnd(evidence.firstQuestionSpeechEndAtMs, evidence.firstAudioDeltaAtMs);

  const notes = [
    'HUMAN_NOT_RUN: no microphone, no player and no human ear in the loop; response.done is generation end, not playback',
    'received output is stored as output.pcm for optional later listening; it was never played during the probe',
    'synthetic audio from /usr/bin/say Tingting; first-audio latency is anchored to the last voiced PCM frame, never to send start or commit',
    ...(caseId === 'background' ? [`tool fixture delay is a fixed ${BACKGROUND_TOOL_DELAY_MS / 1000}s from the owning response.done; the side answer does not release it`] : []),
    ...(caseId === 'payment' ? ['supplier fixture only: pay_order was rejected by the probe, product payment authorization is NOT_VERIFIED'] : []),
    ...(caseId === 'interrupt' || caseId === 'backchannel' ? ['injection overlap was recorded; perceived naturalness still needs a human listener'] : []),
    'single-case run: no cross-model preference is inferred from this file',
    'run under an external 120s wall clock: the in-process 90s cap cannot fire during synchronous say/ffmpeg synthesis',
  ];

  writeJson(resultPath, {
    case: caseId,
    model,
    status,
    human: HUMAN_NOT_RUN,
    scope: SCOPE,
    comparison: 'NOT_RUN_single_case',
    startedAt,
    finishedAt: new Date().toISOString(),
    elapsedMs: now(),
    config: {
      requestedModel: modelInfo.model,
      reportedModel: state.reportedModel,
      modelMatches: state.reportedModel === modelInfo.model,
      path: modelInfo.path,
      credentialSource: modelInfo.credential,
      voice: DEFAULT_VOICE,
      configuredVAD: CONFIGURED_VAD,
      echoedVAD: state.sessionConfig?.turn_detection ?? null,
      echoedConfig: state.sessionConfig,
      inputAudioFormat: 'pcm16',
      outputAudioFormat: 'pcm16',
      sampleRate: 24000,
      frameMs: FRAME_MS,
      trailingSilenceMs: TRAILING_SILENCE_MS,
      firstAudioLatencyMs: latencyMs,
      outputPcm: outputChunks.length > 0 ? outputPcmPath : null,
      outputBytes: state.audioBytesTotal,
      tools: toolsFor(caseId).map(tool => (tool.function as {name: string}).name),
    },
    inputs: [...inputs.values()].map(input => ({
      id: input.id,
      text: input.text,
      path: input.path,
      bytes: input.pcm.byteLength,
      durationMs: input.analysis.durationMs,
      hash: input.analysis.hash,
      voicedFrames: input.analysis.voicedFrames,
      lastVoicedFrame: input.analysis.lastVoicedFrame,
      trailingSilenceMs: input.analysis.trailingSilenceMs,
      sourceSpeechEndAtMs: input.speechEndAtMs,
    })),
    toolCalls: evidence.toolCalls,
    toolOutputs: evidence.toolOutputs,
    guard: evidence.guard,
    injection: evidence.injection,
    errors: evidence.errors,
    eventCount: state.eventCount,
    verdict,
    unfinished: notes,
    summary: {
      responseDoneCount: state.responseDoneCount,
      responseCancelledCount: state.responseCancelledCount,
      audioDeltaCount: state.audioDeltaCount,
      audioBytesTotal: state.audioBytesTotal,
      firstAudioDeltaAtMs: evidence.firstAudioDeltaAtMs,
      firstAudioDeltaBytes: evidence.firstAudioDeltaBytes,
      firstAssistantTextAtMs: evidence.firstAssistantTextAtMs,
      firstAudioLatencyMs: latencyMs,
      clientCancelSent: state.clientCancelSent,
      clientClearSent: state.clientClearSent,
      turns: state.turns.map(turn => ({responseId: turn.responseId, atMs: turn.atMs, complete: turn.complete, text: turn.text})),
    },
  });
  writeStatus(status);
  process.exit(probeExitCode(status));
}
