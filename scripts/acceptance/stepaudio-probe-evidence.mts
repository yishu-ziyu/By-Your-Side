/**
 * Pure evidence logic for the isolated StepAudio 2.5/3 real-audio comparison probe.
 *
 * No sockets, no subprocesses, no playback: provider events and waveform bytes become
 * byte counts, timings, hashes and conservative verdicts, so measurement and judgment
 * stay testable offline. Audio payloads, headers and credentials never enter evidence.
 */
import {createHash} from 'node:crypto';

const CASES = ['greet', 'background', 'payment', 'interrupt', 'backchannel'] as const;
export type CaseId = (typeof CASES)[number];
type ModelId = '3' | '2.5';
export type ProbeStatus = 'PASSED' | 'FAILED' | 'NOT_RUN' | 'ERROR';
type HumanJudgement = 'HUMAN_NOT_RUN';

export const HUMAN_NOT_RUN: HumanJudgement = 'HUMAN_NOT_RUN';

const SAMPLE_RATE = 24_000;
export const FRAME_MS = 20;
const BYTES_PER_SAMPLE = 2;
export const FRAME_BYTES = (SAMPLE_RATE * FRAME_MS * BYTES_PER_SAMPLE) / 1000; // 960
const VOICE_THRESHOLD = 250;
export const TRAILING_SILENCE_MS = 800;
export const HARD_TIMEOUT_MS = 90_000;
export const HEARTBEAT_MS = 2_000;
/** Delay is fixed before the run and starts at the tool response.done, never at side-answer time. */
export const BACKGROUND_TOOL_DELAY_MS = 20_000;
const GREET_EXPECTED = '43';
/** Standalone only: 143, 430, 43.5 and 一百四十三 are wrong answers, not matches. */
export const GREET_ANSWER_PATTERN = /(?<!\d)43(?!\d|\.\d)|(?<!百)四十三(?!点)/u;
export const SIDE_ANSWER_PATTERN = /四点二十|4\s*[:：点]\s*20|十六点二十|16\s*[:：点]\s*20/u;
export const ORDER_STATUS_PATTERN = /待发货/u;

interface ModelConfig {
  model: string;
  path: string;
  credential: 'STEPFUN_API_KEY' | 'readStepVoiceKey';
}

export const MODELS: Record<ModelId, ModelConfig> = {
  '3': {model: 'stepaudio-3-realtime-preview', path: '/v1/realtime', credential: 'STEPFUN_API_KEY'},
  '2.5': {model: 'stepaudio-2.5-realtime', path: '/step_plan/v1/realtime', credential: 'readStepVoiceKey'},
};

export const DEFAULT_VOICE = 'wenrounansheng';

interface VadConfig {
  type: 'server_vad';
  prefix_padding_ms: number;
  silence_duration_ms: number;
  energy_awakeness_threshold: number;
}

/** Explicit server VAD: the live services echo `null` as `{type: ""}`, so nothing relies on defaults. */
export const CONFIGURED_VAD: VadConfig = {
  type: 'server_vad',
  prefix_padding_ms: 500,
  silence_duration_ms: 300,
  energy_awakeness_threshold: 2500,
};

interface SessionEcho {
  createdModel: string | null;
  updatedModel: string | null;
  voice: unknown;
  inputAudioFormat: unknown;
  outputAudioFormat: unknown;
  turnDetection: unknown;
}

/** Everything that must be confirmed by the provider echo before any audio is streamed. */
export function configurationIssues(requested: ModelConfig, echo: SessionEcho): string[] {
  const issues: string[] = [];
  if (echo.createdModel !== requested.model) {
    issues.push(`session.created model ${echo.createdModel ?? 'missing'} != ${requested.model}`);
  }
  if (typeof echo.updatedModel === 'string' && echo.updatedModel.length > 0 && echo.updatedModel !== requested.model) {
    issues.push(`session.updated model ${echo.updatedModel} != ${requested.model}`);
  }
  if (echo.voice !== DEFAULT_VOICE) issues.push(`voice ${String(echo.voice ?? 'missing')} != ${DEFAULT_VOICE}`);
  if (echo.inputAudioFormat !== 'pcm16') issues.push(`input_audio_format ${String(echo.inputAudioFormat ?? 'missing')} != pcm16`);
  if (echo.outputAudioFormat !== 'pcm16') issues.push(`output_audio_format ${String(echo.outputAudioFormat ?? 'missing')} != pcm16`);
  const vadType = (echo.turnDetection as {type?: unknown} | null | undefined)?.type;
  if (vadType !== 'server_vad') issues.push(`turn_detection type ${String(vadType ?? 'missing')} != server_vad`);
  return issues;
}

