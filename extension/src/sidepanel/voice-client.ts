import type { VoiceClientMessage, VoiceCommand, VoiceServerMessage, VoiceEvent } from '../../../shared/voice.js';
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
  constructor(private readonly send: (msg: VoiceClientMessage & {conversationId: string}) => boolean,
    private readonly change: (phase: VoicePhase, detail?: string) => void,
    private readonly event: (event: VoiceEvent) => void) {}
  get active(): boolean { return this.id !== null; }
  get level(): number {
    if (this.phase === 'speaking' && this.analyser) {
      this.analyser.getFloatTimeDomainData(this.meter);
      return Math.min(1, Math.sqrt(this.meter.reduce((s, x) => s + x*x, 0)/this.meter.length)*5);
    }
    return this.phase === 'listening' ? Math.min(1, this.inputLevel*5) : 0;
  }
  private setPhase(phase: VoicePhase, detail?: string): void { this.phase = phase; this.change(phase, detail); }
  private command(command: VoiceCommand): void {
    if (this.id && !this.send({type:'voice',voiceId:this.id,conversationId:this.conversationId,command})) this.fail('连接已断开，请重试。');
  }
  async start(conversationId: string): Promise<void> {
    if (this.id) return;
    this.needsMicrophonePermission = false;
    const id = crypto.randomUUID(); this.id=id; this.conversationId=conversationId; this.turn=0;
    this.setPhase('connecting', '正在开启麦克风');
    this.connectTimer=setTimeout(()=>{if(this.id===id)this.fail('语音开启超时，请重试。');},45000);
    try {
      const context = new AudioContext({sampleRate:24000}); this.context=context;
      await context.resume();
      if (this.id!==id) return;
      if(context.sampleRate!==24000) throw new Error('sample rate');
      const stream = await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
      if(this.id!==id){stream.getTracks().forEach(t=>t.stop());return;}
      this.stream=stream;
      stream.getTracks().forEach(t=>t.onended=()=>{if(this.id===id)this.fail('麦克风已断开，请重试。');});
      await context.audioWorklet.addModule(chrome.runtime.getURL('voice-worklet.js'));
      if(this.id!==id)return;
      this.analyser=context.createAnalyser();this.analyser.fftSize=256;this.analyser.connect(context.destination);
      this.player=new VoicePlayer(context,responseId=>{if(this.id===id){this.command({kind:'playback_done',responseId});if(!this.speaking)this.setPhase('listening');}},this.analyser);
      const detector=new VoiceTurnDetector({
        start:turn=>{this.turn=turn;this.speaking=true;const played=this.player?.begin(turn);this.command({kind:'interrupt',turn,...(played?{played}:{})});if(this.id===id)this.setPhase('listening');},
        audio:(turn,pcm)=>this.command({kind:'audio',turn,data:pcmBase64(pcm)}),
        end:turn=>{this.speaking=false;this.command({kind:'commit',turn});if(this.id===id)this.setPhase('thinking');},
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
  receive(message: VoiceServerMessage & {conversationId?:string}): void {
    if(message.voiceId!==this.id||message.conversationId!==this.conversationId)return;
    const e=message.event;
    if(e.kind==='state'){
      if(e.state==='error'){this.fail(e.detail??'语音连接失败，请重试。');return;}
      if(e.state==='closed'){this.stop(false);return;}
      if(e.state==='ready'){if(this.connectTimer)clearTimeout(this.connectTimer);this.ready=true;if(e.detail || (this.phase!=='speaking'&&this.phase!=='thinking'))this.setPhase('listening',e.detail);}
      if(e.state==='answering')this.setPhase('thinking');
      if(e.state==='connecting')this.setPhase('connecting','正在连接语音');
      return;
    }
    if(e.turn!==this.turn)return;
    if(e.kind==='audio'){this.player?.enqueue(e);this.setPhase('speaking');}
    else if(e.kind==='response_end')this.player?.responseEnd(e.responseId);
    else this.event(e);
  }
  fail(detail: string): void {this.stop();this.setPhase('error',detail);}
  stop(notify=true): void {
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
