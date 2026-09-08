import { parseClientMessage, type ClientMessage, type ServerMessage } from "../../../shared/protocol.js";
import type {VoiceInputContext} from '../../../shared/voice.js';

/** Audio bypasses persisted task history and is delivered only to its owning panel. */
export class VoiceRelay {
  private lease: { port: chrome.runtime.Port; voiceId: string; conversationId: string;turn:number } | null = null;
  constructor(private readonly send: (message: ClientMessage) => boolean, private readonly selected: () => string,
    private readonly enrich?:(conversationId:string,input:VoiceInputContext)=>Promise<VoiceInputContext>) {}
  attach(port: chrome.runtime.Port): void {
    port.onDisconnect.addListener(() => { if (this.lease?.port === port) this.stop(); });
    port.onMessage.addListener((raw: any) => {
      if (raw?.kind !== "client" || raw.msg?.type !== "voice") return;
      let message: ClientMessage | null;
      try { message = parseClientMessage(JSON.stringify(raw.msg)); } catch { return; }
      if (!message || message.type !== "voice" || !message.conversationId) return;
      if (message.command.kind === "start") {
        if (message.conversationId !== this.selected()) return;
        if (this.lease?.port === port && this.lease.voiceId === message.voiceId) return;
        this.stop();
        this.lease = { port, voiceId: message.voiceId, conversationId: message.conversationId,turn:0 };
      }
      const lease = this.lease;
      if (!lease || lease.port !== port || lease.voiceId !== message.voiceId || lease.conversationId !== message.conversationId) return;
      if(message.command.kind==='interrupt'){
        if(message.command.turn<=lease.turn)return;lease.turn=message.command.turn;
      }
      if((message.command.kind==='audio'||message.command.kind==='commit')&&message.command.turn!==lease.turn)return;
      if(message.command.kind==='commit'&&this.enrich){
        const command=message.command;
        void this.enrich(lease.conversationId,command.input??{}).then(input=>{
          if(this.lease!==lease||lease.turn!==command.turn)return;
          if(!this.send({...message,command:{...command,input}}))this.disconnected();
        }).catch(()=>{if(this.lease===lease&&lease.turn===command.turn)this.post({type:'voice',voiceId:lease.voiceId,conversationId:lease.conversationId,event:{kind:'state',state:'ready',detail:'页面资料没能读取，这句话没有发送，请重说。'}});});
        return;
      }
      if (!this.send(message)) { this.disconnected(); return; }
      if (message.command.kind === "stop") this.lease = null;
    });
  }
  server(message: Extract<ServerMessage, { type: "voice" }>): void {
    const lease = this.lease;
    if (!lease || lease.voiceId !== message.voiceId || lease.conversationId !== message.conversationId) return;
    this.post(message);
    if (message.event.kind === "state" && (message.event.state === "closed" || message.event.state === "error")) this.lease = null;
  }
  private post(message: Extract<ServerMessage, { type: "voice" }>): void {
    try { this.lease?.port.postMessage({ kind: "server", conversationId: message.conversationId, msg: message }); } catch { /* panel closed */ }
  }
  selectionChanged(id: string): void { if (this.lease && this.lease.conversationId !== id) this.stop(); }
  disconnected(): void {
    if (!this.lease) return;
    const { voiceId, conversationId } = this.lease;
    this.post({ type: "voice", voiceId, conversationId, event: { kind: "state", state: "error", detail: "语音连接已断开，请重试。" } });
    this.lease = null;
  }
  stop(): void {
    if (!this.lease) return;
    const { voiceId, conversationId } = this.lease;
    this.send({ type: "voice", voiceId, conversationId, command: { kind: "stop" } });
    this.post({ type: "voice", voiceId, conversationId, event: { kind: "state", state: "closed" } });
    this.lease = null;
  }
}
