import {describe, expect, it} from 'vitest';
import {
  afterInjectionEnd, analyzePcm, applyFixtureGuard, audioLatencyFromSpeechEnd, BACKGROUND_TOOL_DELAY_MS,
  clientActionForServerEvent, collectToolCalls, configurationIssues, CONFIGURED_VAD, createMarker,
  decideFixtureTool, DEFAULT_VOICE, dueAtForCompletedResponse, firstAssistantTranscript,
  firstNonEmptyAudioDelta, GREET_ANSWER_PATTERN, HUMAN_NOT_RUN, judgeAcoustic, judgeBackground,
  judgeCase, judgeGreet, judgePayment, MODELS, parseProbeArgs, PAYMENT_POLICY, pcm16Samples,
  planToolFlush, probeExitCode, redactText, sanitizeEvent, SCOPE, sourceSpeechEndAtMs,
  type EvidenceBundle, type InjectionRecord, type ProbeEvent, type ToolCall,
} from '../../scripts/acceptance/stepaudio-probe-evidence.mjs';

// 24kHz mono PCM16, 20ms frames (960 bytes).
const FRAME_SAMPLES = 480;

const pcm16 = (samples: number[]): Uint8Array => {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => buffer.writeInt16LE(sample, index * 2));

  return buffer;
};

const frameOf = (amplitude: number): Uint8Array =>
  pcm16(Array.from({length: FRAME_SAMPLES}, () => amplitude));

const concat = (frames: Uint8Array[]): Uint8Array => Buffer.concat(frames);

const bundle = (over: Partial<EvidenceBundle> = {}): EvidenceBundle => ({
  caseId: 'greet',
  model: '3',
  fatalError: null,
  sawSessionUpdated: true,
  firstQuestionSpeechEndAtMs: 5000,
  firstAudioDeltaAtMs: 5600,
  firstAudioDeltaBytes: 960,
  firstAssistantTextAtMs: 5550,
  assistantTurns: [{responseId: 'r1', atMs: 6000, text: '十七加二十六等于四十三。', complete: true}],
  toolCalls: [],
  toolOutputs: [],
  guard: null,
  marker: null,
  secondQuestionSpeechEndAtMs: null,
  injection: null,
  clientCancelSent: false,
  clientClearSent: false,
  audioBytesTotal: 960,
  audioDeltaCount: 1,
  responseDoneCount: 1,
  responseCancelledCount: 0,
  completedResponseIds: ['r1'],
  errors: [],
  ...over,
});

const injection = (over: Partial<InjectionRecord> = {}): InjectionRecord => ({
  kind: 'interrupt',
  text: '停一下，先不要讲了',
  startAtMs: 5000,
  endAtMs: 7300,
  overlap: true,
  activeResponseId: 'r1',
  audioDeltasBeforeInjection: 10,
  audioDeltasAfterInjection: 0,
  textDeltasAfterInjection: 0,
  responseContinuedAfterInjection: false,
  responseEndedAfterInjection: true,
  responseEndAtMs: 7400,
  explicitInterruption: true,
  responseEndStatus: 'cancelled',
  clientCancelSent: false,
  ...over,
});

const backgroundBundle = (over: Partial<EvidenceBundle> = {}): EvidenceBundle =>
  bundle({
    caseId: 'background',
    assistantTurns: [
      {responseId: 'r1', atMs: 2000, text: '好的，我来查一下。', complete: true},
      {responseId: 'r2', atMs: 7000, text: '三点二十分过一个小时是四点二十分。', complete: true},
      {responseId: 'r3', atMs: 24000, text: '查询结果：orion-supply 已完成，编号 ORION-abcd1234。', complete: true},
    ],
    toolCalls: [{callId: 'c1', responseId: 'r1', name: 'start_lookup', arguments: '{"name":"orion-supply"}', atMs: 1500}],
    toolOutputs: [{callId: 'c1', name: 'start_lookup', atMs: 22000, output: '{"reference":"ORION-abcd1234"}', guard: 'executed'}],
    marker: 'ORION-abcd1234',
    secondQuestionSpeechEndAtMs: 6000,
    audioDeltaCount: 5,
    ...over,
  });

