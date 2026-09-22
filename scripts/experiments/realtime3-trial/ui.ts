// Realtime 3 独立试用侧栏插件。
// 只挂载自己的 UI 与独立 WebSocket，不触碰生产代码、原语音链路与任务链路。
//
// 注入方式（主代理）：esbuild 打包本文件为 trial-ui.js，注入独立扩展副本 sidepanel.html；
// 其前加载 trial-config.js：globalThis.__REALTIME3_TRIAL__ = { url, token, workletUrl? }。
//
// AudioWorklet：主代理可把导出的 REALTIME3_CAPTURE_WORKLET_SOURCE 写成与 sidepanel.html
// 同目录的 trial-capture-worklet.js 以启用；加载不到时回退已废弃的 ScriptProcessor
// （仅短期兼容，采集与 24k 转换逻辑一致）。不保存任何原始音频，只在内存中做实时转发。

export const REALTIME3_CAPTURE_WORKLET_SOURCE = `class Realtime3Capture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(new Float32Array(channel));
    return true;
  }
}
registerProcessor('realtime3-capture', Realtime3Capture);
`;

type TrialConfig = { url?: string; token?: string; workletUrl?: string };

type ServerMessage =
  | { type: 'ready'; model: string }
  | { type: 'status'; text: string }
  | { type: 'transcript'; role: 'user' | 'assistant'; text: string; final: boolean; responseId?: string }
  | { type: 'audio'; data: string; responseId: string }
  | { type: 'response_done'; responseId: string; status?: string }
  | { type: 'clear_audio' }
  | { type: 'metric'; name: string; value: number; unit?: string }
  | { type: 'error'; message: string }
  | { type: 'closed' };

type PlaybackEntry = {
  sources: Set<AudioBufferSourceNode>;
  done: boolean;
  notified: boolean;
  chunks: number;
  vadAt: number | null;
  firstServerAt: number | null;
  firstPlayAt: number | null;
  endedAt: number | null;
};

type ClientMessage = Record<string, unknown>;

const MODEL_RATE = 24000;

const FRAME_SAMPLES = 480; // 20ms @ 24k

const readConfig = (): TrialConfig | null => {
  const config = (globalThis as unknown as { __REALTIME3_TRIAL__?: TrialConfig }).__REALTIME3_TRIAL__;

  return config && typeof config.url === 'string' && config.url ? config : null;
};

