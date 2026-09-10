import {isVoiceDiagRecord,VOICE_DIAG_MAX_SECONDS,VOICE_DIAG_SAMPLE_RATE,VOICE_DIAG_TEXT_MAX,type VoiceClientMessage,type VoiceCommand,type VoiceServerMessage,type VoiceEvent,type VoiceInputContext,type VoiceDiagRecord} from '../../../shared/voice.js';
import { SpeechClassifier } from './voice-speech.js';
import { VoicePlayer } from './voice-player.js';
import { VoiceTurnDetector, pcmBase64, pcmBase64Large } from './voice-signal.js';
import type { VoiceDiagnosticLog, VoiceDiagTrack } from './voice-diagnostic.js';
export type VoicePhase = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error';
export class VoiceClient {
  private id: string | null = null;
  private conversationId = '';
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private worklet: AudioWorkletNode | null = null;
  private speechClassifier: SpeechClassifier | null = null;
  private player: VoicePlayer | null = null;
  private ready = false;
  private turn = 0;
  private speaking = false;
  private phase: VoicePhase = 'idle';
  needsMicrophonePermission = false;
  private analyser: AnalyserNode | null = null;
  private inputLevel = 0;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private meter = new Float32Array(256);

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

  /** Normal-use C0: the same continuous 24k PCM, accumulated per turn and sent once when the turn ends. */
  private captureTurn = 0;
  private capturePrefix: Int16Array[] = [];
  private captureFrames: Int16Array[] = [];
  private captureSamples = 0;
  private captureCapped = false;

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
    this.diagSession = diagnostic;
    this.diagConfirmed = false;
    this.recording = false;
    this.frameIndex = 0;
    this.sentFrames = 0;
    this.resetCapture();
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
        const detector = new VoiceTurnDetector({
          start: turn => {
            this.diagnostic?.('speech_detected', { turn, at: performance.now(), audioTime: this.context?.currentTime });
            this.turn = turn;
            this.speaking = true;
            this.beginCaptureTurn(turn);
            const played = this.player?.begin(turn);
            this.diagnostic?.('playback_stopped', { turn, at: performance.now() });
            this.command({ kind: 'interrupt', turn, ...(played ? { played } : {}) });
            if (this.id === id) this.setPhase('listening');
          },
          audio: (turn, pcm) => this.command({ kind: 'audio', turn, data: pcmBase64(pcm) }),
          end: turn => {
            this.speaking = false;
            const input = this.getInput();
            this.command({ kind: 'commit', turn, ...(input.context || input.attachments?.length ? { input } : {}) });
            this.finishCaptureTurn(turn);
            if (this.id === id) this.setPhase('thinking', '正在识别');
          },
        });
        // Reconnect transport immediately while the new local classifier initializes.
        // The old capture callback is session-bound and cannot submit into this turn.
        this.command(this.startCommand());
        if (!await this.prepareSpeech(id, detector)) return;
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
      if(this.id!==id){stream.getTracks().forEach(t=>t.stop());return;}
      this.stream=stream;
      bindTrackListeners(stream);
      await context.audioWorklet.addModule(chrome.runtime.getURL('voice-worklet.js'));
      if(this.id!==id)return;
      this.analyser=context.createAnalyser();this.analyser.fftSize=256;this.analyser.connect(context.destination);
      this.player=new VoicePlayer(context,responseId=>{if(this.id===id){this.command({kind:'playback_done',responseId});if(!this.speaking)this.setPhase('listening');}},this.analyser);
      const detector=new VoiceTurnDetector({
        start:turn=>{this.diagnostic?.('speech_detected',{turn,at:performance.now(),audioTime:this.context?.currentTime});this.turn=turn;this.speaking=true;this.beginCaptureTurn(turn);const played=this.player?.begin(turn);this.diagnostic?.('playback_stopped',{turn,at:performance.now()});this.command({kind:'interrupt',turn,...(played?{played}:{})});if(this.id===id)this.setPhase('listening');},
        audio:(turn,pcm)=>this.command({kind:'audio',turn,data:pcmBase64(pcm)}),
        end:turn=>{this.speaking=false;const input=this.getInput();this.command({kind:'commit',turn,...(input.context||input.attachments?.length?{input}:{})});this.finishCaptureTurn(turn);if(this.id===id)this.setPhase('thinking','正在识别');},
      });
      if (!await this.prepareSpeech(id, detector)) return;
      const worklet=new AudioWorkletNode(context,'voice-capture');this.worklet=worklet;
      worklet.port.onmessage=({data})=>this.onCaptureFrame(id,data);
      context.createMediaStreamSource(stream).connect(worklet);worklet.connect(context.destination);
      this.command(this.startCommand());
    } catch(error) {
      if(this.id===id)this.needsMicrophonePermission=error instanceof DOMException && error.name==='NotAllowedError';
      if(this.id===id)this.fail(error instanceof DOMException && error.name==='NotAllowedError'?'未获得麦克风权限，请允许后重试。':'麦克风未能启动，请检查设备后重试。');
    }
  }

  /** One place where a raw 24k frame arrives; the capture copy is taken before any worker transfer. */
  private onCaptureFrame(id: string, data: { pcm: ArrayBuffer; rms: number }): void {
    if (this.id !== id || !this.ready) return;
    this.inputLevel = data.rms;
    const source = new Int16Array(data.pcm);
    if (this.recording) this.captureDiagnosticFrame(source);
    else if (!this.diagSession) this.captureContinuousFrame(source);
    this.speechClassifier?.push(new Int16Array(data.pcm));
  }
  /** Normal sessions start with `capture:true`; a manual diagnostic session never records twice. */
  private startCommand(): VoiceCommand {
    return this.diagSession ? { kind: 'start', diagnostic: true } : { kind: 'start', capture: true };
  }
  private resetCapture(): void {
    this.captureTurn = 0;
    this.capturePrefix = [];
    this.captureFrames = [];
    this.captureSamples = 0;
    this.captureCapped = false;
  }
  private captureMaxSamples(): number { return Math.floor(VOICE_DIAG_MAX_SECONDS * (this.context?.sampleRate ?? VOICE_DIAG_SAMPLE_RATE)); }
  /**
   * Continuous 24k PCM for the current turn, copied before the classifier sees it.
   * While no turn is open the newest ~0.32s is kept, so a turn's capture starts with the same preroll
   * the detector sends upstream instead of cutting the speech onset off. Nothing is sent per frame.
   */
  private captureContinuousFrame(source: Int16Array): void {
    if (this.captureTurn === 0) {
      this.capturePrefix.push(Int16Array.from(source));
      while (this.capturePrefix.reduce((sum, frame) => sum + frame.length, 0) > 7680) this.capturePrefix.shift();
      return;
    }
    const room = this.captureMaxSamples() - this.captureSamples;
    if (room <= 0) { this.captureCapped = true; return; }
    const take = source.length <= room ? Int16Array.from(source) : Int16Array.from(source.subarray(0, room));
    this.captureFrames.push(take);
    this.captureSamples += take.length;
    if (take.length < source.length) this.captureCapped = true;
  }
  private beginCaptureTurn(turn: number): void {
    if (this.diagSession) return;
    this.captureTurn = turn;
    this.captureFrames = [];
    // The preroll is part of what this turn played upstream, so it counts against the same 60-second cap.
    this.captureSamples = this.capturePrefix.reduce((sum, frame) => sum + frame.length, 0);
    this.captureCapped = false;
  }
  /** One command per turn, sent after the upstream commit and never a reason to change voice state. */
  private finishCaptureTurn(turn: number): void {
    if (this.diagSession) return;
    const frames = this.captureTurn === turn ? [...this.capturePrefix, ...this.captureFrames] : [];
    const capped = this.captureCapped;
    this.resetCapture();
    const samples = frames.reduce((sum, frame) => sum + frame.length, 0);
    if (!samples) return;
    const pcm = new Int16Array(samples);
    let at = 0;
    for (const frame of frames) { pcm.set(frame, at); at += frame.length; }
    this.command({
      kind: 'capture', turn, sampleRate: this.context?.sampleRate ?? VOICE_DIAG_SAMPLE_RATE,
      data: pcmBase64Large(pcm), ...(capped ? { note: 'capped' } : {}),
    });
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
    if (!turn) return { ok: false, turn, detail: '还没有可标记的一轮，先说一句再标记。' };
    const ok = this.command({ kind: 'capture', turn, mark: true, ...(note ? { note } : {}) });
    return ok ? { ok: true, turn } : { ok: false, turn, detail: '语音连接未就绪，标记未发送。' };
  }
  private captureDiagnosticFrame(source: Int16Array): void {
    if (!this.diagSession || !this.diagConfirmed || !this.recording) return;
    const bounded = this.log?.captureFrame(Int16Array.from(source)) ?? 'ignored';
    if (bounded === 'full') { this.endDiagnosticRecording('limit'); this.awaitTranscriptThenStop(); return; }
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
  private async prepareSpeech(id: string, detector: VoiceTurnDetector): Promise<boolean> {
    this.speechClassifier?.close(); this.speechClassifier = null;
    let classifier: SpeechClassifier;
    // The classifier still receives frames (the copy above already happened), but a diagnostic take
    // is opened and closed by the user, so its decisions never drive turns.
    try { classifier = await SpeechClassifier.create((pcm, probability) => {
      if (this.id === id && this.ready && !this.diagSession) detector.push(pcm, probability);
    }, () => { if (this.id === id) this.fail('人声检测未能运行，请重新开启语音。'); });
    } catch {
      if (this.id === id) this.fail('人声检测未能加载，请重新开启语音。');
      return false;
    }
    if (this.id !== id) { classifier.close(); return false; }
    this.speechClassifier = classifier;
    return true;
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
    this.speaking = false;
    this.player?.stop();
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
    if(e.kind==='diag'){this.onDiagRecord(e.record);return;}
    if(e.kind==='state'){
      if(e.state==='error'){
        if(e.recoverable && this.userIntentActive && !this.needsMicrophonePermission) {
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
        if(this.connectTimer)clearTimeout(this.connectTimer);
        this.ready=true;
        this.recovering=false;
        this.recoveryAttempts=0;
        this.recoveryStartTime=0;
        if(this.recoveryTimer){clearTimeout(this.recoveryTimer);this.recoveryTimer=null;}
        if(!this.speaking&&this.phase!=='speaking')this.setPhase('listening',e.detail);
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
    if(e.turn!==this.turn)return;
    if(e.kind==='reset_output'){this.player?.stop();this.player?.begin(this.turn);}
    else if(e.kind==='audio'){this.player?.enqueue(e);this.setPhase('speaking');}
    else if(e.kind==='response_end')this.player?.responseEnd(e.responseId);
    else this.event(e);
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
    this.resetCapture();
    this.pendingAutoRecord=false;
    if(this.connectTimer)clearTimeout(this.connectTimer);this.connectTimer=null;
    const id=this.id;this.id=null;this.ready=false;this.speaking=false;this.inputLevel=0;
    if(id&&notify)this.send({type:'voice',voiceId:id,conversationId:this.conversationId,command:{kind:'stop'}});
    this.speechClassifier?.close();this.speechClassifier=null;
    if(this.worklet){this.worklet.port.onmessage=null;this.worklet.disconnect();this.worklet=null;}
    this.stream?.getTracks().forEach(t=>{t.onended=null;t.stop();});this.stream=null;
    this.player?.stop();this.player=null;this.analyser?.disconnect();this.analyser=null;
    if(this.context)void this.context.close().catch(()=>{});this.context=null;
    this.setPhase('idle');
  }
}
