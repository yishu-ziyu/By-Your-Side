import {VoiceAudioCache} from "./voice-audio-cache.js";
import {StepTtsStream} from './streaming-tts.js';
import {isLeadSession} from '../../shared/protocol.js';
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerMessage } from "../../shared/protocol.js";
import type { TaskProgressSnapshot, VoiceClientMessage, VoiceConversationContext, VoiceRouteContext,VoiceTarget } from "../../shared/voice.js";
import { StepVoiceSession,STEP_VOICE } from "./voice-session.js";

export async function readStepVoiceKey(): Promise<string> {
  const environment = process.env.SIDEAGENT_STEP_PLAN_KEY?.trim();
  if (environment) return environment;
  const file = join(homedir(), ".sideagent", "step-plan.key");
  try {
    const info = await stat(file);
    if (info.mode & 0o077) throw new Error("permissions");
    const key = (await readFile(file, "utf8")).trim();
    if (key) return key;
  } catch { /* one safe diagnostic, no key material */ }
  throw new Error("请先配置本机 Step Plan 语音 Key，再重试。");
}

/** One explicit human voice connection; background task sessions stay independent. */
export class VoiceService {
  private readonly receiptAudioCache=new VoiceAudioCache(STEP_VOICE);
  private active: { id: string; conversationId: string; session: StepVoiceSession;observed:string;startedAt:number;controls:Set<string>;notifiedControls:Set<string>;announcedDeliveries:Set<string>;streamedDeliveries:Set<string> } | null = null;
  constructor(private readonly snapshot: (id: string) => TaskProgressSnapshot | null,
    private readonly emit: (msg: ServerMessage) => void,
    private readonly getKey = readStepVoiceKey,
    private readonly createSession = (deps: ConstructorParameters<typeof StepVoiceSession>[0]) => new StepVoiceSession(deps),
    private readonly steer?: (id: string, text: string, startedAt: number | null) => Promise<void>,
    private readonly route?: (id: string, text: string, startedAt: number | null, stillCurrent: () => boolean, context: VoiceRouteContext) => ReturnType<NonNullable<ConstructorParameters<typeof StepVoiceSession>[0]["route"]>>,
    private readonly diagnostic?: ConstructorParameters<typeof StepVoiceSession>[0]["diagnostic"],
    private readonly targets?:()=>VoiceTarget[],
    private readonly onPlayback?: (conversationId: string, deliveryId: string, status: "speaking" | "played") => void,
    private readonly onSpokenAck?: (conversationId: string, text: string, runId: string | null) => void) {}
  async handle(conversationId: string, message: VoiceClientMessage): Promise<void> {
    if (message.command.kind === "start") {
      if (this.active?.id === message.voiceId && this.active.conversationId === conversationId) return;
      this.close();
      if (!this.snapshot(conversationId)) { this.emit({ type: "voice", voiceId: message.voiceId, conversationId, event: { kind: "state", state: "error", detail: "当前会话不可用，请重新选择会话。" } }); return; }
      const initial=this.snapshot(conversationId)!;
      const initialRes=initial.conversationContext?.latestResult;
      const initialHasResult=!!(initialRes&&initialRes.runId===initial.runId&&initialRes.text);
      const initialResultId=initialHasResult&&initialRes?`${initialRes.runId}:${initialRes.observedAt}`:'none';
      const initialDelivery=initial.conversationContext?.latestDelivery;
      const announcedDeliveries=new Set<string>(initialDelivery?.id?[initialDelivery.id]:[]);
      const active = { id: message.voiceId, conversationId,observed:`${initial.runId}:${initial.state}:${initialResultId}:${initialDelivery?.id??'none'}`,startedAt:Date.now(),controls:new Set<string>(),notifiedControls:new Set<string>(),announcedDeliveries,streamedDeliveries:new Set<string>(),session: this.createSession({
        voiceId:message.voiceId,
        getSnapshot: () => this.snapshot(conversationId),
        getTargets:this.targets,
        receiptAudioCache:this.receiptAudioCache,
        createSpeech:(key,callbacks)=>new StepTtsStream(key,STEP_VOICE,callbacks),
        diagnostic: (event, fields) => this.diagnostic?.(event, { voiceId: message.voiceId, conversationId, ...fields }),
        ...(this.route ? {route: (text: string, startedAt: number | null, stillCurrent: () => boolean, context:VoiceRouteContext) => this.route!(conversationId, text, startedAt, () => this.active?.id === message.voiceId && stillCurrent(), context)} : {}),
        ...(this.steer ? { steer: async (text: string, startedAt: number | null) => {
          if (this.active?.id !== message.voiceId || this.active.conversationId !== conversationId) throw new Error("语音会话已结束，修改未发送。");
          await this.steer!(conversationId, text, startedAt);
        } } : {}),
        emit: event => this.emit({ type: "voice", voiceId: message.voiceId, conversationId, event }),
        onPlayback: (deliveryId, status) => {
          if (this.active !== active) return;
          this.onPlayback?.(conversationId, deliveryId, status);
        },
        onSpokenAck: (text, runId) => {
          if (this.active !== active) return;
          this.onSpokenAck?.(conversationId, text, runId);
        },
      }) };
      this.active = active;
      try { const key = await this.getKey(); if (this.active === active) active.session.start(key); }
      catch { if (this.active === active) { active.session.close(false); this.active = null; this.emit({ type: "voice", voiceId: message.voiceId, conversationId, event: { kind: "state", state: "error", detail: "请先配置本机 Step Plan 语音 Key，再重试。" } }); } }
      return;
    }
    const active = this.active;
    if (!active || active.id !== message.voiceId || active.conversationId !== conversationId) return;
    if (message.command.kind === "interrupt") {
      const current = this.snapshot(conversationId)?.conversationContext?.latestDelivery;
      if (current?.id) active.announcedDeliveries.add(current.id);
    }
    active.session.command(message.command);
    if (message.command.kind === "stop") this.active = null;
  }
  observe(message:ServerMessage):void {
    const active=this.active;if(!active||message.conversationId!==active.conversationId)return;
    if(message.type==='task_control'){active.controls.add(message.requestId);return;}
    const snapshot=this.snapshot(active.conversationId);if(!snapshot)return;
    if(message.type==='agent_event'&&isLeadSession(message.sessionId)){
      const e=message.event;
      if(e.kind==='user_delivery_stream'&&e.stream.runId===(snapshot.runId??null)){
        active.announcedDeliveries.add(e.stream.id);
        active.streamedDeliveries.add(e.stream.id);
        active.session.streamDelivery?.(e.stream);return;
      }
      if(e.kind==='user_delivery'&&active.streamedDeliveries.has(e.delivery.id)&&e.delivery.runId===(snapshot.runId??null)){
        active.session.completeDelivery?.(e.delivery);return;
      }
    }
    if(message.type==='agent_event'&&message.event.kind==='notice'&&message.event.receipt){
      const r=message.event.receipt;
      if(['pause','resume','abort'].includes(r.action)){
        active.controls.delete(r.requestId);
        if(!active.notifiedControls.has(r.requestId)&&r.status==='applied'&&r.updatedAt>=active.startedAt&&r.runId===snapshot.runId&&['paused','aborted'].includes(snapshot.state)){active.notifiedControls.add(r.requestId);active.session.notify(snapshot);}
      }
    }
    const delivery=snapshot.conversationContext?.latestDelivery;
    const speakable=!!(delivery&&(delivery.kind==='finding'||delivery.kind==='reply')&&delivery.status!=='played'&&delivery.runId===snapshot.runId&&delivery.text.trim());
    const result=snapshot.conversationContext?.latestResult;
    const hasResult=!!(result&&result.runId===snapshot.runId&&result.text);
    const resultIdentity=hasResult&&result?`${result.runId}:${result.observedAt}`:'none';
    if(speakable&&delivery&&snapshot.state==='idle'&&!active.controls.size&&!active.announcedDeliveries.has(delivery.id)){
      active.announcedDeliveries.add(delivery.id);
      active.observed=`${snapshot.runId}:${snapshot.state}:${resultIdentity}:${delivery.id}`;
      active.session.notify(snapshot);
      return;
    }
    // session.ts emits status idle before agent_end; do not broadcast premature empty idle on status message alone
    if(message.type==='status'&&message.state==='idle'&&!hasResult&&!speakable)return;
    if(snapshot.state==='idle'&&hasResult&&!speakable)return;

    const key=`${snapshot.runId}:${snapshot.state}:${resultIdentity}:${delivery?.id??'none'}`;if(key===active.observed)return;active.observed=key;
    if(!active.controls.size&&snapshot.state==='error'&&snapshot.runId)active.session.notify(snapshot);
    else if(!active.controls.size&&snapshot.state==='idle'&&snapshot.runId&&!hasResult&&!delivery)active.session.notify(snapshot);
  }
  close(): void { this.active?.session.close(); this.active = null; }
}