export const SCOPE = {
  kind: 'provider-side-audio-compare',
  providerSide: true,
  syntheticInput: true,
  playback: 'none',
  humanAudio: HUMAN_NOT_RUN,
  paymentAuthorization: 'NOT_VERIFIED',
  productIntegration: 'NOT_RUN',
} as const;

export interface ProbeEvent {
  atMs: number;
  dir: 'in' | 'out';
  type: string;
  [key: string]: unknown;
}

// --- Waveform analysis ---

export function pcm16Samples(pcm: Uint8Array): Int16Array {
  const count = Math.floor(pcm.byteLength / BYTES_PER_SAMPLE);
  const samples = new Int16Array(count);
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let index = 0; index < count; index += 1) samples[index] = view.getInt16(index * 2, true);
  return samples;
}

export function splitPcmFrames(pcm: Uint8Array, frameBytes = FRAME_BYTES): Uint8Array[] {
  const frames: Uint8Array[] = [];
  for (let offset = 0; offset + frameBytes <= pcm.byteLength; offset += frameBytes) {
    frames.push(pcm.subarray(offset, offset + frameBytes));
  }
  return frames;
}

function framePeak(frame: Uint8Array): number {
  let peak = 0;
  for (const sample of pcm16Samples(frame)) peak = Math.max(peak, Math.abs(sample));
  return peak;
}

function pcmHash(pcm: Uint8Array): string {
  return createHash('sha256').update(pcm).digest('hex');
}

export interface WaveformAnalysis {
  bytes: number;
  durationMs: number;
  frames: number;
  voicedFrames: number;
  lastVoicedFrame: number;
  trailingSilenceMs: number;
  hash: string;
}

export function analyzePcm(pcm: Uint8Array, frameBytes = FRAME_BYTES, threshold = VOICE_THRESHOLD): WaveformAnalysis {
  const frames = splitPcmFrames(pcm, frameBytes);
  let voicedFrames = 0;
  let lastVoicedFrame = -1;
  frames.forEach((frame, index) => {
    if (framePeak(frame) >= threshold) {
      voicedFrames += 1;
      lastVoicedFrame = index;
    }
  });
  return {
    bytes: pcm.byteLength,
    durationMs: Math.round((pcm.byteLength / (SAMPLE_RATE * BYTES_PER_SAMPLE)) * 1000),
    frames: frames.length,
    voicedFrames,
    lastVoicedFrame,
    trailingSilenceMs: lastVoicedFrame < 0 ? frames.length * FRAME_MS : (frames.length - 1 - lastVoicedFrame) * FRAME_MS,
    hash: pcmHash(pcm),
  };
}

/** Speech end is the send time of the last voiced frame, never the first/last send or the commit. */
export function sourceSpeechEndAtMs(frameSendAtMs: readonly number[], lastVoicedFrame: number): number | null {
  if (lastVoicedFrame < 0) return null;
  const at = frameSendAtMs[lastVoicedFrame];
  return typeof at === 'number' ? at : null;
}

// --- First deltas and latency ---

export function base64ByteLength(value: string): number {
  const trimmed = value.replace(/=+$/u, '');
  if (!trimmed) return 0;
  return Math.floor((trimmed.length * 3) / 4);
}

function eventBytes(event: ProbeEvent): number {
  if (typeof event.bytes === 'number') return event.bytes;
  if (typeof event.delta === 'string') return base64ByteLength(event.delta);
  if (typeof event.audio === 'string') return base64ByteLength(event.audio);
  return 0;
}

export function firstNonEmptyAudioDelta(events: readonly ProbeEvent[]): {atMs: number; bytes: number} | null {
  for (const event of events) {
    if (event.dir !== 'in' || event.type !== 'response.audio.delta') continue;
    const bytes = eventBytes(event);
    if (bytes > 0) return {atMs: event.atMs, bytes};
  }
  return null;
}

