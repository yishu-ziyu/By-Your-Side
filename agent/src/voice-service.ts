import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerMessage } from "../../shared/protocol.js";
import type { TaskProgressSnapshot, VoiceClientMessage, VoiceRouteContext,VoiceTarget } from "../../shared/voice.js";
import { StepVoiceSession } from "./voice-session.js";

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
  private active: { id: string; conversationId: string; session: StepVoiceSession;observed:string;startedAt:number;controls:Set<string>;notifiedControls:Set<string> } | null = null;
  constructor(private readonly snapshot: (id: string) => TaskProgressSnapshot | null,
    private readonly emit: (msg: ServerMessage) => void,
    private readonly getKey = readStepVoiceKey,
    private readonly createSession = (deps: ConstructorParameters<typeof StepVoiceSession>[0]) => new StepVoiceSession(deps),
    private readonly steer?: (id: string, text: string, startedAt: number | null) => Promise<void>,
    private readonly route?: (id: string, text: string, startedAt: number | null, stillCurrent: () => boolean, context: VoiceRouteContext) => ReturnType<NonNullable<ConstructorParameters<typeof StepVoiceSession>[0]["route"]>>,
    private readonly diagnostic?: ConstructorParameters<typeof StepVoiceSession>[0]["diagnostic"],
    private readonly targets?:()=>VoiceTarget[]) {}
  async handle(conversationId: string, message: VoiceClientMessage): Promise<void> {
    if (message.command.kind === "start") {
      if (this.active?.id === message.voiceId && this.active.conversationId === conversationId) return;
      this.close();
      if (!this.snapshot(conversationId)) { this.emit({ type: "voice", voiceId: message.voiceId, conversationId, event: { kind: "state", state: "error", detail: "当前会话不可用，请重新选择会话。" } }); return; }
      const initial=this.snapshot(conversationId)!;
      const active = { id: message.voiceId, conversationId,observed:`${initial.runId}:${initial.state}`,startedAt:Date.now(),controls:new Set<string>(),notifiedControls:new Set<string>(),session: this.createSession({
        voiceId:message.voiceId,
        getSnapshot: () => this.snapshot(conversationId),
        getTargets:this.targets,
        diagnostic: (event, fields) => this.diagnostic?.(event, { voiceId: message.voiceId, conversationId, ...fields }),
        ...(this.route ? {route: (text: string, startedAt: number | null, stillCurrent: () => boolean, context:VoiceRouteContext) => this.route!(conversationId, text, startedAt, () => this.active?.id === message.voiceId && stillCurrent(), context)} : {}),
        ...(this.steer ? { steer: async (text: string, startedAt: number | null) => {
          if (this.active?.id !== message.voiceId || this.active.conversationId !== conversationId) throw new Error("语音会话已结束，修改未发送。");
          await this.steer!(conversationId, text, startedAt);
        } } : {}),
        emit: event => this.emit({ type: "voice", voiceId: message.voiceId, conversationId, event }),
      }) };
      this.active = active;
      try { const key = await this.getKey(); if (this.active === active) active.session.start(key); }
      catch { if (this.active === active) { active.session.close(false); this.active = null; this.emit({ type: "voice", voiceId: message.voiceId, conversationId, event: { kind: "state", state: "error", detail: "请先配置本机 Step Plan 语音 Key，再重试。" } }); } }
      return;
    }
    const active = this.active;
    if (!active || active.id !== message.voiceId || active.conversationId !== conversationId) return;
    active.session.command(message.command);
    if (message.command.kind === "stop") this.active = null;
  }
  observe(message:ServerMessage):void {
    const active=this.active;if(!active||message.conversationId!==active.conversationId)return;
    if(message.type==='task_control'){active.controls.add(message.requestId);return;}
    const snapshot=this.snapshot(active.conversationId);if(!snapshot)return;
    if(message.type==='agent_event'&&message.event.kind==='notice'&&message.event.receipt){
      const r=message.event.receipt;
      if(['pause','resume','abort'].includes(r.action)){
        active.controls.delete(r.requestId);
        if(!active.notifiedControls.has(r.requestId)&&r.status==='applied'&&r.updatedAt>=active.startedAt&&r.runId===snapshot.runId&&['paused','aborted'].includes(snapshot.state)){active.notifiedControls.add(r.requestId);active.session.notify(snapshot);}
      }
    }
    const key=`${snapshot.runId}:${snapshot.state}`;if(key===active.observed)return;active.observed=key;
    if(!active.controls.size&&['idle','error'].includes(snapshot.state)&&snapshot.runId)active.session.notify(snapshot);
  }
  close(): void { this.active?.session.close(); this.active = null; }
}