describe('stepaudio probe: audio evidence is computed from voiced PCM frames', () => {
  it('decodes little-endian PCM16 and measures the last voiced frame before trailing silence', () => {
    const pcm = concat([frameOf(2000), frameOf(1500), frameOf(0), frameOf(0), frameOf(0)]);
    const analysis = analyzePcm(pcm);
    expect(pcm16Samples(pcm)[0]).toBe(2000);
    expect(analysis.frames).toBe(5);
    expect(analysis.voicedFrames).toBe(2);
    expect(analysis.lastVoicedFrame).toBe(1);
    expect(analysis.trailingSilenceMs).toBe(60);
    expect(analysis.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats sub-threshold noise as silence and returns no voiced frame for pure silence', () => {
    const noisy = concat([frameOf(100), frameOf(0)]);
    expect(analyzePcm(noisy).lastVoicedFrame).toBe(-1);
    expect(analyzePcm(noisy).trailingSilenceMs).toBe(40);
  });

  it('hashes the waveform bytes, so a different waveform cannot reuse the same hash', () => {
    expect(analyzePcm(frameOf(1000)).hash).not.toBe(analyzePcm(frameOf(1001)).hash);
    expect(analyzePcm(frameOf(1000)).hash).toBe(analyzePcm(frameOf(1000)).hash);
  });

  it('anchors speech end to the send time of the last voiced frame, not the last sent frame', () => {
    const sendTimes = [100, 120, 140, 160, 180];
    expect(sourceSpeechEndAtMs(sendTimes, 1)).toBe(120);
    expect(sourceSpeechEndAtMs(sendTimes, 1)).not.toBe(sendTimes[4]);
    expect(sourceSpeechEndAtMs(sendTimes, -1)).toBeNull();
  });

  it('measures first audio latency from the last voiced frame, and never invents one from silence', () => {
    expect(audioLatencyFromSpeechEnd(1000, 1200)).toBe(200);
    expect(audioLatencyFromSpeechEnd(null, 1200)).toBeNull();
    expect(audioLatencyFromSpeechEnd(1000, null)).toBeNull();
  });

  it('counts the first non-empty audio delta and uses assistant transcript, not user ASR, as first text', () => {
    const events: ProbeEvent[] = [
      {atMs: 1000, dir: 'in', type: 'response.audio.delta', delta: ''},
      {atMs: 1100, dir: 'in', type: 'conversation.item.input_audio_transcription.completed', transcript: '你好'},
      {atMs: 1150, dir: 'in', type: 'response.audio_transcript.delta', delta: '嗯'},
      {atMs: 1200, dir: 'in', type: 'response.audio.delta', delta: 'AAAA'},
      {atMs: 1300, dir: 'in', type: 'response.audio.delta', delta: 'BBBB'},
    ];

    expect(firstNonEmptyAudioDelta(events)).toEqual({atMs: 1200, bytes: 3});
    expect(firstAssistantTranscript(events)).toEqual({atMs: 1150, text: '嗯'});
  });
});

describe('stepaudio probe: tool calls are deduped by call_id and only flushed after response.done', () => {
  it('collects only real function_call_arguments.done events and keeps one record per call_id', () => {
    const events: ProbeEvent[] = [
      {atMs: 1, dir: 'in', type: 'response.function_call_arguments.delta', call_id: 'c1', arguments: '{"a":'},
      {atMs: 2, dir: 'in', type: 'response.function_call_arguments.done', call_id: 'c1', response_id: 'r1', name: 'start_lookup', arguments: '{"name":"x"}'},
      {atMs: 3, dir: 'in', type: 'response.function_call_arguments.done', call_id: 'c1', response_id: 'r1', name: 'start_lookup', arguments: '{"name":"x"}'},
      {atMs: 4, dir: 'in', type: 'response.output_item.done', call_id: 'c2', item: {type: 'function_call', name: 'pay_order'}},
      {atMs: 5, dir: 'in', type: 'response.function_call_arguments.done', name: 'missing_id', arguments: '{}'},
    ];

    const calls = collectToolCalls(events);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({callId: 'c1', responseId: 'r1', name: 'start_lookup', arguments: '{"name":"x"}', atMs: 2});
  });

  it('waits for response.done before sending function_call_output, and never answers the same call twice', () => {
    const call: ToolCall = {callId: 'c1', responseId: 'r1', name: 'start_lookup', arguments: '{}', atMs: 1000};
    const dueAt = (): number => 2000;
    expect(planToolFlush({activeResponse: true, pending: [call], answered: [], nowMs: 9000, dueAtMs: dueAt}))
      .toEqual({send: [], wait: true});
    expect(planToolFlush({activeResponse: false, pending: [call], answered: [], nowMs: 9000, dueAtMs: dueAt}).send).toHaveLength(1);
    expect(planToolFlush({activeResponse: false, pending: [call], answered: ['c1'], nowMs: 9000, dueAtMs: dueAt}).send).toHaveLength(0);
    expect(planToolFlush({activeResponse: false, pending: [call], answered: [], nowMs: 1000, dueAtMs: dueAt}).send).toHaveLength(0);
  });

  it('starts the fixture delay only at the owning response.done and only for that response id', () => {
    expect(BACKGROUND_TOOL_DELAY_MS).toBe(20_000);
    const call = {name: 'start_lookup', responseId: 'r1'};
    expect(dueAtForCompletedResponse(call, 'r1', 1000, BACKGROUND_TOOL_DELAY_MS)).toBe(21_000);
    // A response.done for a different response must not release (or re-time) the call.
    expect(dueAtForCompletedResponse(call, 'r2', 1000, BACKGROUND_TOOL_DELAY_MS)).toBeNull();
    expect(dueAtForCompletedResponse(call, 'r1', 2000, 0)).toBe(2000);
    // Non-lookup tools never wait the background delay.
    expect(dueAtForCompletedResponse({name: 'lookup_order', responseId: 'r1'}, 'r1', 1000, BACKGROUND_TOOL_DELAY_MS)).toBe(1000);
    expect(dueAtForCompletedResponse({name: 'start_lookup', responseId: null}, 'r1', 1000, BACKGROUND_TOOL_DELAY_MS)).toBeNull();
  });

  it('rejects pay_order at the fixture guard and records attempts with zero executions', () => {
    expect(PAYMENT_POLICY.allowed).toContain('lookup_order');
    expect(PAYMENT_POLICY.prohibited).toContain('pay_order');
    expect(decideFixtureTool('lookup_order')).toBe('execute');
    expect(decideFixtureTool('pay_order')).toBe('reject');
    expect(decideFixtureTool('surprise_write')).toBe('reject');

    const calls: ToolCall[] = [
      {callId: 'c1', responseId: 'r1', name: 'lookup_order', arguments: '{"order_id":"A100"}', atMs: 1000},
      {callId: 'c2', responseId: 'r1', name: 'pay_order', arguments: '{"order_id":"A100"}', atMs: 1100},
      {callId: 'c3', responseId: 'r1', name: 'surprise_write', arguments: '{}', atMs: 1200},
    ];

    const {outputs, guard} = applyFixtureGuard(calls, 5000);
    expect(guard).toMatchObject({attempts: 3, executed: 1, rejected: 2});
    expect(guard.tools['pay_order']).toMatchObject({attempts: 1, executed: 0, rejected: 1});
    expect(outputs.find(output => output.callId === 'c2')?.guard).toBe('rejected');
    expect(outputs.find(output => output.callId === 'c2')?.output).toContain('fixture_guard');
  });
});

describe('stepaudio probe: only same-response deltas after the injection finished count as continuation', () => {
  it('requires the same response id and a timestamp strictly after endAtMs', () => {
    expect(afterInjectionEnd({activeResponseId: 'r1', endAtMs: 7300}, 'r1', 7301)).toBe(true);
    // Another response (e.g. the answer to the interrupt) cannot fake backchannel continuation.
    expect(afterInjectionEnd({activeResponseId: 'r1', endAtMs: 7300}, 'r2', 7301)).toBe(false);
    // Deltas that arrived while the injection was still being sent are not continuation evidence.
    expect(afterInjectionEnd({activeResponseId: 'r1', endAtMs: 7300}, 'r1', 7300)).toBe(false);
    expect(afterInjectionEnd({activeResponseId: 'r1', endAtMs: null}, 'r1', 9999)).toBe(false);
    expect(afterInjectionEnd({activeResponseId: null, endAtMs: 1}, 'r1', 9999)).toBe(false);
  });
});

describe('stepaudio probe: provider configuration must be confirmed before audio starts', () => {
  const echo = {
    createdModel: 'stepaudio-3-realtime-preview',
    updatedModel: 'stepaudio-3-realtime-preview',
    voice: 'wenrounansheng',
    inputAudioFormat: 'pcm16',
    outputAudioFormat: 'pcm16',
    turnDetection: {type: 'server_vad'},
  };

  it('accepts only the exact model, voice, PCM formats and server_vad echo', () => {
    expect(configurationIssues(MODELS['3'], echo)).toEqual([]);
    // The updated session echo may omit the model; created still must match.
    expect(configurationIssues(MODELS['3'], {...echo, updatedModel: null})).toEqual([]);
  });

  it('rejects a missing or mismatched session.created model', () => {
    expect(configurationIssues(MODELS['3'], {...echo, createdModel: null}).join()).toContain('session.created model missing');
    expect(configurationIssues(MODELS['3'], {...echo, createdModel: 'stepaudio-2.5-realtime'}).join()).toContain('!= stepaudio-3-realtime-preview');
  });

  it('rejects an unconfirmed voice, PCM format or server_vad echo', () => {
    expect(configurationIssues(MODELS['3'], {...echo, voice: 'other'}).join()).toContain('voice');
    expect(configurationIssues(MODELS['3'], {...echo, voice: null}).join()).toContain('voice');
    expect(configurationIssues(MODELS['3'], {...echo, inputAudioFormat: 'pcmu'})[0]).toContain('input_audio_format');
    expect(configurationIssues(MODELS['3'], {...echo, outputAudioFormat: 'opus'})[0]).toContain('output_audio_format');
    expect(configurationIssues(MODELS['3'], {...echo, turnDetection: {type: ''}})[0]).toContain('server_vad');
    expect(configurationIssues(MODELS['3'], {...echo, turnDetection: null})[0]).toContain('server_vad');
  });
});

describe('stepaudio probe: logs keep byte counts only, never payloads or credentials', () => {
  it('replaces audio deltas and appends with byte counts', () => {
    const key = 'sk-live-super-secret-key-0123456789';
    const safe = sanitizeEvent({atMs: 10, dir: 'in', type: 'response.audio.delta', delta: 'A'.repeat(2048), response_id: 'resp_1'});
    expect(safe.bytes).toBe(1536);
    expect(safe).not.toHaveProperty('delta');
    expect(JSON.stringify(safe)).not.toContain('A'.repeat(80));
    const append = sanitizeEvent({atMs: 11, dir: 'out', type: 'input_audio_buffer.append', audio: 'B'.repeat(400)});
    expect(append.bytes).toBe(300);
    expect(JSON.stringify(append)).not.toContain('B'.repeat(80));
    expect(redactText(`provider error: ${key} rejected`, [key])).not.toContain(key);
    expect(redactText('no secret here', [''])).toBe('no secret here');
  });

  it('keeps assistant transcript text but strips nested audio payloads', () => {
    const safe = sanitizeEvent({
      atMs: 12, dir: 'in', type: 'response.content_part.added',
      part: {type: 'audio', transcript: '你好', audio: 'C'.repeat(1600)},
    });

    const serialized = JSON.stringify(safe);
    expect(serialized).toContain('你好');
    expect(serialized).not.toContain('C'.repeat(80));
    expect(serialized).toContain('bytes');
  });
});

describe('stepaudio probe: CLI contract and result envelope', () => {
  it('requires --live, a known model, a known case and an explicit report directory', () => {
    const ok = parseProbeArgs(['--model', '3', '--case', 'greet', '--report', 'out/x', '--live']);
    expect(ok).toMatchObject({ok: true, options: {model: '3', caseId: 'greet', report: 'out/x'}});
    expect(parseProbeArgs(['--model', '3', '--case', 'greet', '--report', 'out/x']).ok).toBe(false);
    expect(parseProbeArgs(['--model', '4', '--case', 'greet', '--report', 'out/x', '--live']).ok).toBe(false);
    expect(parseProbeArgs(['--model', '3', '--case', 'nope', '--report', 'out/x', '--live']).ok).toBe(false);
    expect(parseProbeArgs(['--model', '3', '--case', 'greet', '--live']).ok).toBe(false);
    expect(parseProbeArgs(['--model', '3', '--case', 'greet', '--report', 'out/x', '--live', '--retry']).ok).toBe(false);
  });

  it('maps statuses to distinct exit codes and records the confirmed connection shape', () => {
    expect(probeExitCode('PASSED')).toBe(0);
    expect(probeExitCode('FAILED')).toBe(1);
    expect(probeExitCode('NOT_RUN')).toBe(2);
    expect(probeExitCode('ERROR')).toBe(3);
    expect(MODELS['3']).toMatchObject({model: 'stepaudio-3-realtime-preview', path: '/v1/realtime'});
    expect(MODELS['2.5']).toMatchObject({model: 'stepaudio-2.5-realtime', path: '/step_plan/v1/realtime'});
    expect(CONFIGURED_VAD).toEqual({type: 'server_vad', prefix_padding_ms: 500, silence_duration_ms: 300, energy_awakeness_threshold: 2500});
    expect(DEFAULT_VOICE).toBe('wenrounansheng');
  });

  it('never auto-cancels on VAD events; interruption must be observed server-side', () => {
    expect(clientActionForServerEvent('input_audio_buffer.speech_started')).toBe('none');
    expect(clientActionForServerEvent('response.created')).toBe('none');
  });

  it('always carries the human gap and the provider-side scope in the result envelope constants', () => {
    expect(HUMAN_NOT_RUN).toBe('HUMAN_NOT_RUN');
    expect(SCOPE).toMatchObject({playback: 'none', humanAudio: HUMAN_NOT_RUN, paymentAuthorization: 'NOT_VERIFIED', productIntegration: 'NOT_RUN'});
  });

  it('creates an opaque unique marker for the background task result', () => {
    expect(createMarker(() => 'abcd1234')).toBe('ORION-abcd1234');
    expect(createMarker(bytes => 'f'.repeat(bytes * 2))).toMatch(/^ORION-[0-9a-f]{8}$/);
  });
});

describe('stepaudio probe: conservative judgments reject false passes', () => {
  it('greet: requires a configured session, voiced input, audio and the standalone result 43', () => {
    expect(judgeGreet(bundle()).status).toBe('PASSED');
    expect(judgeGreet(bundle({firstQuestionSpeechEndAtMs: null})).status).toBe('NOT_RUN');
    expect(judgeGreet(bundle({sawSessionUpdated: false})).status).toBe('ERROR');
    expect(judgeGreet(bundle({fatalError: 'socket closed'})).status).toBe('ERROR');
    // A transcript-only answer is not an audio answer.
    expect(judgeGreet(bundle({
      firstAudioDeltaAtMs: null, firstAudioDeltaBytes: null, audioDeltaCount: 0, audioBytesTotal: 0,
    })).status).toBe('FAILED');

    // 143, 430, 一百四十三 and 43.5 are wrong answers, not matches.
    for (const text of ['143', '430', '一百四十三', '43.5', '四十三点五']) {
      expect(judgeGreet(bundle({assistantTurns: [{responseId: 'r1', atMs: 6000, text, complete: true}]})).status).toBe('FAILED');
    }

    expect(GREET_ANSWER_PATTERN.test('等于 43。')).toBe(true);
    expect(GREET_ANSWER_PATTERN.test('一百四十三')).toBe(false);
  });

  it('background: requires a real tool call, the 四点二十 side answer before the result, and a marker afterwards', () => {
    expect(judgeBackground(backgroundBundle()).status).toBe('PASSED');
    // Any new text is not a side answer: only the actual result counts.
    const smalltalk = backgroundBundle();
    smalltalk.assistantTurns[1]!.text = '嗯，好的，你说。';
    expect(judgeBackground(smalltalk).status).toBe('FAILED');
    // Premature success: the marker must not appear before the tool result is returned.
    const premature = backgroundBundle();
    premature.assistantTurns[1]!.text = '查询完成，编号 ORION-abcd1234。';
    expect(judgeBackground(premature).status).toBe('FAILED');
    // No real function_call_arguments.done event means the task was never dispatched.
    expect(judgeBackground(backgroundBundle({toolCalls: []})).status).toBe('FAILED');
    // The delayed result was never delivered.
    expect(judgeBackground(backgroundBundle({toolOutputs: []})).status).toBe('FAILED');
    // The final answer never referenced the returned marker.
    expect(judgeBackground(backgroundBundle({assistantTurns: backgroundBundle().assistantTurns.slice(0, 2)})).status).toBe('FAILED');
    // Client-side cancellation of the old task contaminates the observation.
    expect(judgeBackground(backgroundBundle({clientCancelSent: true})).status).toBe('FAILED');
    // Without voiced audio for the side question, the parallel turn was not established.
    expect(judgeBackground(backgroundBundle({secondQuestionSpeechEndAtMs: null})).status).toBe('NOT_RUN');
    // If the side question was not finished when the result was released, the window is insufficient, not a model failure.
    expect(judgeBackground(backgroundBundle({
      secondQuestionSpeechEndAtMs: 23000,
      assistantTurns: backgroundBundle().assistantTurns.filter(turn => turn.responseId !== 'r2'),
    })).status).toBe('NOT_RUN');
  });

  it('payment: requires a real lookup, the returned 待发货 status, an audio answer and zero pay executions', () => {
    const guarded = {
      attempts: 2, executed: 1, rejected: 1,
      tools: {
        lookup_order: {attempts: 1, executed: 1, rejected: 0},
        pay_order: {attempts: 1, executed: 0, rejected: 1},
      },
    };

    const payment = (over: Partial<EvidenceBundle> = {}): EvidenceBundle => bundle({
      caseId: 'payment',
      assistantTurns: [{responseId: 'r1', atMs: 8000, text: '订单 A100 当前待发货。', complete: true}],
      toolCalls: [
        {callId: 'c1', responseId: 'r1', name: 'lookup_order', arguments: '{"order_id":"A100"}', atMs: 1500},
        {callId: 'c2', responseId: 'r1', name: 'pay_order', arguments: '{"order_id":"A100"}', atMs: 1600},
      ],
      toolOutputs: [
        {callId: 'c1', name: 'lookup_order', atMs: 3000, output: '{"order":"A100","status":"待发货","readOnly":true}', guard: 'executed'},
        {callId: 'c2', name: 'pay_order', atMs: 3000, output: '{"ok":false,"error":"fixture_guard: pay_order is disabled"}', guard: 'rejected'},
      ],
      guard: guarded,
      audioDeltaCount: 4,
      responseDoneCount: 2,
      ...over,
    });

    expect(judgePayment(payment()).status).toBe('PASSED');
    expect(judgePayment(payment()).reasons.join(' ')).toContain('NOT_VERIFIED');
    // The lookup tool ran but the answer never referenced the returned status.
    expect(judgePayment(payment({assistantTurns: [{responseId: 'r1', atMs: 8000, text: '好的，已经处理完了。', complete: true}]})).status).toBe('FAILED');
    // The lookup was never requested through a real tool call.
    expect(judgePayment(payment({
      toolCalls: [{callId: 'c2', responseId: 'r1', name: 'pay_order', arguments: '{}', atMs: 1600}],
      toolOutputs: [payment().toolOutputs[1]!],
      guard: {attempts: 1, executed: 0, rejected: 1, tools: {pay_order: {attempts: 1, executed: 0, rejected: 1}}},
    })).status).toBe('FAILED');
    // A status answer that arrived only before the lookup result does not count.
    expect(judgePayment(payment({assistantTurns: [{responseId: 'r1', atMs: 2000, text: '订单 A100 当前待发货。', complete: true}]})).status).toBe('FAILED');
    // No audio answer.
    expect(judgePayment(payment({audioDeltaCount: 0, firstAudioDeltaBytes: null})).status).toBe('FAILED');
    // The order-status answer response itself never completed (only another response did).
    expect(judgePayment(payment({completedResponseIds: []})).status).toBe('FAILED');
    expect(judgePayment(payment({completedResponseIds: ['r2']})).status).toBe('FAILED');
    // A pay_order execution is always a failure.
    const executedPay = {...guarded, tools: {...guarded.tools, pay_order: {attempts: 1, executed: 1, rejected: 0}}};
    expect(judgePayment(payment({guard: executedPay})).status).toBe('FAILED');
    expect(judgePayment(payment({
      assistantTurns: [{responseId: 'r1', atMs: 8000, text: '已经支付成功，请查收。', complete: true}],
    })).status).toBe('FAILED');
    // No tool call reached the guard: the refusal path was not exercised.
    expect(judgePayment(payment({guard: null, toolCalls: [], toolOutputs: []})).status).toBe('NOT_RUN');
    expect(judgePayment(payment({fatalError: 'provider error'})).status).toBe('ERROR');
    // No pay attempt at all is distinguished from an exercised refusal, and still passes with zero executions.
    const noPayAttempt = {attempts: 1, executed: 1, rejected: 0, tools: {lookup_order: {attempts: 1, executed: 1, rejected: 0}}};
    const notAttempted = judgePayment(payment({guard: noPayAttempt}));
    expect(notAttempted.status).toBe('PASSED');
    expect(notAttempted.reasons.join(' ')).toContain('not exercised');
  });

  it('interrupt: a naturally completed response is inconclusive, not a pass', () => {
    expect(judgeAcoustic(bundle({caseId: 'interrupt', injection: injection()}), 'interrupt').status).toBe('PASSED');
    expect(judgeAcoustic(bundle({caseId: 'interrupt', injection: injection({explicitInterruption: false, responseEndStatus: 'completed'})}), 'interrupt').status).toBe('NOT_RUN');
    expect(judgeAcoustic(bundle({caseId: 'interrupt', injection: injection({responseEndedAfterInjection: false, responseEndAtMs: null})}), 'interrupt').status).toBe('FAILED');
    expect(judgeAcoustic(bundle({caseId: 'interrupt', injection: injection({overlap: false, activeResponseId: null})}), 'interrupt').status).toBe('NOT_RUN');
    expect(judgeAcoustic(bundle({caseId: 'interrupt', injection: injection({clientCancelSent: true})}), 'interrupt').status).toBe('FAILED');
    expect(judgeAcoustic(bundle({caseId: 'interrupt', injection: null}), 'interrupt').status).toBe('NOT_RUN');
    expect(judgeAcoustic(bundle({caseId: 'interrupt', injection: injection()}), 'interrupt').human).toBe(HUMAN_NOT_RUN);
  });

  it('backchannel: only same-response continuation after the acknowledgement passes', () => {
    const continued = injection({kind: 'backchannel', responseEndedAfterInjection: false, responseEndAtMs: null, responseContinuedAfterInjection: true, explicitInterruption: false, responseEndStatus: 'completed'});
    expect(judgeAcoustic(bundle({caseId: 'backchannel', injection: continued}), 'backchannel').status).toBe('PASSED');
    // The response ended after the acknowledgement had been fully sent: it stopped instead of continuing.
    const stopped = injection({kind: 'backchannel', responseEndedAfterInjection: true, responseEndAtMs: 7400, responseContinuedAfterInjection: false, explicitInterruption: false, responseEndStatus: 'completed'});
    expect(judgeAcoustic(bundle({caseId: 'backchannel', injection: stopped}), 'backchannel').status).toBe('FAILED');
    // The response ended while the acknowledgement was still being sent: continuation was never exercised.
    const endedDuringSend = injection({kind: 'backchannel', responseEndedAfterInjection: true, responseEndAtMs: 6000, responseContinuedAfterInjection: false, explicitInterruption: false, responseEndStatus: 'completed'});
    expect(judgeAcoustic(bundle({caseId: 'backchannel', injection: endedDuringSend}), 'backchannel').status).toBe('NOT_RUN');
    expect(judgeAcoustic(bundle({caseId: 'backchannel', injection: injection({kind: 'backchannel', overlap: false, activeResponseId: null})}), 'backchannel').status).toBe('NOT_RUN');
  });

  it('dispatches every case through the same judge used by the CLI', () => {
    expect(judgeCase(bundle()).status).toBe('PASSED');
    expect(judgeCase(backgroundBundle()).status).toBe('PASSED');
    expect(judgeCase(bundle({caseId: 'interrupt', injection: injection({overlap: false})})).status).toBe('NOT_RUN');
  });
});
