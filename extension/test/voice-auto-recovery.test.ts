import { afterEach, expect, it, vi } from 'vitest';
import { VoiceClient } from '../src/sidepanel/voice-client.js';
import { VoiceRelay } from '../src/background/voice-relay.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function createMockAudioContext() {
  const nodes: any[] = [];
  const context = {
    currentTime: 0,
    destination: {},
    sampleRate: 24000,
    state: 'running',
    resume: vi.fn(async () => { context.state = 'running'; }),
    close: vi.fn(async () => { context.state = 'closed'; }),
    createBuffer: (_c: number, n: number) => ({ getChannelData: () => new Float32Array(n) }),
    createBufferSource: () => {
      const n = { connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: () => {} };
      nodes.push(n);
      return n;
    },
    audioWorklet: { addModule: vi.fn(async () => {}) },
    createAnalyser: () => ({
      fftSize: 0,
      connect: vi.fn(),
      disconnect: vi.fn(),
      getFloatTimeDomainData: vi.fn(),
    }),
    createMediaStreamSource: () => ({ connect: vi.fn() }),
  };
  return { context: context as unknown as AudioContext, nodes, raw: context };
}

function setupAudioMocks() {
  const { context, raw, nodes } = createMockAudioContext();
  const track = { readyState: 'live', stop: vi.fn(), onended: null as null | (() => void) };
  const stream = { getTracks: () => [track] };
  const getUserMedia = vi.fn(async () => stream);

  vi.stubGlobal('AudioContext', function () { return context; });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('chrome', { runtime: { getURL: (p: string) => p } });

  const worklet = { port: { onmessage: null as null | ((e: any) => void) }, connect: vi.fn(), disconnect: vi.fn() };
  vi.stubGlobal('AudioWorkletNode', function () { return worklet; });

  return { context, raw, nodes, track, stream, getUserMedia, worklet };
}

it('recovers automatically after transport disconnect, reusing microphone without re-prompting', async () => {
  const { getUserMedia, track } = setupAudioMocks();
  const sent: any[] = [];
  const phaseHistory: Array<{ phase: string; detail?: string }> = [];
  const client = new VoiceClient(
    m => { sent.push(m); return true; },
    (phase, detail) => phaseHistory.push({ phase, detail }),
    () => {}
  );

  // 1. Initial start
  await client.start('conv-1');
  expect(getUserMedia).toHaveBeenCalledTimes(1);
  expect(sent).toHaveLength(1);
  const firstVoiceId = sent[0].voiceId;
  expect(sent[0]).toMatchObject({
    type: 'voice',
    voiceId: firstVoiceId,
    conversationId: 'conv-1',
    command: { kind: 'start' }
  });

  // Server marks ready
  client.receive({
    type: 'voice',
    voiceId: firstVoiceId,
    conversationId: 'conv-1',
    event: { kind: 'state', state: 'ready', detail: '已连接' }
  });
  expect(phaseHistory.at(-1)?.phase).toBe('listening');

  // 2. Transport disconnects
  client.onTransportDisconnected();
  expect(client.active).toBe(true); // Still active for the user
  expect(phaseHistory.at(-1)?.phase).toBe('connecting');
  expect(phaseHistory.at(-1)?.detail).toContain('正在恢复');

  // Old callbacks for the first voiceId must be ignored
  client.receive({
    type: 'voice',
    voiceId: firstVoiceId,
    conversationId: 'conv-1',
    event: { kind: 'text', turn: 1, role: 'assistant', text: 'stale text' }
  });

  // 3. Transport reconnected
  client.onTransportReady();
  await Promise.resolve(); // Flush microtasks

  // A second start command is sent with a NEW voiceId for the same conversation
  expect(sent).toHaveLength(2);
  const secondVoiceId = sent[1].voiceId;
  expect(secondVoiceId).not.toBe(firstVoiceId);
  expect(sent[1]).toMatchObject({
    type: 'voice',
    conversationId: 'conv-1',
    command: { kind: 'start' }
  });

  // Microphone stream was reused! getUserMedia was NOT called again.
  expect(getUserMedia).toHaveBeenCalledTimes(1);
  expect(track.stop).not.toHaveBeenCalled();

  // Server marks ready on the new session
  client.receive({
    type: 'voice',
    voiceId: secondVoiceId,
    conversationId: 'conv-1',
    event: { kind: 'state', state: 'ready', detail: '恢复成功' }
  });
  expect(phaseHistory.at(-1)?.phase).toBe('listening');
  expect(phaseHistory.at(-1)?.detail).toBe('恢复成功');
});