/** 线性插值把设备采样率（常见 48k/44.1k）转成 24k Int16 单声道 20ms 帧。只在内存中保留转换余量。 */
class Resampler24 {
  private pos = 0;
  private buf = new Float32Array(0);
  private frame = new Int16Array(FRAME_SAMPLES);
  private offset = 0;
  constructor(private readonly ratio: number) {}
  push(input: Float32Array): Int16Array[] {
    const merged = new Float32Array(this.buf.length + input.length);
    merged.set(this.buf, 0);
    merged.set(input, this.buf.length);
    const frames: Int16Array[] = [];

    while (Math.floor(this.pos) + 1 < merged.length) {
      const index = Math.floor(this.pos);
      const mix = this.pos - index;
      const a = merged[index] ?? 0;
      const b = merged[index + 1] ?? 0;
      const value = Math.max(-1, Math.min(1, a + (b - a) * mix));
      this.frame[this.offset++] = Math.round(value * (value < 0 ? 32768 : 32767));

      if (this.offset === FRAME_SAMPLES) {
        frames.push(this.frame);
        this.frame = new Int16Array(FRAME_SAMPLES);
        this.offset = 0;
      }

      this.pos += this.ratio;
    }

    const consumed = Math.floor(this.pos);

    if (consumed > 0) {
      this.buf = merged.slice(consumed);
      this.pos -= consumed;
    } else {
      this.buf = merged;
    }

    return frames;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';

  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));

  return btoa(binary);
}

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);

  return out;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function mountRealtime3Trial(app: HTMLElement): void {
  if (document.getElementById('r3-trial')) return;

  const make = (tag: string, className?: string, text?: string): HTMLElement => {
    const element = document.createElement(tag);

    if (className) element.className = className;

    if (text !== undefined) element.textContent = text;

    return element;
  };

  const button = (className: string, label: string, title: string): HTMLButtonElement => {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = className;
    element.textContent = label;
    element.title = title;

    return element;
  };

  const root = make('section', 'r3') as HTMLElement;
  root.id = 'r3-trial';
  root.dataset.state = 'idle';
  const head = make('div', 'r3-head');
  head.append(make('span', 'r3-badge', 'Realtime 3 · 独立试用'), make('span', 'r3-state', '未连接'));
  const note = make('p', 'r3-note', '日常 2.5 不变；可读页面/翻译/显示调整；提交、付款等暂不执行');
  const actions = make('div', 'r3-actions');
  const startButton = button('r3-btn r3-primary', '开始交谈', '点击后才申请麦克风；先解锁音频，再连接实时语音');
  const connectButton = button('r3-btn', '连接（不启用麦克风）', '只连接服务端并等 ready，可直接发文字，不申请麦克风');
  const stopButton = button('r3-btn', '只停说话', '立即停止本机播放并发送 stop_speech；不取消任务');
  const endButton = button('r3-btn r3-danger', '结束通话', '释放麦克风/音频/连接；不取消任务');
  stopButton.disabled = true;
  endButton.disabled = true;
  actions.append(startButton, connectButton, stopButton, endButton);
  const levelRow = make('div', 'r3-level');
  levelRow.hidden = true;
  const levelBar = make('span', 'r3-level-bar');
  const levelFill = make('i', 'r3-level-fill') as HTMLElement;
  levelBar.append(levelFill);
  levelRow.append(levelBar, make('span', 'r3-level-label', '麦克风电平'));
  const serverLine = make('p', 'r3-server', '未连接。打开页面不会自动联网。');
  const transcriptFold = make('details', 'r3-fold') as HTMLDetailsElement;
  transcriptFold.append(make('summary', undefined, '最近转写'));
  const transcriptList = make('div', 'r3-list');
  transcriptFold.append(transcriptList);
  const metricsFold = make('details', 'r3-fold') as HTMLDetailsElement;
  metricsFold.append(make('summary', undefined, '指标'));
  const metrics = make('div', 'r3-metrics');
  const metricValues = new Map<string, HTMLElement>();

  const metricRow = (key: string, label: string): void => {
    const row = make('div', 'r3-metric');
    const value = make('b', undefined, '—');
    row.append(make('span', undefined, label), value);
    metrics.append(row);
    metricValues.set(key, value);
  };

  metricRow('connect', '连接 → ready');
  metricRow('firstAudio', 'VAD 结束 → 服务端首音频');
  metricRow('playbackStart', 'VAD 结束 → 实际开始播放');
  metricRow('playbackDone', '播放结束 → playback_done');
  const serverMetrics = make('div', 'r3-server-metrics');
  metrics.append(serverMetrics, make('p', 'r3-metric-note', '时间差为本机时钟：首音频=服务端 audio 消息到达，实际播放=按调度时钟估算；未收到用户转写 final 时留 —。'));
  metricsFold.append(metrics);
  const textRow = make('div', 'r3-text');
  const textInput = document.createElement('input');
  textInput.id = 'r3-input';
  textInput.type = 'text';
  textInput.maxLength = 300;
  textInput.placeholder = '文字试问（不启用麦克风，直接发送）';
  const sendButton = button('r3-btn', '发送', '把文字作为 text 消息发给实时服务端');
  textRow.append(textInput, sendButton);
  root.append(head, note, actions, levelRow, serverLine, transcriptFold, metricsFold, textRow);
  app.prepend(root);

  const stateElement = head.querySelector<HTMLElement>('.r3-state')!;
  let ws: WebSocket | null = null;
  let ready = false;
  let ended = false;
  let started = false;
  let starting = false;
  let startedAt = 0;
  let context: AudioContext | null = null;
  let playbackGain: GainNode | null = null;
  let stream: MediaStream | null = null;
  let captureSource: MediaStreamAudioSourceNode | null = null;
  let captureNode: AudioNode | null = null;
  let captureMute: GainNode | null = null;
  let resampler: Resampler24 | null = null;
  let analyser: AnalyserNode | null = null;
  let levelTimer: ReturnType<typeof setInterval> | null = null;
  let lastUserFinalAt: number | null = null;
  let playHead = 0;
  const entries = new Map<string, PlaybackEntry>();
  const doneIds = new Set<string>();
  const serverMetricRows: HTMLElement[] = [];
  let lastTranscript: { key: string; textValue: HTMLElement; final: boolean } | null = null;

  const setState = (phase: 'idle' | 'connecting' | 'ready' | 'error', text: string): void => {
    root.dataset.state = phase;
    stateElement.textContent = text;
  };

  const flash = (text: string): void => {
    serverLine.textContent = text;
  };

  const setMetric = (key: string, value: string): void => {
    const element = metricValues.get(key);

    if (element) element.textContent = value;
  };

  const setLevel = (fraction: number): void => {
    levelFill.style.width = `${Math.max(0, Math.min(100, Math.round(fraction * 100)))}%`;
  };

  const refreshButtons = (): void => {
    const open = ws !== null && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN);
    startButton.disabled = starting || open || stream !== null;
    connectButton.disabled = starting || open || stream !== null;
    stopButton.disabled = !ready;
    endButton.disabled = !open && stream === null;
  };

  const send = (message: ClientMessage): boolean => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(message));

    return true;
  };

  const ensureContext = (): AudioContext | null => {
    if (!context) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

      if (!Ctor) return null;
      context = new Ctor();
      playbackGain = context.createGain();
      playbackGain.connect(context.destination);
      playHead = 0;
    }

    if (context.state === 'suspended') void context.resume().catch(() => undefined);

    return context;
  };

  const stopAllSources = (): void => {
    for (const entry of entries.values()) {
      for (const source of entry.sources) {
        source.onended = null;

        try { source.stop(); } catch { /* 已停止 */ }
      }

      entry.sources.clear();
      entry.notified = true; // 主动停止/清空不补发 playback_done，避免与服务端 clear_audio/stop_speech 打架
    }

    if (context) playHead = context.currentTime;
  };

  const maybeNotifyDone = (responseId: string, entry: PlaybackEntry): void => {
    if (!entry.done || entry.notified || entry.sources.size > 0) return;
    entry.notified = true;
    send({ type: 'playback_done', responseId });

    if (entry.chunks === 0) setMetric('playbackDone', '无音频，直接 playback_done');
    else if (entry.endedAt !== null) setMetric('playbackDone', `${Math.round(performance.now() - entry.endedAt)} ms`);
    window.setTimeout(() => entries.delete(responseId), 5000);
  };

  const ensureEntry = (responseId: string): PlaybackEntry => {
    let entry = entries.get(responseId);

    if (!entry) {
      entry = {
        sources: new Set(),
        done: doneIds.has(responseId),
        notified: false,
        chunks: 0,
        vadAt: lastUserFinalAt,
        firstServerAt: null,
        firstPlayAt: null,
        endedAt: null,
      };
      entries.set(responseId, entry);
    }

    return entry;
  };

  const delta = (stamp: number | null, at: number | null): string => {
    if (at === null) return '—';

    if (stamp === null) return '—（缺用户转写 final 时间）';

    return `${Math.round(at - stamp)} ms`;
  };

  const enqueueAudio = (responseId: string, data: string): void => {
    if (!context || !playbackGain) return;
    const bytes = base64ToBytes(data);
    const count = bytes.length >> 1;

    if (count === 0) return;
    const buffer = context.createBuffer(1, count, MODEL_RATE);
    const channel = buffer.getChannelData(0);

    for (let i = 0; i < count; i++) {
      const lo = bytes[2 * i] ?? 0;
      const hi = bytes[2 * i + 1] ?? 0;
      let value = (hi << 8) | lo;

      if (value & 0x8000) value -= 0x10000;
      channel[i] = value / 32768;
    }

    const entry = ensureEntry(responseId);
    entry.chunks += 1;

    if (entry.firstServerAt === null) {
      entry.firstServerAt = performance.now();
      setMetric('firstAudio', delta(entry.vadAt, entry.firstServerAt));
    }

    if (context.state === 'suspended') void context.resume().catch(() => undefined);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(playbackGain);
    const startAt = Math.max(playHead, context.currentTime + 0.06);
    playHead = startAt + buffer.duration;

    if (entry.firstPlayAt === null) {
      entry.firstPlayAt = performance.now() + (startAt - context.currentTime) * 1000;
      setMetric('playbackStart', delta(entry.vadAt, entry.firstPlayAt));
    }

    entry.sources.add(source);
    source.onended = () => {
      entry.sources.delete(source);
      entry.endedAt = performance.now();
      maybeNotifyDone(responseId, entry);
    };

    source.start(startAt);
  };

  const onResponseDone = (responseId: string): void => {
    doneIds.add(responseId);
    const entry = entries.get(responseId);

    if (!entry) {
      // 整个 response 没有音频：也须通知服务端可以继续。
      const placeholder: PlaybackEntry = {
        sources: new Set(), done: true, notified: false, chunks: 0,
        vadAt: lastUserFinalAt, firstServerAt: null, firstPlayAt: null, endedAt: null,
      };

      entries.set(responseId, placeholder);
      maybeNotifyDone(responseId, placeholder);

      return;
    }

    entry.done = true;
    maybeNotifyDone(responseId, entry);
  };

  const renderTranscript = (message: Extract<ServerMessage, { type: 'transcript' }>): void => {
    const key = `${message.role}:${message.responseId ?? 'none'}`;
    const label = message.role === 'user' ? '你' : '助手';

    if (lastTranscript && lastTranscript.key === key && !lastTranscript.final) {
      lastTranscript.textValue.textContent = message.text;
      lastTranscript.final = message.final;
    } else {
      const item = make('div', 'r3-msg');
      const body = make('span', 'r3-msg-text');
      item.append(make('span', 'r3-role', label), body);
      body.textContent = message.text;
      transcriptList.append(item);
      lastTranscript = { key, textValue: body, final: message.final };

      while (transcriptList.childElementCount > 60) transcriptList.firstElementChild?.remove();
    }

    if (message.role === 'user' && message.final) lastUserFinalAt = performance.now();
  };

  const receive = (raw: string): void => {
    let message: ServerMessage;

    try {
      message = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }

    switch (message.type) {
      case 'ready': {
        ready = true;
        setMetric('connect', `${Math.round(performance.now() - startedAt)} ms`);
        void attachCapture().catch((error: unknown) => fail(`麦克风采集启动失败：${errorText(error)}`));
        setState('ready', stream
          ? `已连接 · ${message.model} · 麦克风已开，可以开始说话`
          : `已连接 · ${message.model} · 未启用麦克风，可发文字`);
        flash('服务端已 ready，本轮可直接听说或发文字。');
        break;
      }

      case 'status':
        flash(`服务端：${message.text}`);
        break;
      case 'transcript':
        renderTranscript(message);
        break;
      case 'audio':
        enqueueAudio(message.responseId, message.data);
        break;
      case 'response_done':
        onResponseDone(message.responseId);
        break;
      case 'clear_audio':
        stopAllSources();
        flash('服务端 clear_audio：已清空本机已排/正在播放的音频。');
        break;
      case 'metric': {
        const row = make('div', 'r3-metric r3-metric-server');
        row.append(make('span', undefined, `服务端 · ${message.name}`), make('b', undefined, `${message.value}${message.unit ? ` ${message.unit}` : ''}`));
        serverMetrics.append(row);
        serverMetricRows.push(row);

        if (serverMetricRows.length > 12) serverMetricRows.shift()?.remove();
        break;
      }

      case 'error':
        fail(`服务端错误：${message.message}`);
        break;
      case 'closed':
        fail('服务端已关闭连接。');
        break;
      default:
        break;
    }

    refreshButtons();
  };

  const releaseCapture = (): void => {
    if (levelTimer !== null) {
      clearInterval(levelTimer);
      levelTimer = null;
    }

    stream?.getTracks().forEach((track) => track.stop());
    stream = null;

    try { captureSource?.disconnect(); } catch { /* 忽略 */ }

    captureSource = null;

    try { captureNode?.disconnect(); } catch { /* 忽略 */ }

    const worklet = typeof AudioWorkletNode !== 'undefined' && captureNode instanceof AudioWorkletNode ? captureNode : null;

    try { worklet?.port.close(); } catch { /* 忽略 */ }

    captureNode = null;

    try { captureMute?.disconnect(); } catch { /* 忽略 */ }

    captureMute = null;
    analyser = null;
    resampler = null;
    setLevel(0);
    levelRow.hidden = true;
  };

  const cleanupSession = (): void => {
    releaseCapture();
    stopAllSources();
    const socket = ws;
    ws = null;

    try { socket?.close(1000, 'client stop'); } catch { /* 忽略 */ }

    if (context) {
      void context.close().catch(() => undefined);
      context = null;
      playbackGain = null;
      playHead = 0;
    }

    entries.clear();
    doneIds.clear();
    ready = false;
    refreshButtons();
  };

  const fail = (message: string): void => {
    ended = true;
    cleanupSession();
    setState('error', message);
    flash('已释放麦克风、播放与连接；可点“开始交谈”或“连接（不启用麦克风）”重试。');
  };

  const tryLoadWorklet = async (audioContext: AudioContext): Promise<boolean> => {
    const config = readConfig();
    const candidates: string[] = [];

    if (config?.workletUrl) candidates.push(config.workletUrl);

    try { candidates.push(new URL('trial-capture-worklet.js', location.href).href); } catch { /* 忽略 */ }

    let blobUrl: string | null = null;

    try {
      blobUrl = URL.createObjectURL(new Blob([REALTIME3_CAPTURE_WORKLET_SOURCE], { type: 'text/javascript' }));
      candidates.push(blobUrl);
    } catch { /* 忽略 */ }

    for (const url of candidates) {
      try {
        await audioContext.audioWorklet.addModule(url);

        if (blobUrl) URL.revokeObjectURL(blobUrl);

        return true;
      } catch { /* 尝试下一个 */ }
    }

    if (blobUrl) URL.revokeObjectURL(blobUrl);

    return false;
  };

  const attachCapture = async (): Promise<void> => {
    if (!context || !stream || captureNode) return;
    const audioContext = context;
    const source = audioContext.createMediaStreamSource(stream);
    const meter = new Float32Array(256);

    const feed = (data: Float32Array): void => {
      // ready 之前、断开之后直接丢弃，不排队，避免积累巨大音频队列。
      if (!ready || ended || !resampler || !ws || ws.readyState !== WebSocket.OPEN) return;

      for (const frame of resampler.push(data)) {
        send({ type: 'audio', data: bytesToBase64(new Uint8Array(frame.buffer)) });
      }
    };

    let worklet: AudioWorkletNode | null = null;

    if (audioContext.audioWorklet && await tryLoadWorklet(audioContext)) {
      try {
        worklet = new AudioWorkletNode(audioContext, 'realtime3-capture');
        worklet.port.onmessage = (event: MessageEvent) => feed(event.data as Float32Array);
      } catch {
        worklet = null;
      }
    }

    // 等待 worklet 加载期间会话可能已结束，此时不再接线，避免资源残留。
    if (ended || context !== audioContext || !stream) {
      try { source.disconnect(); } catch { /* 忽略 */ }

      return;
    }

    if (!worklet) {
      // ScriptProcessor 已废弃，仅作短期兼容；采样转换与 Worklet 路径一致。
      const legacy = audioContext.createScriptProcessor(4096, 1, 1);
      legacy.onaudioprocess = (event: AudioProcessingEvent) => feed(event.inputBuffer.getChannelData(0));
      captureNode = legacy;
      flash('未找到 trial-capture-worklet.js，已回退 ScriptProcessor（已废弃，仅短期兼容）。');
    } else {
      captureNode = worklet;
    }

    const mute = audioContext.createGain();
    mute.gain.value = 0; // 只为让采集节点被拉取，不把麦克风声音外放
    source.connect(captureNode);
    captureNode.connect(mute);
    mute.connect(audioContext.destination);
    resampler = new Resampler24(audioContext.sampleRate / MODEL_RATE);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    captureSource = source;
    captureMute = mute;
    levelRow.hidden = false;
    levelTimer = setInterval(() => {
      if (!analyser) return;
      analyser.getFloatTimeDomainData(meter);
      let sum = 0;

      for (const value of meter) sum += value * value;
      setLevel(Math.sqrt(sum / meter.length) * 5);
    }, 120);
  };

  const start = async (withMicrophone: boolean): Promise<void> => {
    const config = readConfig();

    if (!config) {
      setState('error', '未找到试用配置 __REALTIME3_TRIAL__，请先加载 trial-config.js。');

      return;
    }

    if (starting || (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN))) return;

    // Chrome side panels cannot reliably present the first microphone permission prompt.
    // Reuse the product's explicit full-tab permission page; it records nothing and closes on Done.
    if (withMicrophone) {
      const extension = (globalThis as unknown as {chrome?: {runtime: {getURL(path: string): string}; tabs: {create(options: {url: string}): Promise<unknown>}}}).chrome;

      if (extension) {
        starting = true;

        try {
          const permission = await navigator.permissions.query({name: 'microphone' as PermissionName});

          if (permission.state !== 'granted') {
            await extension.tabs.create({url: extension.runtime.getURL('voice-permission.html')});
            setState('idle', '请在新页授权麦克风，完成后回来点「开始交谈」。');
            flash('授权页只申请权限，不保存录音；点「完成」返回。');

            return;
          }
        } catch (error) { fail(`无法申请麦克风权限：${errorText(error)}`);

 return; }
        finally { starting = false; refreshButtons(); }
      }
    }

    ended = false;
    ready = false;
    started = true;
    starting = true;
    startedAt = performance.now();
    refreshButtons();
    ensureContext(); // 在用户点击内先解锁 AudioContext，再申请麦克风

    if (withMicrophone) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        });
      } catch (error) {
        starting = false;
        fail(`麦克风未授权或不可用：${errorText(error)}`);

        return;
      }
    }

    let socket: WebSocket;

    try {
      socket = new WebSocket(config.url!);
    } catch (error) {
      starting = false;
      fail(`无法创建连接：${errorText(error)}`);

      return;
    }

    starting = false;
    ws = socket;
    setState('connecting', withMicrophone ? '连接中（点击后已请求麦克风）…' : '连接中（不启用麦克风）…');
    flash('等待服务端 ready；ready 之前不发送音频。');
    refreshButtons();
    socket.onopen = () => send({ type: 'auth', token: config.token ?? '' });
    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data === 'string') receive(event.data);
    };

    socket.onerror = () => { if (!ended) fail('连接出错，已释放资源。'); };

    socket.onclose = () => {
      if (ws === socket) ws = null;

      if (!ended) fail('连接已断开，已释放资源。');
      else refreshButtons();
    };
  };

  const stopSpeaking = (): void => {
    const hadSources = [...entries.values()].some((entry) => entry.sources.size > 0);
    stopAllSources();
    send({ type: 'stop_speech' });
    flash(hadSources ? '已停止本机播放并发送 stop_speech；任务不受影响。' : '已发送 stop_speech（当前没有正在播放的声音）；任务不受影响。');
  };

  const endCall = (): void => {
    const wasActive = ws !== null || stream !== null || ready;
    ended = true;
    send({ type: 'stop' });
    cleanupSession();
    setState('idle', wasActive ? '已结束通话；未取消任务，原任务继续。' : '未连接。');
    flash('麦克风、音频与实时连接已释放。');
  };

  const sendText = (): void => {
    const value = textInput.value.trim();

    if (!value) return;

    if (!ready) {
      flash('尚未 ready；先点“连接（不启用麦克风）”或“开始交谈”。');

      return;
    }

    if (send({ type: 'text', text: value })) {
      textInput.value = '';
      flash('已发送文字试问。');
    } else {
      flash('连接不可用，文字未发送。');
    }
  };

  startButton.onclick = () => void start(true);
  connectButton.onclick = () => void start(false);
  stopButton.onclick = stopSpeaking;
  endButton.onclick = endCall;
  sendButton.onclick = sendText;
  textInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') sendText();
  });
  window.addEventListener('pagehide', () => { if (started) endCall(); }, { once: true });

  // 主代理验收钩子：无麦克风即可驱动文字链路。
  (globalThis as unknown as Record<string, unknown>).__r3Trial = {
    connectNoMic: () => void start(false),
    sendText,
    stopSpeaking,
    end: endCall,
    state: () => ({ phase: root.dataset.state ?? 'idle', text: stateElement.textContent }),
  };
}

// 副作用：旧语音入口只在此插件内隐藏（.voice-start 来自 voice-ui.ts；诊断菜单能启动旧语音诊断会话，一并隐藏）。
function hideLegacyVoiceEntries(): void {
  if (document.getElementById('r3-trial-hide')) return;
  const style = document.createElement('style');
  style.id = 'r3-trial-hide';
  style.textContent = '.voice-start, #voice-diagnostics-open { display: none !important; }';
  (document.head ?? document.documentElement).append(style);
}

function boot(attempt = 0): void {
  const app = document.getElementById('app');

  if (!app) {
    if (attempt < 40) window.setTimeout(() => boot(attempt + 1), 250);

    return;
  }

  mountRealtime3Trial(app);
}

(globalThis as unknown as Record<string, unknown>).__REALTIME3_CAPTURE_WORKLET_SOURCE__ = REALTIME3_CAPTURE_WORKLET_SOURCE;

hideLegacyVoiceEntries();

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => boot(), { once: true });
else boot();
