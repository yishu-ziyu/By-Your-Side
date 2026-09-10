import type { VoiceClientMessage, VoiceCommand, VoiceServerMessage, VoiceEvent,VoiceInputContext } from '../../../shared/voice.js';
import { VoicePlayer } from './voice-player.js';
import { VoiceTurnDetector, pcmBase64 } from './voice-signal.js';
export type VoicePhase = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error';
export class VoiceClient {
  private id: string | null = null;
  private conversationId = '';
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private worklet: AudioWorkletNode | null = null;
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

  private userIntentActive = false;
  private recovering = false;
  private recoveryAttempts = 0;
  private recoveryStartTime = 0;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly send: (msg: VoiceClientMessage & {conversationId: string}) => boolean,
    private readonly change: (phase: VoicePhase, detail?: string) => void,
    private readonly event: (event: VoiceEvent) => void,
    private readonly getInput:()=>VoiceInputContext=()=>({}),
    private readonly diagnostic?:(event:string,fields:Record<string,string|number|boolean|null|undefined>)=>void) {}
  get active(): boolean { return this.id !== null || this.recovering; }
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
  async start(conversationId: string): Promise<void> {
    if (this.id) return;
    this.needsMicrophonePermission = false;
    this.userIntentActive = true;
    this.conversationId = conversationId;
    this.turn = 0;
    const id = crypto.randomUUID(); this.id=id;
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
            if (this.id === id) this.setPhase('thinking', '正在识别');
          },
        });
        this.worklet.port.onmessage = ({ data }) => {
          if (this.id !== id || !this.ready) return;
          this.inputLevel = data.rms;
          detector.push(new Int16Array(data.pcm), data.rms);
        };
        this.command({ kind: 'start' });
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
        start:turn=>{this.diagnostic?.('speech_detected',{turn,at:performance.now(),audioTime:this.context?.currentTime});this.turn=turn;this.speaking=true;const played=this.player?.begin(turn);this.diagnostic?.('playback_stopped',{turn,at:performance.now()});this.command({kind:'interrupt',turn,...(played?{played}:{})});if(this.id===id)this.setPhase('listening');},
        audio:(turn,pcm)=>this.command({kind:'audio',turn,data:pcmBase64(pcm)}),
        end:turn=>{this.speaking=false;const input=this.getInput();this.command({kind:'commit',turn,...(input.context||input.attachments?.length?{input}:{})});if(this.id===id)this.setPhase('thinking','正在识别');},
      });
      const worklet=new AudioWorkletNode(context,'voice-capture');this.worklet=worklet;
      worklet.port.onmessage=({data})=>{if(this.id!==id||!this.ready)return;this.inputLevel=data.rms;detector.push(new Int16Array(data.pcm),data.rms);};
      context.createMediaStreamSource(stream).connect(worklet);worklet.connect(context.destination);
      this.command({kind:'start'});
    } catch(error) {
      if(this.id===id)this.needsMicrophonePermission=error instanceof DOMException && error.name==='NotAllowedError';
      if(this.id===id)this.fail(error instanceof DOMException && error.name==='NotAllowedError'?'未获得麦克风权限，请允许后重试。':'麦克风未能启动，请检查设备后重试。');
    }
  }

  scheduleRecovery(detail = '语音连接已断开，正在恢复…'): void {
    if (!this.userIntentActive) return;
    if (this.needsMicrophonePermission) return;
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
    await this.start(this.conversationId);
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

  receive(message: VoiceServerMessage & {conversationId?:string}): void {
    if(message.voiceId!==this.id||message.conversationId!==this.conversationId)return;
    const e=message.event;
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
      }
      if(e.state==='answering')this.setPhase('thinking',e.detail??'正在处理这句话');
      if(e.state==='connecting')this.setPhase('connecting',e.detail??'正在连接语音');
      return;
    }
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
    if(this.connectTimer)clearTimeout(this.connectTimer);this.connectTimer=null;
    const id=this.id;this.id=null;this.ready=false;this.speaking=false;this.inputLevel=0;
    if(id&&notify)this.send({type:'voice',voiceId:id,conversationId:this.conversationId,command:{kind:'stop'}});
    if(this.worklet){this.worklet.port.onmessage=null;this.worklet.disconnect();this.worklet=null;}
    this.stream?.getTracks().forEach(t=>{t.onended=null;t.stop();});this.stream=null;
    this.player?.stop();this.player=null;this.analyser?.disconnect();this.analyser=null;
    if(this.context)void this.context.close().catch(()=>{});this.context=null;
    this.setPhase('idle');
  }
}