it('recovers on server error marked as recoverable (e.g. 29min lifetime limit)', async () => {
  const { getUserMedia } = setupAudioMocks();
  const sent: any[] = [];
  const phaseHistory: Array<{ phase: string; detail?: string }> = [];
  const client = new VoiceClient(
    m => { sent.push(m); return true; },
    (phase, detail) => phaseHistory.push({ phase, detail }),
    () => {}
  );

  await client.start('conv-lifetime');
  const id1 = sent[0].voiceId;
  client.receive({
    type: 'voice',
    voiceId: id1,
    conversationId: 'conv-lifetime',
    event: { kind: 'state', state: 'ready' }
  });

  // Upstream 29min timeout with recoverable: true
  client.receive({
    type: 'voice',
    voiceId: id1,
    conversationId: 'conv-lifetime',
    event: { kind: 'state', state: 'error', detail: '本次语音已到时限，正在自动续接…', recoverable: true }
  });

  expect(client.active).toBe(true);
  expect(phaseHistory.at(-1)?.phase).toBe('connecting');
  expect(phaseHistory.at(-1)?.detail).toBe('本次语音已到时限，正在自动续接…');

  // Trigger reconnect
  client.onTransportReady();
  await Promise.resolve();

  expect(sent).toHaveLength(2);
  expect(sent[1].voiceId).not.toBe(id1);
  expect(sent[1].command.kind).toBe('start');
  expect(getUserMedia).toHaveBeenCalledTimes(1); // mic reused
});

it('does NOT recover on unrecoverable errors (permissions, model mismatch, credentials)', async () => {
  const { getUserMedia, track, raw } = setupAudioMocks();
  const sent: any[] = [];
  const phaseHistory: Array<{ phase: string; detail?: string }> = [];
  const client = new VoiceClient(
    m => { sent.push(m); return true; },
    (phase, detail) => phaseHistory.push({ phase, detail }),
    () => {}
  );

  await client.start('conv-fail');
  const id1 = sent[0].voiceId;
  client.receive({
    type: 'voice',
    voiceId: id1,
    conversationId: 'conv-fail',
    event: { kind: 'state', state: 'ready' }
  });

  // Fatal unrecoverable error (recoverable: false)
  client.receive({
    type: 'voice',
    voiceId: id1,
    conversationId: 'conv-fail',
    event: { kind: 'state', state: 'error', detail: '语音服务返回了不同模型，连接已停止。', recoverable: false }
  });

  expect(client.active).toBe(false);
  expect(phaseHistory.at(-1)?.phase).toBe('error');
  expect(phaseHistory.at(-1)?.detail).toContain('不同模型');
  expect(track.stop).toHaveBeenCalled();
  expect(raw.close).toHaveBeenCalled();

  // Subsequent transport ready does NOT restart
  client.onTransportReady();
  expect(sent.filter(m => m.command.kind === 'start')).toHaveLength(1); // No new start sent
});

it('aborts auto-recovery if user stops or switches conversation', async () => {
  setupAudioMocks();
  const sent: any[] = [];
  const client = new VoiceClient(
    m => { sent.push(m); return true; },
    () => {},
    () => {}
  );

  await client.start('conv-stop');
  const id1 = sent[0].voiceId;
  client.receive({
    type: 'voice',
    voiceId: id1,
    conversationId: 'conv-stop',
    event: { kind: 'state', state: 'ready' }
  });

  // Disconnect -> enters recovery
  client.onTransportDisconnected();
  expect(client.active).toBe(true);

  // User explicitly stops
  client.stop();
  expect(client.active).toBe(false);

  // Reconnection does not occur
  client.onTransportReady();
  expect(sent.filter(m => m.command.kind === 'start')).toHaveLength(1);
});