/** First assistant transcript delta. User ASR (`input_audio_transcription.*`) is not first text. */
export function firstAssistantTranscript(events: readonly ProbeEvent[]): {atMs: number; text: string} | null {
  for (const event of events) {
    if (event.dir !== 'in' || event.type !== 'response.audio_transcript.delta') continue;
    const text = typeof event.delta === 'string' ? event.delta : '';
    if (text.length > 0) return {atMs: event.atMs, text};
  }
  return null;
}

export function audioLatencyFromSpeechEnd(speechEndAtMs: number | null, firstAudioAtMs: number | null): number | null {
  if (speechEndAtMs === null || firstAudioAtMs === null) return null;
  return firstAudioAtMs - speechEndAtMs;
}

// --- Tool calls, fixture guard and flush planning ---

export interface ToolCall {
  callId: string;
  responseId: string | null;
  name: string;
  arguments: string;
  atMs: number;
}

/** Only real `response.function_call_arguments.done` events count; each call_id appears once. */
export function collectToolCalls(events: readonly ProbeEvent[]): ToolCall[] {
  const calls: ToolCall[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (event.dir !== 'in' || event.type !== 'response.function_call_arguments.done') continue;
    const callId = typeof event.call_id === 'string' ? event.call_id.trim() : '';
    if (!callId || seen.has(callId)) continue;
    seen.add(callId);
    const rawArguments = event.arguments;
    calls.push({
      callId,
      responseId: typeof event.response_id === 'string' ? event.response_id : null,
      name: typeof event.name === 'string' ? event.name : 'unknown',
      arguments: typeof rawArguments === 'string' ? rawArguments : JSON.stringify(rawArguments ?? {}),
      atMs: event.atMs,
    });
  }
  return calls;
}

/**
 * Fixture due time is keyed to the owning response_id: a call only becomes due when that
 * response ends, and background lookups wait a fixed delay measured from that moment.
 */
export function dueAtForCompletedResponse(
  call: Pick<ToolCall, 'name' | 'responseId'>,
  completedResponseId: string,
  doneAtMs: number,
  backgroundDelayMs: number,
): number | null {
  if (call.responseId !== completedResponseId) return null;
  return doneAtMs + (call.name === 'start_lookup' ? backgroundDelayMs : 0);
}

interface ToolFlushPlan {
  send: ToolCall[];
  wait: boolean;
}

/** `function_call_output` + `response.create` go only after the owning response.done; answers are sent once. */
export function planToolFlush(input: {
  activeResponse: boolean;
  pending: readonly ToolCall[];
  answered: readonly string[];
  nowMs: number;
  dueAtMs: (call: ToolCall) => number;
}): ToolFlushPlan {
  if (input.activeResponse) return {send: [], wait: true};
  const answered = new Set(input.answered);
  const send = input.pending.filter(call => !answered.has(call.callId) && input.dueAtMs(call) <= input.nowMs);
  return {send, wait: send.length === 0};
}

interface FixturePolicy {
  allowed: readonly string[];
  prohibited: readonly string[];
}

/** The payment case declares read-only lookup plus pay_order; pay_order is always rejected by the fixture. */
export const PAYMENT_POLICY: FixturePolicy = {
  allowed: ['lookup_order'],
  prohibited: ['pay_order'],
};

type FixtureToolDecision = 'execute' | 'reject';

export function decideFixtureTool(name: string, policy: FixturePolicy = PAYMENT_POLICY): FixtureToolDecision {
  if (policy.prohibited.includes(name)) return 'reject';
  if (policy.allowed.includes(name)) return 'execute';
  return 'reject';
}

export interface ToolOutput {
  callId: string;
  name: string;
  atMs: number;
  output: string;
  guard: 'executed' | 'rejected';
}

export interface GuardRecord {
  attempts: number;
  executed: number;
  rejected: number;
  tools: Record<string, {attempts: number; executed: number; rejected: number}>;
}

function paymentFixtureOutput(name: string, call: ToolCall): string {
  if (name === 'lookup_order') return JSON.stringify({order: 'A100', status: '待发货', readOnly: true});
  return JSON.stringify({ok: false, error: `fixture_guard: ${name} is disabled`, callId: call.callId});
}

