import {GPT_LIVE_MODEL,isVoiceDiagRecord,VOICE_DIAG_TEXT_MAX,type VoiceClientMessage,type VoiceCommand,type VoiceServerMessage,type VoiceEvent,type VoiceInputContext,type VoiceDiagRecord,type StepVoice,type VoicePersona,DEFAULT_VOICE_PERSONA} from '../../../shared/voice.js';
import { VoicePlayer } from './voice-player.js';
import { pcmBase64 } from './voice-signal.js';
import type { VoiceDiagnosticLog, VoiceDiagTrack } from './voice-diagnostic.js';

export type VoicePhase = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error';

/** 会话就绪前最多留多少采样（24 kHz × 15 秒）；超出后不再留，保住最早开口的那段。 */
const PRE_READY_MAX_SAMPLES = 24000 * 15;

/**
 * 补发速度：每 20 ms 发 4 帧（每帧 20 ms），即 4 倍实时。实测整句一次性灌给 StepFun 时，
 * 服务端断句有时认不出开口或一直等不到说完，所以按接近实时的节奏补发。
 */
const BACKLOG_FRAMES_PER_TICK = 4;

/**
 * 本地插话判定：回答播放中，回声消除后的麦克风累计约 240 ms 有人声（约 -38 dBFS 以上）就算用户开口。
 * StepFun 生成回答期间几乎不断句，等它的 speech_started 会一直念下去（OS 项目实测晚 4–5 秒，长回答不来）。
 */
const BARGE_IN_RMS = 0.012;

const BARGE_IN_FRAMES = 12;

/** GPT-Live 建通话的地址与请求头（ChatGPT 登录、quicksilver v2 协议），与前提实验一致。 */
const GPT_LIVE_CALLS = 'https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas';

/** GPT-Live 通话：声音直连 OpenAI，侧栏只转发委派和结果。 */
type LiveCall = {
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  /** 远端声音经它进扬声器；「停声」把它调成 0。 */
  gain: GainNode;
  mic: AnalyserNode;
  /** Chrome 要远端流挂在媒体元素上，Web Audio 才拿得到声音；元素本身静音。 */
  sink: HTMLAudioElement;
  /** 远端声音在静音之前的音量，用来判断助手是否正在出声。 */
  remoteMeter: AnalyserNode;
  remoteTrack: MediaStreamTrack | null;
  turns: Map<string, { role: 'user' | 'assistant'; turn: number; text: string }>;
  delegated: Set<string>;
  assistantTurn: string | null;
  /**
   * stop = 用户点了「停声」，只静音这一段回答；barge = 用户插话，等用户这句说完、GPT-Live 另起一段回答时再放声。
   * 两种都按回答编号放声：服务端插话后常接着念旧回答，旧回答不能再响。
   */
  muted: { reason: 'stop' | 'barge'; turn: string | null; userDone: boolean } | null;
  /** 最近一次听到助手出声的时刻（静音前测）。 */
  audibleAt: number;
  bargeTimer: ReturnType<typeof setInterval> | null;
};

/** 远端声音高于这个音量，算助手正在出声；插话判定只在出声后 0.5 秒内有效。 */
const LIVE_AUDIBLE_RMS = 0.01;

const LIVE_AUDIBLE_HOLD_MS = 500;

/** 可选字段「存在才带上」时按具名类型分步赋值。 */
type CaptureCommand = Extract<VoiceCommand, { kind: "capture" }>;

export class VoiceClient {
  private id: string | null = null;
  private conversationId = '';
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private worklet: AudioWorkletNode | null = null;
  private player: VoicePlayer | null = null;
  private ready = false;
  private serverVad = false;
  private hasInputTurn = false;
  private turn = 0;
  private speaking = false;
  private phase: VoicePhase = 'idle';
  needsMicrophonePermission = false;
  /** 用户在设置页选的音色，下次开启语音时生效。 */
  voice: StepVoice | undefined;
  /** 用户在设置页选的人设，下次开启语音时生效。 */
  persona: VoicePersona = DEFAULT_VOICE_PERSONA;
  /** 用户在设置页选的语音模型，下次开启语音时生效；GPT-Live 走侧栏直连的 WebRTC。 */
  voiceModel: unknown;
  private live: LiveCall | null = null;
  private analyser: AnalyserNode | null = null;
  private inputLevel = 0;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private meter = new Float32Array(256);
  /** 麦克风已开、会话还没就绪时说的话：普通会话就绪后按顺序补发，不丢开口那几秒；补完之前新来的帧排在后面。 */
  private backlog: Int16Array[] = [];
  private backlogSamples = 0;
  private drainTimer: ReturnType<typeof setInterval> | null = null;
  /** 语音服务挂住后自动重连：连上后提示用户刚才那句没听到、请再说一遍。 */
  private sayAgainAfterRecovery = false;
  /** 回答播放中连续有人声的帧数（20 ms 一帧，静音帧扣回）。 */
  private loudFrames = 0;