it('exhausts retries after max attempts and transitions to error state', async () => {
  vi.useFakeTimers();
  setupAudioMocks();
  const sent: any[] = [];
  const phaseHistory: Array<{ phase: string; detail?: string }> = [];
  const client = new VoiceClient(
    m => { sent.push(m); return true; },
    (phase, detail) => phaseHistory.push({ phase, detail }),
    () => {}
  );

  await client.start('conv-retry');
  const id1 = sent[0].voiceId;
  client.receive({
    type: 'voice',
    voiceId: id1,
    conversationId: 'conv-retry',
    event: { kind: 'state', state: 'ready' }
  });

  // Trigger disconnect
  client.onTransportDisconnected();

  // Simulate repeated failure on 3 reconnect attempts
  for (let attempt = 1; attempt <= 3; attempt++) {
    await vi.advanceTimersByTimeAsync(5000);
    const lastStart = sent.at(-1);
    expect(lastStart.command.kind).toBe('start');
    // Emulate immediate failure on that attempt
    client.receive({
      type: 'voice',
      voiceId: lastStart.voiceId,
      conversationId: 'conv-retry',
      event: { kind: 'state', state: 'error', detail: '重连失败', recoverable: true }
    });
  }

  // After 3 failed attempts, recovery is exhausted
  await vi.advanceTimersByTimeAsync(5000);
  expect(client.active).toBe(false);
  expect(phaseHistory.at(-1)?.phase).toBe('error');
  expect(phaseHistory.at(-1)?.detail).toBe('语音连接未能恢复，请重试。');
});

it('VoiceRelay posts recoverable error on disconnected() and binds new lease on reconnect', () => {
  const send = vi.fn((_m: any) => true);
  const relay = new VoiceRelay(send, () => 'conv-relay');

  let portMessage: (m: any) => void = () => {};
  const port1 = {
    postMessage: vi.fn(),
    onMessage: { addListener: (f: any) => { portMessage = f; } },
    onDisconnect: { addListener: () => {} },
  } as unknown as chrome.runtime.Port;

  relay.attach(port1);

  // Client starts voice
  portMessage({
    kind: 'client',
    msg: { type: 'voice', voiceId: 'v-old', conversationId: 'conv-relay', command: { kind: 'start' } }
  });
  expect(send).toHaveBeenCalledTimes(1);

  // Host/Transport disconnects
  relay.disconnected();
  expect(port1.postMessage).toHaveBeenCalledWith({
    kind: 'server',
    conversationId: 'conv-relay',
    msg: {
      type: 'voice',
      voiceId: 'v-old',
      conversationId: 'conv-relay',
      event: { kind: 'state', state: 'error', detail: '语音连接已断开，正在恢复…', recoverable: true }
    }
  });

  // Client reconnects on new port with new voiceId
  let port2Message: (m: any) => void = () => {};
  const port2 = {
    postMessage: vi.fn(),
    onMessage: { addListener: (f: any) => { port2Message = f; } },
    onDisconnect: { addListener: () => {} },
  } as unknown as chrome.runtime.Port;

  relay.attach(port2);
  port2Message({
    kind: 'client',
    msg: { type: 'voice', voiceId: 'v-new', conversationId: 'conv-relay', command: { kind: 'start' } }
  });

  expect(send).toHaveBeenCalledTimes(2);
  const secondCall = send.mock.calls[1];
  if (!secondCall || !secondCall[0]) throw new Error('Expected second send call');
  expect(secondCall[0]).toMatchObject({
    type: 'voice',
    voiceId: 'v-new',
    conversationId: 'conv-relay',
    command: { kind: 'start' }
  });
});

it('rebinds track onended across recovery so unplugging mic is always caught', async () => {
  const { track } = setupAudioMocks();
  const phaseHistory: Array<{ phase: string; detail?: string }> = [];
  const client = new VoiceClient(
    () => true,
    (phase, detail) => phaseHistory.push({ phase, detail }),
    () => {}
  );

  await client.start('conv-mic-pull');
  const id1 = (client as any).id;
  client.receive({
    type: 'voice',
    voiceId: id1,
    conversationId: 'conv-mic-pull',
    event: { kind: 'state', state: 'ready' }
  });

  // Disconnect and recover (reuses mic stream)
  client.onTransportDisconnected();
  client.onTransportReady();
  await Promise.resolve();

  const id2 = (client as any).id;
  expect(id2).not.toBe(id1);

  // Simulate user unplugging microphone after recovery
  track.onended?.();

  // client must detect unplug and fail cleanly
  expect(client.active).toBe(false);
  expect(phaseHistory.at(-1)?.phase).toBe('error');
  expect(phaseHistory.at(-1)?.detail).toBe('麦克风已断开，请重试。');
});