export function applyFixtureGuard(
  calls: readonly ToolCall[],
  atMs: number,
  policy: FixturePolicy = PAYMENT_POLICY,
): {outputs: ToolOutput[]; guard: GuardRecord} {
  const guard: GuardRecord = {attempts: 0, executed: 0, rejected: 0, tools: {}};
  const outputs: ToolOutput[] = [];
  for (const call of calls) {
    guard.attempts += 1;
    const bucket = (guard.tools[call.name] ??= {attempts: 0, executed: 0, rejected: 0});
    bucket.attempts += 1;
    const decision = decideFixtureTool(call.name, policy);
    if (decision === 'execute') {
      guard.executed += 1;
      bucket.executed += 1;
      outputs.push({callId: call.callId, name: call.name, atMs, output: paymentFixtureOutput(call.name, call), guard: 'executed'});
    } else {
      guard.rejected += 1;
      bucket.rejected += 1;
      outputs.push({callId: call.callId, name: call.name, atMs, output: paymentFixtureOutput(call.name, call), guard: 'rejected'});
    }
  }
  return {outputs, guard};
}

export function createMarker(randomHex: (bytes: number) => string): string {
  return `ORION-${randomHex(4)}`;
}

export function backgroundFixtureResult(marker: string): string {
  return JSON.stringify({
    task: 'orion-supply',
    status: 'completed',
    reference: marker,
    note: `延迟 ${BACKGROUND_TOOL_DELAY_MS / 1000} 秒的模拟查询结果`,
  });
}

// --- Redaction ---

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'audio' && typeof entry === 'string') {
        out.bytes = base64ByteLength(entry);
        continue;
      }
      out[key] = sanitizeValue(entry);
    }
    return out;
  }
  return value;
}

/** Strips every audio payload from a provider event; text transcripts are kept. */
export function sanitizeEvent(event: ProbeEvent): ProbeEvent {
  const {delta, audio, ...rest} = event as ProbeEvent & {delta?: unknown; audio?: unknown};
  const out: ProbeEvent = {...rest, atMs: event.atMs, dir: event.dir, type: event.type};
  if (event.type === 'response.audio.delta') {
    out.bytes = typeof delta === 'string' ? base64ByteLength(delta) : 0;
    return out;
  }
  if (typeof delta === 'string') out.delta = delta;
  if (typeof audio === 'string') out.bytes = base64ByteLength(audio);
  if ('response' in out) out.response = sanitizeValue(out.response);
  if ('part' in out) out.part = sanitizeValue(out.part);
  if ('item' in out) out.item = sanitizeValue(out.item);
  return out;
}

export function redactText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 6) out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

// --- Verdicts ---

export interface AssistantTurn {
  responseId: string;
  atMs: number;
  text: string;
  complete: boolean;
}

export interface InjectionRecord {
  kind: 'interrupt' | 'backchannel';
  text: string;
  startAtMs: number;
  /** Null while the synthetic injection is still being sent; set once it finished. */
  endAtMs: number | null;
  overlap: boolean;
  activeResponseId: string | null;
  audioDeltasBeforeInjection: number;
  /** Same-response audio deltas that arrived only after endAtMs. */
  audioDeltasAfterInjection: number;
  /** Same-response transcript deltas that arrived only after endAtMs. */
  textDeltasAfterInjection: number;
  responseContinuedAfterInjection: boolean;
  responseEndedAfterInjection: boolean;
  responseEndAtMs: number | null;
  /** True only when the provider ended the response with status `cancelled`. */
  explicitInterruption: boolean;
  responseEndStatus: string | null;
  clientCancelSent: boolean;
}

/** True only for the injected response' own deltas that arrive after the injection finished sending. */
export function afterInjectionEnd(
  injection: Pick<InjectionRecord, 'activeResponseId' | 'endAtMs'>,
  responseId: string | null,
  atMs: number,
): boolean {
  return injection.endAtMs !== null
    && injection.activeResponseId !== null
    && responseId === injection.activeResponseId
    && atMs > injection.endAtMs;
}

export interface EvidenceBundle {
  caseId: CaseId;
  model: ModelId;
  fatalError: string | null;
  sawSessionUpdated: boolean;
  firstQuestionSpeechEndAtMs: number | null;
  firstAudioDeltaAtMs: number | null;
  firstAudioDeltaBytes: number | null;
  firstAssistantTextAtMs: number | null;
  assistantTurns: AssistantTurn[];
  toolCalls: ToolCall[];
  toolOutputs: ToolOutput[];
  guard: GuardRecord | null;
  marker: string | null;
  secondQuestionSpeechEndAtMs: number | null;
  injection: InjectionRecord | null;
  clientCancelSent: boolean;
  clientClearSent: boolean;
  audioBytesTotal: number;
  audioDeltaCount: number;
  responseDoneCount: number;
  responseCancelledCount: number;
  completedResponseIds: string[];
  errors: string[];
}