  /** Diagnostic capture is manual, bounded, and never sends audio before the backend confirms the mode. */
  private diagSession = false;
  private diagConfirmed = false;
  private diagTimer: ReturnType<typeof setTimeout> | null = null;
  private diagWait: ReturnType<typeof setInterval> | null = null;
  private recording = false;
  private pendingAutoRecord = false;
  private frameIndex = 0;
  private sentFrames = 0;
  private trackSettings: VoiceDiagTrack | null = null;

  private userIntentActive = false;
  private recovering = false;
  private recoveryAttempts = 0;
  private recoveryStartTime = 0;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly send: (msg: VoiceClientMessage & {conversationId: string}) => boolean,
    private readonly change: (phase: VoicePhase, detail?: string) => void,
    private readonly event: (event: VoiceEvent) => void,
    private readonly getInput:()=>VoiceInputContext=()=>({}),
    private readonly diagnostic?:(event:string,fields:Record<string,string|number|boolean|null|undefined>)=>void,
    private readonly log?: VoiceDiagnosticLog) {}
  get active(): boolean { return this.id !== null || this.recovering; }
  get diagnosticMode(): boolean { return this.diagSession; }
  get diagnosticConfirmed(): boolean { return this.diagConfirmed; }
  get diagnosticRecording(): boolean { return this.recording; }
  get level(): number {
    if (this.live) {
      const analyser = this.phase === 'speaking' ? this.analyser : this.phase === 'listening' ? this.live.mic : null;

      if (!analyser) return 0;
      analyser.getFloatTimeDomainData(this.meter);

      return Math.min(1, Math.sqrt(this.meter.reduce((s, x) => s + x*x, 0)/this.meter.length)*5);
    }

    if (this.phase === 'speaking' && this.analyser) {
      this.analyser.getFloatTimeDomainData(this.meter);

      return Math.min(1, Math.sqrt(this.meter.reduce((s, x) => s + x*x, 0)/this.meter.length)*5);
    }

    return this.phase === 'listening' ? Math.min(1, this.inputLevel*5) : 0;
  }
  private setPhase(phase: VoicePhase, detail?: string): void { this.phase = phase; this.change(phase, detail); }
  private command(command: VoiceCommand): boolean {
    if (this.id) {
      const ok = this.send({type:'voice',voiceId:this.id,conversationId:this.conversationId,command});

      if (!ok) {
        this.onTransportDisconnected();

        return false;
      }

      return true;
    }

    return false;
  }
  async start(conversationId: string, diagnostic = false): Promise<void> {
    if (this.id) return;
    this.needsMicrophonePermission = false;
    this.userIntentActive = true;
    this.conversationId = conversationId;
    this.turn = 0;
    this.serverVad = false;
    this.hasInputTurn = false;
    this.diagSession = diagnostic;
    this.diagConfirmed = false;
    this.recording = false;
    this.frameIndex = 0;
    this.sentFrames = 0;
    this.dropBacklog();
    const id = crypto.randomUUID(); this.id=id;
    this.log?.sessionStarted({voiceId:id,conversationId,diagnostic});
    this.setPhase('connecting', this.recovering ? '正在恢复语音连接…' : '正在开启麦克风');

    if (this.connectTimer) clearTimeout(this.connectTimer);

    // Bounded connect timeout: during recovery, respect 30s total budget (max 8s/attempt),
    // and if silent timeout occurs without ready, retry within budget instead of failing immediately.
    // Initial start keeps original 45s for microphone permission authorization.
    const remainingBudget = this.recovering ? Math.max(1000, 30_000 - (Date.now() - this.recoveryStartTime)) : 45000;
    const attemptTimeout = this.recovering ? Math.min(8000, remainingBudget) : 45000;
    this.connectTimer=setTimeout(()=>{
      if(this.id===id){
        if(this.recovering){
          this.id=null;
          this.scheduleRecovery('连接超时，正在重试…');
        } else {
          this.fail('语音开启超时，请重试。');
        }
      }
    },attemptTimeout);

    const bindTrackListeners = (stream: MediaStream) => {
      stream.getTracks().forEach(t => {
        t.onended = () => {
          if (this.id === id) this.fail('麦克风已断开，请重试。');
        };
      });
      const settings=stream.getAudioTracks?.()[0]?.getSettings?.();
      this.trackSettings=settings?{
        sampleRate:Number(settings.sampleRate??this.context?.sampleRate??24000),
        channelCount:Number(settings.channelCount??1),
        echoCancellation:settings.echoCancellation===true,
        noiseSuppression:settings.noiseSuppression===true,
        autoGainControl:settings.autoGainControl===true,
      }:null;
    };

    if (this.voiceModel === GPT_LIVE_MODEL && !diagnostic) {
      await this.startLive(id, bindTrackListeners);

      return;
    }

    // Reuse existing microphone stream and context if still live
    if (this.context && this.context.state !== 'closed' && this.stream && this.stream.getTracks().some(t => t.readyState === 'live') && this.worklet && this.analyser) {
      try {
        if (this.context.state === 'suspended') await this.context.resume();

        if (this.id !== id) return;
        // Re-bind track listeners to the current session id
        bindTrackListeners(this.stream);
        this.player?.stop();
        this.player = new VoicePlayer(this.context, responseId => {
          if (this.id === id) {
            this.command({ kind: 'playback_done', responseId });

            if (!this.speaking) this.setPhase('listening');
          }
        }, this.analyser);

        // The old capture callback is session-bound and cannot submit into this turn.
        this.command(this.startCommand());
        this.worklet.port.onmessage = ({ data }) => this.onCaptureFrame(id, data);

        return;
      } catch {
        // Fall back to full initialization if reuse fails: release failing resources first
        if (this.worklet) { this.worklet.port.onmessage = null; this.worklet.disconnect(); this.worklet = null; }

        this.stream?.getTracks().forEach(t => { t.onended = null; t.stop(); }); this.stream = null;
        this.player?.stop(); this.player = null;
        this.analyser?.disconnect(); this.analyser = null;

        if (this.context) void this.context.close().catch(() => {}); this.context = null;
      }
    }

    try {
      const context = new AudioContext({sampleRate:24000}); this.context=context;
      await context.resume();

      if (this.id!==id) return;

      if(context.sampleRate!==24000) throw new Error('sample rate');
      const stream = await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true}});

      if(this.id!==id){stream.getTracks().forEach(t=>t.stop());

return;}

      this.stream=stream;
      bindTrackListeners(stream);
      await context.audioWorklet.addModule(chrome.runtime.getURL('voice-worklet.js'));

      if(this.id!==id)return;
      this.analyser=context.createAnalyser();this.analyser.fftSize=256;this.analyser.connect(context.destination);
      this.player=new VoicePlayer(context,responseId=>{if(this.id===id){this.command({kind:'playback_done',responseId});

if(!this.speaking)this.setPhase('listening');}},this.analyser);

      const worklet=new AudioWorkletNode(context,'voice-capture');this.worklet=worklet;
      worklet.port.onmessage=({data})=>this.onCaptureFrame(id,data);
      context.createMediaStreamSource(stream).connect(worklet);worklet.connect(context.destination);
      this.command(this.startCommand());
    } catch(error) {
      if(this.id===id)this.needsMicrophonePermission=error instanceof DOMException && error.name==='NotAllowedError';

      if(this.id===id)this.fail(error instanceof DOMException && error.name==='NotAllowedError'?'未获得麦克风权限，请允许后重试。':'麦克风未能启动，请检查设备后重试。');
    }
  }

  /** GPT-Live：先开麦克风，再请宿主取 ChatGPT 登录令牌；令牌到了才建通话（connectLive）。 */
  private async startLive(id: string, bindTrackListeners: (stream: MediaStream) => void): Promise<void> {
    try {
      // 断线恢复时沿用还开着的麦克风和 AudioContext，不另开一份。
      if (this.context && this.context.state !== 'closed' && this.stream?.getTracks().some(t => t.readyState === 'live')) {
        await this.context.resume();

        if (this.id !== id) return;
        bindTrackListeners(this.stream);
        this.command(this.startCommand());

        return;
      }

      const context = new AudioContext(); this.context = context;
      await context.resume();

      if (this.id !== id) return;
      const stream = await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true}});

      if (this.id !== id) { stream.getTracks().forEach(t => t.stop());

 return; }

      this.stream = stream;
      bindTrackListeners(stream);
      this.command(this.startCommand());
    } catch (error) {
      if (this.id === id) this.needsMicrophonePermission = error instanceof DOMException && error.name === 'NotAllowedError';

      if (this.id === id) this.fail(error instanceof DOMException && error.name === 'NotAllowedError' ? '未获得麦克风权限，请允许后重试。' : '麦克风未能启动，请检查设备后重试。');
    }
  }
  /** 照前提实验建 WebRTC：本地麦克风上行，远端声音播放，oai-events 数据通道收发事件。令牌只用于这一次请求。 */
  private async connectLive(id: string, auth: Extract<VoiceEvent, { kind: 'gpt_live_auth' }>): Promise<void> {
    const context = this.context, stream = this.stream;

    if (this.id !== id || this.live || !context || !stream || this.voiceModel !== GPT_LIVE_MODEL) return;
    const pc = new RTCPeerConnection();
    const dc = pc.createDataChannel('oai-events');
    const gain = context.createGain();
    const mic = context.createAnalyser(); mic.fftSize = 256;
    context.createMediaStreamSource(stream).connect(mic);
    this.analyser = context.createAnalyser(); this.analyser.fftSize = 256;
    gain.connect(this.analyser); this.analyser.connect(context.destination);
    const sink = new Audio(); sink.muted = true;
    const remoteMeter = context.createAnalyser(); remoteMeter.fftSize = 256;
    const live: LiveCall = { pc, dc, gain, mic, sink, remoteMeter, remoteTrack: null, turns: new Map(), delegated: new Set(), assistantTurn: null, muted: null, audibleAt: 0, bargeTimer: null };
    this.live = live;
    live.bargeTimer = setInterval(() => this.watchLiveBargeIn(live), 20);
    stream.getTracks().forEach(t => pc.addTrack(t, stream));
    pc.ontrack = ({ streams: [remote] }) => {
      if (!remote || this.live !== live) return;
      sink.srcObject = remote; void sink.play().catch(() => {});
      live.remoteTrack = remote.getAudioTracks()[0] ?? null;
      const source = context.createMediaStreamSource(remote);
      source.connect(gain); source.connect(remoteMeter);
    };
    pc.onconnectionstatechange = () => { if (this.live === live && pc.connectionState === 'failed') this.scheduleRecovery('GPT-Live 连接断开，正在恢复…'); };
    dc.onmessage = ({ data }) => { try { this.onLiveEvent(live, JSON.parse(String(data))); } catch { /* 不认识的事件不影响通话 */ } };

    try {
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise(done => { if (pc.iceGatheringState === 'complete') done(0); pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && done(0); setTimeout(done, 3000); });

      if (this.live !== live) return;
      const session = () => crypto.randomUUID();
      const response = await fetch(GPT_LIVE_CALLS, { method: 'POST',
        headers: { Authorization: `Bearer ${auth.access}`, 'chatgpt-account-id': auth.accountId, 'OpenAI-Alpha': 'quicksilver=v2', 'session-id': session(), 'thread-id': session(), 'x-session-id': session(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdp: pc.localDescription?.sdp, session: { model: GPT_LIVE_MODEL, instructions: auth.instructions, audio: { output: { voice: 'cove' } }, delegation: { type: 'client' } } }) });

      if (this.live !== live) return;

      if (!response.ok) {
        this.fail(response.status === 401 || response.status === 403 ? 'ChatGPT 登录已失效：请在设置里重新登录后再开启语音。' : `GPT-Live 没有接通（${response.status}），请稍后重试。`);

        return;
      }

      await pc.setRemoteDescription({ type: 'answer', sdp: await response.text() });

      if (dc.readyState !== 'open') await new Promise(done => { dc.onopen = done; });

      if (this.live === live) this.command({ kind: 'gpt_live_connected' });
    } catch {
      if (this.live === live) this.fail('GPT-Live 没有接通，请检查网络后重试。');
    }
  }
  /** GPT-Live 数据通道事件：转写进字幕，委派交给宿主，服务端切掉声音时回到在听。 */
  private onLiveEvent(live: LiveCall, e: { type?: string; turn?: { id?: string; role?: string; transcript?: string }; turn_id?: string; delta?: string; item?: { id?: string; content?: Array<{ type?: string; text?: string }> } }): void {
    if (this.live !== live) return;
    const turn = e.turn;

    if (e.type === 'turn.created' && turn?.id) {
      const role = turn.role === 'user' ? 'user' : 'assistant';

      if (role === 'user') this.turn++;
      live.turns.set(turn.id, { role, turn: this.turn, text: turn.transcript ?? '' });

      if (role === 'assistant') {
        live.assistantTurn = turn.id;

        // 新的一段回答不在「停声」范围里；插话后，用户那句说完再开口的回答也放声。
        if (live.muted && live.muted.turn !== turn.id && (live.muted.reason === 'stop' || live.muted.userDone)) this.unmuteLive(live);
        this.showLiveAnswer(live, turn.id);
      }

      return;
    }

    if (e.type === 'turn.delta' && e.turn_id) {
      const known = live.turns.get(e.turn_id);

      if (known?.role !== 'assistant') return;
      known.text += e.delta ?? '';
      this.showLiveAnswer(live, e.turn_id);

      return;
    }

    if (e.type === 'turn.done' && turn?.id) {
      const known = live.turns.get(turn.id);
      live.turns.delete(turn.id);

      if (turn.role === 'user' && turn.transcript) this.event({ kind: 'text', turn: known?.turn ?? this.turn, role: 'user', text: turn.transcript });

      if (turn.role === 'user' && live.muted?.reason === 'barge') {
        live.muted.userDone = true;

        // 回应可能先于用户这句的结束事件开始。
        if (live.assistantTurn && live.assistantTurn !== live.muted.turn) this.unmuteLive(live);
      }

      if (turn.role === 'assistant') {
        if (turn.transcript) this.event({ kind: 'text', turn: known?.turn ?? this.turn, role: 'assistant', text: turn.transcript });

        if (live.assistantTurn === turn.id) { live.assistantTurn = null; this.setPhase('listening'); }
      }

      return;
    }

    if (e.type === 'output_audio_buffer.cleared') {
      this.setPhase('listening');

      return;
    }

    if (e.type === 'delegation.created' && e.item?.id && !live.delegated.has(e.item.id)) {
      live.delegated.add(e.item.id);
      const text = (e.item.content ?? []).filter(part => part.type === 'input_text').map(part => part.text ?? '').join('').trim();

      if (text) this.command({ kind: 'delegation', delegationId: e.item.id, text });
    }
  }
  private showLiveAnswer(live: LiveCall, turnId: string): void {
    const known = live.turns.get(turnId);

    if (known?.text) this.event({ kind: 'text', turn: known.turn, role: 'assistant', text: known.text });

    if (!live.muted && this.phase !== 'speaking') this.setPhase('speaking');
  }
  /**
   * GPT-Live 的服务端停声慢（实测 4 秒以上，念任务结果时 6 秒内不停），所以侧栏本地判断插话：
   * 助手刚出过声，且回声消除后的麦克风连续有人声，就立即静音远端声音。判定阈值与套餐语音相同；任务不受影响。
   */
  private watchLiveBargeIn(live: LiveCall): void {
    if (this.live !== live || !this.ready) return;
    const rms = (analyser: AnalyserNode) => { analyser.getFloatTimeDomainData(this.meter);

 return Math.sqrt(this.meter.reduce((s, x) => s + x*x, 0)/this.meter.length); };

    if (rms(live.remoteMeter) > LIVE_AUDIBLE_RMS && live.remoteTrack?.enabled !== false) live.audibleAt = Date.now();

    if (live.muted || Date.now() - live.audibleAt > LIVE_AUDIBLE_HOLD_MS) {
      this.loudFrames = 0;

      return;
    }

    const level = rms(live.mic);
    this.loudFrames = level > BARGE_IN_RMS ? this.loudFrames + 1 : Math.max(0, this.loudFrames - 1);

    if (this.loudFrames < BARGE_IN_FRAMES) return;
    this.loudFrames = 0;
    this.muteLive(live, { reason: 'barge', turn: live.assistantTurn, userDone: false });
    this.diagnostic?.('local_barge_in', { turn: this.turn, rms: level });
    this.setPhase('listening');
  }
  /** 关掉远端音轨本身（不只是本地音量），侧栏里任何地方收到的远端声音都变成静音。 */
  private muteLive(live: LiveCall, muted: NonNullable<LiveCall['muted']>): void {
    live.muted = muted;
    live.gain.gain.value = 0;

    if (live.remoteTrack) live.remoteTrack.enabled = false;
  }
  private unmuteLive(live: LiveCall): void {
    live.muted = null;
    live.gain.gain.value = 1;

    if (live.remoteTrack) live.remoteTrack.enabled = true;
  }
  private closeLive(): void {
    const live = this.live;

    if (!live) return;
    this.live = null;
    live.dc.onmessage = null; live.pc.ontrack = null; live.pc.onconnectionstatechange = null;
    live.pc.close();
    live.sink.srcObject = null;
    if (live.bargeTimer) clearInterval(live.bargeTimer);
    live.gain.disconnect(); live.mic.disconnect(); live.remoteMeter.disconnect();
    this.analyser?.disconnect(); this.analyser = null;
  }

  /** One place where a raw 24k frame arrives. */
  private onCaptureFrame(id: string, data: { pcm: ArrayBuffer; rms: number }): void {
    if (this.id !== id) return;
    const source = new Int16Array(data.pcm);

    // 诊断会话只在服务端确认后录音，就绪前的声音不留。
    if (!this.ready) {
      if (!this.diagSession && this.backlogSamples + source.length <= PRE_READY_MAX_SAMPLES) {
        this.backlog.push(source);
        this.backlogSamples += source.length;
      }

      return;
    }

    this.inputLevel = data.rms;
    this.watchBargeIn(data.rms);

    if (this.drainTimer) {
      this.backlog.push(source);

      return;
    }

    if (this.recording) this.captureDiagnosticFrame(source);

    if(this.serverVad&&!this.diagSession)this.command({kind:'audio',turn:this.turn,data:pcmBase64(source)});
  }
  private watchBargeIn(rms: number): void {
    if (!this.serverVad || this.diagSession || !this.player?.playing) {
      this.loudFrames = 0;

      return;
    }

    this.loudFrames = rms > BARGE_IN_RMS ? this.loudFrames + 1 : Math.max(0, this.loudFrames - 1);

    if (this.loudFrames < BARGE_IN_FRAMES) return;
    this.loudFrames = 0;
    this.player.stop();
    this.command({ kind: 'barge_in', turn: this.turn });
    this.diagnostic?.('local_barge_in', { turn: this.turn, rms });
    this.setPhase('listening');
  }
  /** 就绪后把就绪前留下的声音按到达顺序、按 4 倍实时发给服务端，由服务端照常断句。 */
  private drainBacklog(): void {
    if (!this.serverVad || this.diagSession || this.backlog.length === 0) {
      this.dropBacklog();

      return;
    }

    if (this.drainTimer) return;

    this.drainTimer = setInterval(() => {
      const frames = this.backlog.splice(0, BACKLOG_FRAMES_PER_TICK);
      const samples = new Int16Array(frames.reduce((sum, frame) => sum + frame.length, 0));
      let offset = 0;
      for (const frame of frames) {
        samples.set(frame, offset);
        offset += frame.length;
      }
      if (samples.length) this.command({ kind: 'audio', turn: this.turn, data: pcmBase64(samples) });

      if (this.backlog.length === 0) this.dropBacklog();
    }, 20);
  }
  private dropBacklog(): void {
    if (this.drainTimer) clearInterval(this.drainTimer);
    this.drainTimer = null;
    this.backlog = [];
    this.backlogSamples = 0;
  }
  /** Normal sessions do not persist PCM. Diagnostic capture is an explicit second mode. */
  private startCommand(): VoiceCommand {
    if (this.diagSession) return { kind: 'start', diagnostic: true };
    const command: Extract<VoiceCommand, { kind: 'start' }> = { kind: 'start' };

    if (this.voice) command.voice = this.voice;

    // 宿主按自己收到的设置开会话；两边不一致时宿主拒绝，不会在选了 GPT-Live 时连上阶跃星辰。
    if (typeof this.voiceModel === 'string') command.model = this.voiceModel;

    if (this.persona.id !== 'default') command.persona = this.persona;

    return command;
  }
  /** The panel's rendered question text, sent once it is assigned; the agent keeps its own server record. */
  captureDisplay(turn: number, text: string): boolean {
    if (this.diagSession || !this.id || !text.trim()) return false;

    return this.command({ kind: 'capture', turn, displayText: text.slice(0, VOICE_DIAG_TEXT_MAX) });
  }
  /** “这条不对”: one command about the most recent turn, with no input and no change to voice state. */
  markLatest(note?: string): { ok: boolean; turn: number; detail?: string } {
    const turn = this.turn;

    if (!this.id) return { ok: false, turn, detail: '语音未开启，标记未发送。' };

    if (!turn || this.serverVad&&!this.hasInputTurn) return { ok: false, turn, detail: '还没有可标记的一轮，先说一句再标记。' };
    const capture: CaptureCommand = { kind: 'capture', turn, mark: true };

    if (note) capture.note = note;
    const ok = this.command(capture);

    return ok ? { ok: true, turn } : { ok: false, turn, detail: '语音连接未就绪，标记未发送。' };
  }
  private captureDiagnosticFrame(source: Int16Array): void {
    if (!this.diagSession || !this.diagConfirmed || !this.recording) return;
    const bounded = this.log?.captureFrame(Int16Array.from(source)) ?? 'ignored';

    if (bounded === 'full') { this.endDiagnosticRecording('limit'); this.awaitTranscriptThenStop();

 return; }

    if (this.command({ kind: 'audio', turn: this.turn, data: pcmBase64(source), frame: this.frameIndex })) {
      this.frameIndex++; this.sentFrames++;
    }
  }
  /** Opens a diagnostic session; capture starts only after the backend confirms the same voice id. */
  async startDiagnostic(conversationId: string): Promise<void> {
    if (this.id) return;
    this.pendingAutoRecord = true;
    await this.start(conversationId, true);
  }
  beginDiagnosticRecording(): { ok: boolean; detail?: string } {
    if (!this.diagSession) return { ok: false, detail: '未处于诊断模式。' };

    if (!this.diagConfirmed) return { ok: false, detail: '服务端尚未确认诊断模式，未发送音频。' };

    if (!this.id || !this.ready) return { ok: false, detail: '语音会话未就绪，请等待连接。' };

    if (this.recording) return { ok: false, detail: '已在录音。' };
    this.turn += 1;
    this.frameIndex = 0;
    this.sentFrames = 0;
    this.log?.captureStarted({ turn: this.turn, sampleRate: this.context?.sampleRate ?? 24000, track: this.trackSettings });
    this.recording = true;
    this.speaking = false;
    this.command({ kind: 'interrupt', turn: this.turn });
    this.setPhase('listening', `诊断录音中（上限 ${this.log?.limitSeconds ?? 60} 秒）`);
    this.diagnostic?.('diag_capture_start', { turn: this.turn });

    return { ok: true };
  }
  endDiagnosticRecording(reason: 'manual' | 'limit' | 'transport' = 'manual'): void {
    if (!this.recording) return;
    this.recording = false;
    this.log?.captureEnded(reason);

    if (this.sentFrames > 0 && this.id && this.ready) this.command({ kind: 'commit', turn: this.turn });
    this.setPhase('thinking', reason === 'limit' ? '已达时长上限，正在等待本轮转写' : '正在识别');
    this.diagnostic?.('diag_capture_end', { turn: this.turn, reason, frames: this.sentFrames });
  }
  /**
   * Ends the take now and closes the session once this turn's transcript arrived, or the bounded wait expires.
   * The upstream commit needs the session alive to answer; a timeout is reported, never hidden.
   */
  finishDiagnostic(maxMs = 12000): void {
    this.endDiagnosticRecording('manual');
    this.awaitTranscriptThenStop(maxMs);
  }
  /** Waits for this turn's transcript with a bound, then closes the session; a timeout is reported, never hidden. */
  private awaitTranscriptThenStop(maxMs = 12000): void {
    if (this.diagWait) { clearInterval(this.diagWait); this.diagWait = null; }

    const turn = this.turn;
    const startedAt = Date.now();

    const timer = setInterval(() => {
      const capture = this.log?.captures().find(c => c.turn === turn);
      const waited = Date.now() - startedAt;

      if (capture?.rawAsr || waited >= maxMs) {
        clearInterval(timer);

        if (this.diagWait === timer) this.diagWait = null;

        if (!capture?.rawAsr) this.log?.noteCapture(turn, 'transcript_timeout', '本轮上游未在等待时限内返回转写。');

        if (this.active) this.stop();
      }
    }, 500);

    this.diagWait = timer;
  }
  scheduleRecovery(detail = '语音连接已断开，正在恢复…'): void {
    if (!this.userIntentActive) return;

    if (this.needsMicrophonePermission) return;

    // A diagnostic take that lost the transport is marked incomplete; it is never silently resumed.
    if (this.diagSession) {
      this.endDiagnosticRecording('transport');
      this.log?.noteCapture(this.turn, 'transport_gap', '诊断录音期间连接中断，本次记录未完成。');
      this.fail('诊断录音连接中断，本次记录未完成，请重试。');

      return;
    }

    if (this.recoveryStartTime === 0) {
      this.recoveryStartTime = Date.now();
    }

    const elapsed = Date.now() - this.recoveryStartTime;

    if (this.recoveryAttempts >= 3 || elapsed >= 30_000) {
      this.diagnostic?.('voice_recovery_exhausted', { turn: this.turn, attempt: this.recoveryAttempts, at: performance.now() });
      this.fail('语音连接未能恢复，请重试。');

      return;
    }

    this.recovering = true;

    if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }

    if (this.recoveryTimer) { clearTimeout(this.recoveryTimer); this.recoveryTimer = null; }

    this.id = null;
    this.ready = false;
    this.dropBacklog();
    this.speaking = false;
    this.player?.stop();
    this.closeLive();
    this.setPhase('connecting', detail);
    this.diagnostic?.('voice_recovering', { turn: this.turn, attempt: this.recoveryAttempts, at: performance.now() });

    const remaining = Math.max(100, 30_000 - elapsed);
    const delay = Math.min(remaining, Math.min(4000, 1000 * Math.pow(2, this.recoveryAttempts)));
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      void this.executeRecovery();
    }, delay);
  }

  private async executeRecovery(): Promise<void> {
    if (!this.userIntentActive || !this.recovering) return;

    if (this.id !== null) return; // already in flight
    const elapsed = Date.now() - this.recoveryStartTime;

    if (this.recoveryAttempts >= 3 || elapsed >= 30_000) {
      this.fail('语音连接未能恢复，请重试。');

      return;
    }

    this.recoveryAttempts++;
    this.diagnostic?.('voice_reconnect_attempt', { turn: this.turn, attempt: this.recoveryAttempts, at: performance.now() });
    await this.start(this.conversationId, this.diagSession);
  }

  onTransportDisconnected(): void {
    if (!this.userIntentActive) return;
    this.scheduleRecovery('语音连接已断开，正在恢复…');
  }

  onTransportReady(): void {
    if (this.userIntentActive && this.recovering) {
      // Guard against duplicate connected events consuming attempts while an attempt is in flight
      if (this.id !== null) return;

      if (this.recoveryTimer) {
        clearTimeout(this.recoveryTimer);
        this.recoveryTimer = null;
      }

      void this.executeRecovery();
    }
  }

  private onDiagRecord(record: VoiceDiagRecord): void {
    if(!isVoiceDiagRecord(record))return;

    // Normal sessions persist their evidence on the agent; this in-panel log mirrors manual takes only.
    if(!this.diagSession)return;
    this.log?.apply(record);

    if (record.type !== 'ready') return;
    this.diagConfirmed = true;

    if (this.diagTimer) { clearTimeout(this.diagTimer); this.diagTimer = null; }

    this.diagnostic?.('diag_confirmed', { maxSeconds: record.maxSeconds, sampleRate: record.sampleRate });

    if (this.pendingAutoRecord) { this.pendingAutoRecord = false; this.beginDiagnosticRecording(); }
  }
  private failUnconfirmed(): void {
    this.diagTimer = null;
    this.log?.note('diag_unconfirmed', '服务端未确认诊断模式，本次没有发送任何音频。');
    this.fail('当前后端未确认诊断模式，本次没有发送音频。');
  }

  receive(message: VoiceServerMessage & {conversationId?:string}): void {
    if(message.voiceId!==this.id||message.conversationId!==this.conversationId)return;
    const e=message.event;

    if(e.kind==='diag'){this.onDiagRecord(e.record);

return;}

    // GPT-Live：令牌到了就建通话；宿主为一次委派开的一轮按原握手补页面资料；结果写进数据通道。
    if(e.kind==='gpt_live_auth'){void this.connectLive(message.voiceId,e);

return;}

    if(e.kind==='delegation_context'){
      if(this.live?.dc.readyState==='open')this.live.dc.send(JSON.stringify({type:'delegation.context.append',delegation_item_id:e.delegationId,channel:e.channel,content:[{type:'input_text',text:e.text}]}));

      return;
    }

    if(e.kind==='input_turn'&&this.live){this.command({kind:'commit',turn:e.turn,input:this.getInput()});

return;}

    if(e.kind==='input_turn'){
      if(!this.serverVad||this.diagSession||e.turn<=this.turn)return;

      // 服务端听到用户开口：旧回答立即停播（本地没听出来时的兜底）。
      if(this.player?.playing){this.player.stop();this.setPhase('listening');}

      this.turn=e.turn;this.hasInputTurn=true;this.player?.follow(this.turn);
      const input=this.getInput();this.command({kind:'commit',turn:this.turn,input});

      return;
    }

    if(e.kind==='state'){
      if(e.state==='error'){
        if(e.recoverable && this.userIntentActive && !this.needsMicrophonePermission) {
          this.sayAgainAfterRecovery = e.sayAgain === true;
          this.scheduleRecovery(e.detail ?? '语音连接已断开，正在恢复…');

          return;
        }

        this.fail(e.detail??'语音连接失败，请重试。');

        return;
      }

      if(e.state==='closed'){
        if(this.userIntentActive && !this.recovering) {
          this.scheduleRecovery('语音连接已关闭，正在重新连接…');

          return;
        }

        this.stop(false);

        return;
      }

      if(e.state==='ready'){
        this.serverVad=e.inputMode==='server_vad'||this.serverVad;

        if(this.serverVad){this.turn=Math.max(1,this.turn);this.player?.follow(this.turn);}

        if(this.connectTimer)clearTimeout(this.connectTimer);
        this.ready=true;
        this.drainBacklog();
        this.recovering=false;
        this.recoveryAttempts=0;
        this.recoveryStartTime=0;

        if(this.recoveryTimer){clearTimeout(this.recoveryTimer);this.recoveryTimer=null;}

        if(!this.speaking&&this.phase!=='speaking')this.setPhase('listening',this.sayAgainAfterRecovery?'刚才语音服务没有响应，请再说一遍':e.detail);

        this.sayAgainAfterRecovery=false;
        this.diagnostic?.('voice_recovered', { turn: this.turn, attempt: this.recoveryAttempts, at: performance.now() });

        // An older backend never confirms diagnostic mode; refuse to send audio instead of guessing.
        if(this.diagSession&&!this.diagConfirmed&&!this.diagTimer)this.diagTimer=setTimeout(()=>{if(this.diagSession&&!this.diagConfirmed)this.failUnconfirmed();},8000);
      }

      if(e.state==='answering')this.setPhase('thinking',e.detail??'正在处理这句话');

      if(e.state==='connecting')this.setPhase('connecting',e.detail??'正在连接语音');

      return;
    }

    // A diagnostic session must never answer or play: anything the backend still sends is dropped here too.
    if(this.diagSession&&(e.kind==='audio'||e.kind==='reset_output'||e.kind==='response_end'||e.kind==='text'&&e.role==='assistant'))return;

    // 上一轮晚到的用户转写只用于显示（被切开的前半句），其余旧轮次事件一律丢弃。
    if(e.kind==='text'&&e.role==='user'&&e.turn===this.turn-1){
      this.event(e);

      return;
    }

    if(e.turn!==this.turn)return;

    if(e.kind==='reset_output'){this.player?.stop();this.player?.begin(this.turn);}
    else if(e.kind==='audio'){this.player?.enqueue(e);this.setPhase('speaking');}
    else if(e.kind==='response_end')this.player?.responseEnd(e.responseId);
    else this.event(e);
  }
  stopSpeaking():void{
    if(!this.id||!this.ready)return;

    // GPT-Live 协议里没有取消回答的事件：只把这一段回答在本地静音，任务照常。
    if(this.live){this.muteLive(this.live,{reason:'stop',turn:this.live.assistantTurn,userDone:false});this.setPhase('listening','已停声，后台任务继续');

return;}
    this.player?.stop();this.command({kind:'interrupt',turn:this.turn});
    this.setPhase('listening','已停声，后台任务继续');
  }
  fail(detail: string): void {
    this.userIntentActive = false;
    this.recovering = false;

    if(this.recoveryTimer){clearTimeout(this.recoveryTimer);this.recoveryTimer=null;}

    this.stop();
    this.setPhase('error',detail);
  }
  stop(notify=true): void {
    this.userIntentActive = false;
    this.recovering = false;
    this.recoveryAttempts = 0;
    this.recoveryStartTime = 0;

    if(this.recoveryTimer){clearTimeout(this.recoveryTimer);this.recoveryTimer=null;}

    if(this.diagTimer){clearTimeout(this.diagTimer);this.diagTimer=null;}

    if(this.diagWait){clearInterval(this.diagWait);this.diagWait=null;}

    if(this.recording){this.recording=false;this.log?.captureEnded('stopped');}

    this.pendingAutoRecord=false;

    if(this.connectTimer)clearTimeout(this.connectTimer);this.connectTimer=null;
    const id=this.id;this.id=null;this.ready=false;this.speaking=false;this.inputLevel=0;
    this.dropBacklog();

    if(id&&notify)this.send({type:'voice',voiceId:id,conversationId:this.conversationId,command:{kind:'stop'}});

    this.closeLive();

    if(this.worklet){this.worklet.port.onmessage=null;this.worklet.disconnect();this.worklet=null;}

    this.stream?.getTracks().forEach(t=>{t.onended=null;t.stop();});this.stream=null;
    this.player?.stop();this.player=null;this.analyser?.disconnect();this.analyser=null;

    if(this.context)void this.context.close().catch(()=>{});this.context=null;
    this.setPhase('idle');
  }
}