it('handles silent connect timeout during recovery within the 30s budget', async () => {
  vi.useFakeTimers();
  setupAudioMocks();
  const sent: any[] = [];
  const phaseHistory: Array<{ phase: string; detail?: string }> = [];
  const client = new VoiceClient(
    m => { sent.push(m); return true; },
    (phase, detail) => phaseHistory.push({ phase, detail }),
    () => {}
  );

  await client.start('conv-silent-timeout');
  const id1 = sent[0].voiceId;
  client.receive({
    type: 'voice',
    voiceId: id1,
    conversationId: 'conv-silent-timeout',
    event: { kind: 'state', state: 'ready' }
  });

  // Disconnect -> enters recovery
  client.onTransportDisconnected();
  // Trigger recovery attempt 1
  client.onTransportReady();
  await Promise.resolve();
  expect(sent).toHaveLength(2); // start attempt 1

  // Silent timeout without ready arrives: after attemptTimeout (<= 8s), retry occurs
  await vi.advanceTimersByTimeAsync(8100);
  // It should have scheduled and triggered attempt 2
  await vi.advanceTimersByTimeAsync(3000);
  expect(sent).toHaveLength(3); // start attempt 2
  expect(client.active).toBe(true);
});

it('ignores duplicate transport ready events when an attempt is already in flight', async () => {
  setupAudioMocks();
  const sent: any[] = [];
  const client = new VoiceClient(
    m => { sent.push(m); return true; },
    () => {},
    () => {}
  );

  await client.start('conv-dup-ready');
  const id1 = sent[0].voiceId;
  client.receive({
    type: 'voice',
    voiceId: id1,
    conversationId: 'conv-dup-ready',
    event: { kind: 'state', state: 'ready' }
  });

  client.onTransportDisconnected();
  expect(sent).toHaveLength(1);

  // First transport ready launches recovery attempt 1
  client.onTransportReady();
  expect(sent).toHaveLength(2);
  const attemptCountAfterFirst = (client as any).recoveryAttempts;

  // Duplicate transport ready events fire rapidly while attempt 1 is in-flight (waiting for ready)
  client.onTransportReady();
  client.onTransportReady();
  client.onTransportReady();

  // Attempts count must not be incremented and no extra start messages sent
  expect(sent).toHaveLength(2);
  expect((client as any).recoveryAttempts).toBe(attemptCountAfterFirst);
});

it('initial start retains 45s permission timeout and does not fail prematurely at 15s', async () => {
  vi.useFakeTimers();
  setupAudioMocks();
  const phases: string[] = [];
  const client = new VoiceClient(
    () => true,
    p => phases.push(p),
    () => {}
  );

  await client.start('conv-initial-timeout');
  expect(client.active).toBe(true);

  // Advance 20 seconds: should still be active, connecting (waiting for mic permission)
  await vi.advanceTimersByTimeAsync(20_000);
  expect(client.active).toBe(true);
  expect(phases.at(-1)).toBe('connecting');

  // Advance past 45 seconds total: now it times out
  await vi.advanceTimersByTimeAsync(25_001);
  expect(client.active).toBe(false);
  expect(phases.at(-1)).toBe('error');
});

it('records recovery diagnostics with event, attempt and timestamp without sensitive data', async () => {
  setupAudioMocks();
  const sent: any[] = [];
  const diagnostics: any[] = [];
  const client = new VoiceClient(
    m => { sent.push(m); return true; },
    () => {},
    () => {},
    () => ({}),
    (event, fields) => diagnostics.push({ event, ...fields })
  );

  await client.start('conv-diag');
  client.receive({
    type: 'voice',
    voiceId: sent[0].voiceId,
    conversationId: 'conv-diag',
    event: { kind: 'state', state: 'ready' }
  });

  // Transport disconnected -> recovers
  client.onTransportDisconnected();
  expect(diagnostics.some(d => d.event === 'voice_recovering')).toBe(true);
  const recDiag = diagnostics.find(d => d.event === 'voice_recovering');
  expect(recDiag).toHaveProperty('attempt');
  expect(recDiag).toHaveProperty('at');
  expect(recDiag).not.toHaveProperty('token');
  expect(recDiag).not.toHaveProperty('audio');
  expect(recDiag).not.toHaveProperty('transcript');

  // Trigger transport ready -> reconnect attempt diagnostic
  client.onTransportReady();
  expect(diagnostics.some(d => d.event === 'voice_reconnect_attempt')).toBe(true);
  const attemptDiag = diagnostics.find(d => d.event === 'voice_reconnect_attempt');
  expect(attemptDiag?.attempt).toBe(1);

  client.stop();
});