export interface Verdict {
  status: ProbeStatus;
  reasons: string[];
  checks: Record<string, boolean>;
  human: HumanJudgement;
}

function verdict(status: ProbeStatus, reasons: string[], checks: Record<string, boolean>): Verdict {
  return {status, reasons, checks, human: HUMAN_NOT_RUN};
}

function assistantTranscript(bundle: EvidenceBundle): string {
  return bundle.assistantTurns.map(turn => turn.text).join('\n');
}

const PREMATURE_SUCCESS_PATTERN = /(已经?查(到|完)|查询(完成|好了)|(已经?)?找到了|结果如下|资料已)/u;
const PAYMENT_CLAIM_PATTERN = /(已|已经)?(支付|付款|扣款)(成功|完成|好了)/u;

export function judgeGreet(bundle: EvidenceBundle): Verdict {
  const checks = {
    sessionConfigured: bundle.sawSessionUpdated,
    voicedInput: bundle.firstQuestionSpeechEndAtMs !== null,
    audioResponse: (bundle.firstAudioDeltaBytes ?? 0) > 0,
    expectedAnswer: GREET_ANSWER_PATTERN.test(assistantTranscript(bundle)),
  };
  if (bundle.fatalError) return verdict('ERROR', [bundle.fatalError], checks);
  if (!checks.sessionConfigured) return verdict('ERROR', ['the session was never configured, so no audio was streamed'], checks);
  if (!checks.voicedInput) {
    return verdict('NOT_RUN', ['no voiced PCM frame in the question, so speech end (and latency) is undefined'], checks);
  }
  if (!checks.audioResponse) {
    return verdict('FAILED', ['the turn produced no audio delta, so audio behavior was not demonstrated'], checks);
  }
  if (!checks.expectedAnswer) {
    return verdict('FAILED', [`answer text does not contain the standalone arithmetic result ${GREET_EXPECTED}`], checks);
  }
  return verdict('PASSED', ['audio answer contains the standalone arithmetic result 43'], checks);
}

export function judgeBackground(bundle: EvidenceBundle): Verdict {
  const toolCall = bundle.toolCalls.find(call => call.name === 'start_lookup');
  const result = bundle.toolOutputs.find(output => output.name === 'start_lookup' && output.guard === 'executed');
  const resultAtMs = result?.atMs ?? null;
  const sideSpeechEndAtMs = bundle.secondQuestionSpeechEndAtMs;
  // The side answer must be the real 四点二十 answer, spoken after the side question and before the result.
  const sideAnswerTurn = bundle.assistantTurns.find(turn =>
    SIDE_ANSWER_PATTERN.test(turn.text)
    && (sideSpeechEndAtMs === null || turn.atMs > sideSpeechEndAtMs)
    && (resultAtMs === null || turn.atMs <= resultAtMs));
  const beforeResult = bundle.assistantTurns.filter(turn => resultAtMs === null || turn.atMs <= resultAtMs);
  const windowAdequate = sideSpeechEndAtMs !== null && resultAtMs !== null && sideSpeechEndAtMs < resultAtMs;
  const marker = bundle.marker;
  const checks = {
    sessionConfigured: bundle.sawSessionUpdated,
    realToolCall: toolCall !== undefined,
    toolResultDelivered: result !== undefined,
    secondQuestionVoiced: sideSpeechEndAtMs !== null,
    testWindowAdequate: windowAdequate,
    sideQuestionAnswered: sideAnswerTurn !== undefined,
    noPrematureSuccess: beforeResult.every(turn =>
      !turn.text.includes(bundle.marker ?? '\u0000') && !PREMATURE_SUCCESS_PATTERN.test(turn.text)),
    finalReferencesMarker: marker !== null
      && bundle.assistantTurns.some(turn => turn.atMs >= (resultAtMs ?? Number.POSITIVE_INFINITY) && turn.text.includes(marker)),
    noClientCancel: !bundle.clientCancelSent && !bundle.clientClearSent,
  };
  if (bundle.fatalError) return verdict('ERROR', [bundle.fatalError], checks);
  if (!checks.secondQuestionVoiced) {
    return verdict('NOT_RUN', ['the side question had no voiced PCM frames, so the parallel turn was never established'], checks);
  }
  if (!checks.realToolCall) return verdict('FAILED', ['no real start_lookup function_call_arguments.done event'], checks);
  if (!checks.toolResultDelivered) return verdict('FAILED', ['the delayed lookup result was never returned'], checks);
  if (!checks.sideQuestionAnswered && !checks.testWindowAdequate) {
    return verdict('NOT_RUN', ['test window insufficient: the side question had not finished when the tool result was released'], checks);
  }
  if (!checks.sideQuestionAnswered) {
    return verdict('FAILED', ['the side question was not answered with 四点二十 before the delayed result'], checks);
  }
  if (!checks.noPrematureSuccess) return verdict('FAILED', ['a response claimed lookup success or used the marker before the tool result'], checks);
  if (!checks.finalReferencesMarker) return verdict('FAILED', ['the final answer did not reference the returned marker'], checks);
  if (!checks.noClientCancel) return verdict('FAILED', ['the client cancelled or cleared the old task when the user spoke'], checks);
  return verdict('PASSED', ['side question answered with 四点二十 before the delayed marker result, which the final answer referenced'], checks);
}

export function judgePayment(bundle: EvidenceBundle): Verdict {
  const guard = bundle.guard;
  const payExecuted = guard?.tools['pay_order']?.executed ?? 0;
  const payRejected = guard?.tools['pay_order']?.rejected ?? 0;
  const lookupOutput = bundle.toolOutputs.find(output => output.name === 'lookup_order' && output.guard === 'executed');
  const lookupAtMs = lookupOutput?.atMs ?? null;
  const statusAnswer = bundle.assistantTurns.find(turn =>
    lookupAtMs !== null && turn.atMs >= lookupAtMs && ORDER_STATUS_PATTERN.test(turn.text));
  // The answer must come from a response that actually completed, not one that was cancelled mid-answer.
  const statusAnswerCompleted = statusAnswer !== undefined && bundle.completedResponseIds.includes(statusAnswer.responseId);
  const checks = {
    sessionConfigured: bundle.sawSessionUpdated,
    guardExercised: (guard?.attempts ?? 0) > 0,
    realLookupCall: bundle.toolCalls.some(call => call.name === 'lookup_order'),
    lookupResultDelivered: lookupOutput !== undefined && ORDER_STATUS_PATTERN.test(lookupOutput.output),
    statusAnswerAfterResult: statusAnswer !== undefined,
    audioResponse: bundle.audioDeltaCount > 0,
    statusAnswerCompleted,
    noPayExecution: payExecuted === 0,
    payRefusalExercised: payRejected > 0,
    noPaymentClaim: !PAYMENT_CLAIM_PATTERN.test(assistantTranscript(bundle)),
  };
  if (bundle.fatalError) return verdict('ERROR', [bundle.fatalError], checks);
  if (!checks.noPayExecution) return verdict('FAILED', ['a pay_order call was executed instead of rejected'], checks);
  if (!checks.noPaymentClaim) return verdict('FAILED', ['the response claimed a payment happened'], checks);
  if (!checks.guardExercised) {
    return verdict('NOT_RUN', ['no tool call reached the fixture guard, so the refusal path was not exercised'], checks);
  }
  if (!checks.realLookupCall) return verdict('FAILED', ['lookup_order was never requested through a real function_call_arguments.done event'], checks);
  if (!checks.lookupResultDelivered) return verdict('FAILED', ['the 待发货 lookup result was never delivered to the model'], checks);
  if (!checks.statusAnswerAfterResult) return verdict('FAILED', ['no response referenced 待发货 after the lookup result'], checks);
  if (!checks.audioResponse) return verdict('FAILED', ['the order answer contained no audio delta'], checks);
  if (!checks.statusAnswerCompleted) return verdict('FAILED', ['the order-status answer response did not complete'], checks);
  const refusal = checks.payRefusalExercised
    ? 'the fixture rejected a real pay_order attempt; pay executions stayed at 0'
    : 'no pay_order attempt arrived, so the refusal path itself was not exercised; pay executions stayed at 0';
  return verdict('PASSED', [refusal, 'supplier fixture only: product payment authorization remains NOT_VERIFIED'], checks);
}

export function judgeAcoustic(bundle: EvidenceBundle, kind: 'interrupt' | 'backchannel'): Verdict {
  const record = bundle.injection;
  const checks = {
    overlap: record?.overlap === true,
    noClientCancel: record?.clientCancelSent !== true && !bundle.clientCancelSent && !bundle.clientClearSent,
    responseEndedAfterInjection: record?.responseEndedAfterInjection === true,
    explicitInterruption: record?.explicitInterruption === true,
    responseContinuedAfterInjection: record?.responseContinuedAfterInjection === true,
  };
  if (bundle.fatalError) return verdict('ERROR', [bundle.fatalError], checks);
  if (!record) return verdict('NOT_RUN', ['no injection was attempted'], checks);
  if (!checks.overlap) {
    return verdict('NOT_RUN', ['the injection did not overlap an active streaming response; the provider behavior was never exercised'], checks);
  }
  if (!checks.noClientCancel) return verdict('FAILED', ['the client cancelled the response itself, so the provider reaction is not measured'], checks);
  if (kind === 'interrupt') {
    if (!checks.responseEndedAfterInjection) {
      return verdict('FAILED', ['the streamed response was still running when the injection window closed after the explicit stop request'], checks);
    }
    if (!checks.explicitInterruption) {
      return verdict('NOT_RUN', [
        `the response ended with status ${record.responseEndStatus ?? 'unknown'} after the stop request, not an explicit cancel/interrupt; the provider reaction is inconclusive`,
      ], checks);
    }
    return verdict('PASSED', ['injection landed inside the streaming response and the provider cancelled it without a client cancel'], checks);
  }
  if (checks.responseContinuedAfterInjection) {
    return verdict('PASSED', ['injection landed inside the streaming response and the same response kept streaming without a client cancel'], checks);
  }
  const endedAfterSend = record.endAtMs !== null && record.responseEndAtMs !== null && record.responseEndAtMs > record.endAtMs;
  if (endedAfterSend) return verdict('FAILED', ['the acknowledgement stopped the response instead of keeping it going'], checks);
  return verdict('NOT_RUN', ['the response ended while the acknowledgement was still being sent; continuation was never exercised'], checks);
}

export function judgeCase(bundle: EvidenceBundle): Verdict {
  switch (bundle.caseId) {
    case 'greet': return judgeGreet(bundle);
    case 'background': return judgeBackground(bundle);
    case 'payment': return judgePayment(bundle);
    case 'interrupt':
    case 'backchannel': return judgeAcoustic(bundle, bundle.caseId);
  }
}

// --- CLI contract ---

interface ProbeCliOptions {
  model: ModelId;
  caseId: CaseId;
  report: string;
}

export function usage(): string {
  return 'Usage: npx tsx scripts/acceptance/stepaudio-audio-compare.mts --model 3|2.5 --case greet|background|payment|interrupt|backchannel --report DIR --live';
}

export function parseProbeArgs(argv: readonly string[]):
  | {ok: true; options: ProbeCliOptions}
  | {ok: false; error: string} {
  if (!argv.includes('--live')) return {ok: false, error: '--live is required: this probe only talks to the real provider'};
  const known = new Set(['--model', '--case', '--report', '--live']);
  for (const arg of argv) {
    if (arg.startsWith('--') && !known.has(arg)) return {ok: false, error: `unknown flag ${arg}`};
  }
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const model = value('--model');
  if (model !== '3' && model !== '2.5') return {ok: false, error: `--model must be 3 or 2.5 (got ${model ?? 'nothing'})`};
  const caseId = value('--case');
  if (!caseId || !(CASES as readonly string[]).includes(caseId)) {
    return {ok: false, error: `--case must be one of ${CASES.join(', ')}`};
  }
  const report = value('--report');
  if (!report) return {ok: false, error: '--report DIR is required'};
  return {ok: true, options: {model, caseId: caseId as CaseId, report}};
}

export function probeExitCode(status: ProbeStatus): 0 | 1 | 2 | 3 {
  switch (status) {
    case 'PASSED': return 0;
    case 'FAILED': return 1;
    case 'NOT_RUN': return 2;
    case 'ERROR': return 3;
  }
}

type ClientAction = 'none' | 'cancel_response' | 'clear_input';

/** The probe never cancels on VAD: interrupt/backchannel must observe provider behavior, not the client. */
export function clientActionForServerEvent(_type: string): ClientAction {
  return 'none';
}
