import {join} from "node:path";
import {VoicePlanStore,type VoicePlanStep,type VoiceProposal} from "./voice-plan-store.js";
import { createHash, randomUUID } from "node:crypto";
import {
  DEFAULT_CONVERSATION_ID, isLeadSession, normalizeConversationId,
  type ClientMessage, type ConversationSummary, type ServerMessage,
} from "../../shared/protocol.js";
import type { UserDelivery, UserDeliveryKind } from "../../shared/voice.js";
import { createUserDelivery } from "./user-delivery.js";
import type { ConversationStore } from "./conversation-store.js";
import type { createConversationRuntime } from "./conversation-runtime.js";
import type { MemoryStore } from "./memory-store.js";
import { TaskProgress } from "./task-progress.js";
import type { TaskProgressSnapshot, VoiceRouteContext, VoiceRouteResult,VoiceInputContext } from "../../shared/voice.js";
import { isTaskActionRequest, type TaskActionRequest, type TaskReceipt } from "../../shared/task-actions.js";
import { TaskDispatcher, TaskActionRejected, TaskActionFailed, TaskReceiptError } from "./task-dispatcher.js";
import {progressSpeech} from './voice-receipt.js';
import {TaskControlBroker} from './task-control.js';

type Runtime = Awaited<ReturnType<typeof createConversationRuntime>>;
export interface ConversationEntry { summary: ConversationSummary; runtime: Runtime }

/** Identity is captured by each runtime's emitter, never read from the selected panel. */
export class ConversationManager {
  private readonly entries = new Map<string, ConversationEntry>();
  private readonly pending = new Map<string, Promise<ConversationEntry>>();
  private readonly requests = new Map<string, Promise<ConversationEntry>>();
  private readonly progress = new Map<string, TaskProgress>();
  private readonly voiceConfirmations=new Map<string,VoiceProposal>();
  private readonly controlVersions=new Map<string,number>();
  private readonly makeupRuns=new Set<string>();
  private readonly voicePlans:VoicePlanStore;
  voiceTargets(){return this.list().map(c=>({id:c.id,title:c.title,runId:this.getTaskProgress(c.id)?.runId??null,controlVersion:this.controlVersions.get(c.id)??0}));}
  readonly controls:TaskControlBroker;
  constructor(
    private readonly factory: (id: string, emit: (message: ServerMessage) => void, summary?: ConversationSummary) => Promise<Runtime>,
    private readonly emit: (message: ServerMessage) => void,
    private readonly store?: ConversationStore,
    private readonly memoryStore?: MemoryStore,
    readonly dispatcher = new TaskDispatcher(),
  ) {this.controls=new TaskControlBroker(emit);this.voicePlans=new VoicePlanStore(dispatcher.store.directory?join(dispatcher.store.directory,"voice-plans"):undefined);}

  async ensureDefault(): Promise<ConversationEntry> {
    for (const summary of this.store?.load() ?? []) await this.create(summary.id, summary.title, summary);
    return this.create(DEFAULT_CONVERSATION_ID, "新会话");
  }
  get(id: string): ConversationEntry | undefined { return this.entries.get(id); }
  getTaskProgress(id: string): TaskProgressSnapshot | null { const snapshot=this.progress.get(id)?.snapshot();return snapshot?{...snapshot,controlVersion:this.controlVersions.get(id)??0}:null; }
  markDeliveryPlayback(conversationId: string, deliveryId: string, status: "speaking" | "played"): void {
    const updated = this.progress.get(conversationId)?.markPlayback(deliveryId, status);
    if (!updated) return;
    this.emit({ type: "agent_event", conversationId, event: { kind: "user_delivery", delivery: updated } });
  }
  recordSpokenAck(conversationId: string, text: string, runId: string | null): void {
    const snap = this.getTaskProgress(conversationId);
    if (!snap || snap.runId !== runId) return;
    if (this.progress.get(conversationId)?.hasFinding()) return;
    const latest = snap.conversationContext?.latestDelivery;
    if (latest && latest.kind !== "ack") return;
    if (latest?.kind === "ack") return;
    this.publishDelivery(conversationId, "ack", text, undefined, { runId });
  }
  async routeVoiceInput(id: string, text: string, startedAt: number | null, stillCurrent: () => boolean, route?: VoiceRouteContext):Promise<VoiceRouteResult> {
    if(route&&!route.resumeReadOnly){
      const result=await this.voicePlans.run(id,route.requestId,{text,voiceId:route.voiceId,turn:route.turn,runId:route.runId,input:route.input,targets:route.targets,controlVersion:route.controlVersion},()=>this.executeVoiceInput(id,text,startedAt,stillCurrent,route));
      if(result.plan&&result.plan.steps.length>1)this.emit({type:'agent_event',conversationId:id,event:{kind:'notice',message:'语音计划',plan:result.plan}});
      return result;
    }
    return this.executeVoiceInput(id,text,startedAt,stillCurrent,route);
  }
  private async executeVoiceInput(id:string,text:string,startedAt:number|null,stillCurrent:()=>boolean,route?:VoiceRouteContext):Promise<VoiceRouteResult>{
    const session = this.entries.get(id)?.runtime.session;
    if (!session || !text.trim() || text.length > 2000) throw new Error("这句话没有听清或过长，请重新说。");
    const before=this.getTaskProgress(id)!;
    if(route?.recentTurns?.length)before.conversationContext={latestResult:null,...before.conversationContext,recentTurns:[...(before.conversationContext?.recentTurns??[]),...route.recentTurns].slice(-12)};
    const catalog=route?.targets??this.voiceTargets();
    const pending=route?.resumeReadOnly?undefined:this.voiceConfirmations.get(id)??(route?this.voicePlans.proposal(id,route.voiceId,route.turn-1):undefined);
    if(!route?.resumeReadOnly){this.voiceConfirmations.delete(id);if(pending)this.voicePlans.update(id,pending.id,{proposal:{...pending,expiresAt:0}});}
    const short=text.replace(/[\p{P}\p{Z}\s]/gu,'');
    if(pending&&route&&pending.voiceId===route.voiceId&&route.turn===pending.turn+1&&Date.now()<pending.expiresAt){
      if(/^(好|好的|可以|是的|确认|同意|另开|开吧|好另开会话|另开会话|确认另开会话)$/.test(short)){
        route.onInputDecision?.(false);
        if(!stillCurrent())throw new TaskActionRejected('语音已结束或你正在说新指令，本句未发送。');
        const entry=await this.create(pending.conversationId,pending.text.slice(0,36));
        this.emit({type:'conversation_updated',conversationId:entry.summary.id,conversation:{...entry.summary}});
        const receipt=await this.dispatchTaskAction({requestId:route.requestId,conversationId:entry.summary.id,originConversationId:id,source:'voice',action:'start',expectedRunId:null,text:pending.text,...pending.input},stillCurrent);
        return {kind:'action',ok:receipt.status==='accepted',status:receipt.status,message:receipt.message,receipts:[receipt]};
      }
      if(/^(不|不要|不用|算了|取消|不另开|不要另开会话)$/.test(short)){route.onInputDecision?.(false);return {kind:'clarify',message:'没有另开会话，原任务保持原状。'};}
    }
    route?.reportStage?.('classifying');
    const plan=route?.resumeReadOnly?{steps:[{action:route.resumeReadOnly,target:null,text}]}:await session.classifyVoiceInput(text,before.state,catalog.filter(c=>text.includes(c.title)).map(c=>c.title),{goal:before.goal,requestId:route?.requestId},before.conversationContext);
    const single=plan.steps.length===1?plan.steps[0]:undefined;
    const willStart=!route?.resumeReadOnly&&!route?.pendingDelegation&&single?.target===null&&['none','idle'].includes(before.state)
      &&['observe','chat','steer'].includes(single.action)&&!session.isHeld()&&!session.isStreaming();
    route?.onInputDecision?.(!willStart&&plan.steps.every(step=>['chat','status','observe','silence'].includes(step.action)));
    await route?.awaitInputDecision?.();
    if (!stillCurrent()) {
      const action=plan.steps.length===1?plan.steps[0]?.action:undefined;
      if(action==='observe'&&plan.steps[0]?.target!==null)return {kind:'clarify',message:'页面问答只读取当前页面，请先切到要看的页面。'};
      if(action==='status'){
        const name=plan.steps[0]?.target;
        const exact=name?catalog.filter(c=>c.title===name):[];
        const matches=name?(exact.length?exact:catalog.filter(c=>c.title.includes(name))):catalog.filter(c=>c.id===id);
        if(matches.length!==1)return {kind:'clarify',message:'指定会话不明确，请重新说出完整名称。'};
        return {kind:'none',resumeReadOnly:'status',resumeTargetId:matches[0]!.id};
      }
      if(action==='chat'||action==='observe')return {kind:'none',resumeReadOnly:action};
      throw new TaskActionRejected('语音已结束或你正在说新指令，本句未发送。');
    }
    const receipts:TaskReceipt[]=[];
    if(!route?.resumeReadOnly)this.progress.get(id)?.recordUserTurn(text,route?.requestId);
    const versions=new Map(catalog.map(c=>[c.id,c.controlVersion??0]));
    versions.set(id,route?.controlVersion??before.controlVersion??0);
    const expected=new Map(catalog.map(c=>[c.id,c.runId]));
    expected.set(id,route?route.runId:before.runId??null);
    const requestId=route?.requestId??randomUUID();
    const only=plan.steps.length===1?plan.steps[0]:undefined;
    if(only?.action==='chat'&&route?.pendingDelegation)return {kind:'none',resumeReadOnly:'chat'};
    if(route?.resumeReadOnly==='status'){const targetId=route.resumeTargetId??id,target=this.getTaskProgress(targetId);return target?{kind:'none',resumeReadOnly:'status',resumeTargetId:targetId,snapshot:target,spokenText:(targetId===id?'':'指定会话：')+progressSpeech(target)}:{kind:'clarify',message:'原目标会话已不可用，请重新询问。'};}
    // Idle conversational requests use the same capable session as typed input.
    // Classification still resolves controls, but cannot strip tools from ordinary content.
    if (willStart) {
      const receipt=await this.dispatchTaskAction({requestId,conversationId:id,source:'voice',action:'start',expectedRunId:before.runId??null,expectedControlVersion:versions.get(id),text,...route?.input},stillCurrent);
      return {kind:'action',ok:receipt.status==='accepted',status:receipt.status,message:receipt.message,receipts:[receipt],awaitDelivery:receipt.status==='accepted'};
    }
    if(only?.action==='observe'){
      if(only.target!==null)return {kind:'clarify',message:'这次页面问答只查看你当前选中的浏览器页面，请先切到要看的页面。'};
      const observation=route?.input?.observation;
      if(!observation)return {kind:'none',spokenText:'还没有取得当前浏览器页面，请先打开要看的标签页。'};
      try{
        const rpc=this.entries.get(id)!.runtime.rpc;
        if(!stillCurrent())throw new Error('本次观察已取消。');
        route?.reportStage?.('observing');
        const page=await rpc.call('observe_page',{token:observation.token},15000) as {tabId:number;url:string;title:string;text:string;imageBase64:string;documentId:string;capturedAt:number;scope:string};
        if(!stillCurrent())throw new Error('本次观察已取消。');
        if(page?.tabId!==observation.tabId||!page.documentId||page.scope!=='viewport'||!page.imageBase64||!Number.isFinite(page.capturedAt))throw new Error('页面观察来源无效。');
        const answer=await session.answerVoiceObservation(text,page,stillCurrent);
        if(!stillCurrent())throw new Error('本次观察已取消。');
        const originRun=before.runId??null,originControl=this.controlVersions.get(id)??0;
        const now=this.getTaskProgress(id);
        if(!now||now.runId!==originRun||(this.controlVersions.get(id)??0)!==originControl)return {kind:'silent'};
        const delivery=this.publishDelivery(id,'reply',answer,text,{runId:originRun,controlVersion:originControl});
        this.emit({type:'agent_event',conversationId:id,event:{kind:'notice',message:`已查看当前页面：${page.title}\n${answer}`}});
        const published=this.getTaskProgress(id);
        return {kind:'none',resumeReadOnly:'observe',snapshot:published??now,spokenText:delivery?.text??answer};
      }catch{return {kind:'none',resumeReadOnly:'observe',spokenText:'这次没有完成当前页面的读取，请稍后再试。'};}
    }
    if(only?.action==='chat')return this.answerSourcedChat(id,text,before,stillCurrent,session,route?.turn);
    if(only?.action==='silence')return {kind:'silent'};
    // Resolve the entire plan before side effects; an ambiguous later target cannot cause a partial command.
    let previousTarget=id;
    const targetIds:string[]=[];
    for(const step of plan.steps){
      let targetId=/当前会话|这个会话/.test(step.text)?id:previousTarget;
      if(step.target!==null){
        const name=step.target.trim(),exact=catalog.filter(c=>c.title===name);
        const matches=exact.length?exact:catalog.filter(c=>c.title.includes(name));
        if(matches.length!==1)return {kind:'clarify',message:matches.length?'有多个同名会话，请说出完整且唯一的会话名称。':'没有找到这个会话，请确认完整名称。'};
        targetId=matches[0]!.id;
      }
      targetIds.push(targetId);previousTarget=targetId;
    }
    const journal:VoicePlanStep[]=plan.steps.map((step,index)=>({action:step.action,text:step.text,targetId:targetIds[index]!,targetTitle:this.entries.get(targetIds[index]!)?.summary.title,status:'unexecuted'}));
    const save=()=>{if(route&&!route.resumeReadOnly)this.voicePlans.update(id,route.requestId,{steps:journal});};
    save();
    for(const [index,step] of plan.steps.entries()) {
      if(step.action==='observe')return {kind:'clarify',message:'请先单独说出要查看的页面问题。'};
      if(step.action==='chat')return {kind:'none'};
      if(step.action==='silence')return {kind:'silent'};
      if(step.action==='clarify')return {kind:'clarify',message:/^(停止|停|停下)[。！!？?\s]*$/.test(step.text.trim())?'你是想停止播报，还是暂停任务？':'请说出目标会话的名称。'};
      const targetId=targetIds[index]!;
      const sharesInput=targetId===id||/(当前页面|当前页|所选资料|所选图片|所选内容|所选文字|选中的)/.test(step.text);
      if(['pause','resume','abort'].includes(step.action))route?.reportStage?.('controlling');
      journal[index]!.status='pending';save();
      const receipt=await this.dispatchTaskAction({expectedControlVersion:versions.get(targetId)??0,requestId:plan.steps.length===1?requestId:`${requestId}-${index}`,conversationId:targetId,...(targetId!==id?{originConversationId:id}:{}),source:'voice',action:step.action,expectedRunId:expected.get(targetId)??null,text:step.text,...((step.action==='start'||step.action==='steer')&&sharesInput?route?.input:{})},stillCurrent);
      receipts.push(receipt);journal[index]!.status='complete';journal[index]!.receipt=receipt;save();
      if(receipt.status!=='accepted'&&receipt.status!=='applied') {
        if(step.action==='start'&&receipt.message.includes('另开会话')&&route&&plan.steps.length===1){
          const proposal:VoiceProposal={id:route.requestId,conversationId:'voice-'+createHash('sha256').update(id+':'+route.requestId).digest('hex').slice(0,32),voiceId:route.voiceId,turn:route.turn,expiresAt:Date.now()+90000,text:step.text,...(sharesInput?{input:route.input}:{})};
          this.voiceConfirmations.set(id,proposal);this.voicePlans.update(id,route.requestId,{proposal});
          return {kind:'clarify',message:'当前任务还在执行。要另开会话处理这个新任务吗？'};
        }
        return {kind:step.action==='steer'?'steer':'action',ok:false,status:receipt.status,message:receipt.message,receipts};
      }
      expected.set(targetId,receipt.runId);
      if(['pause','resume','abort'].includes(step.action))versions.set(targetId,(versions.get(targetId)??0)+1);
    }
    const last=receipts.at(-1);
    if(!last)return {kind:'none'};
    if(receipts.length===1&&last.action==='status')return {kind:'none',resumeReadOnly:'status',resumeTargetId:last.conversationId,snapshot:this.getTaskProgress(last.conversationId)!,spokenText:(last.originConversationId?'指定会话：':'')+last.message};
    return {kind:receipts.length===1&&last.action==='steer'?'steer':'action',ok:true,status:last.status,message:receipts.map(r=>r.message).join('；'),receipts};
  }

  async steerFromVoice(id: string, text: string, expectedStartedAt: number | null, route?: VoiceRouteContext, stillCurrent = () => true): Promise<TaskReceipt> {
    const entry = this.entries.get(id);
    const snapshot = this.getTaskProgress(id);
    if (!entry || !snapshot || snapshot.state !== "running" || expectedStartedAt === null || snapshot.startedAt !== expectedStartedAt) {
      throw new Error("原任务已停止或发生变化，修改未发送。");
    }
    if (!text.trim() || text.length > 2000) throw new Error("这段修改没有听清或过长，请简短重说。");
    this.progress.get(id)?.recordUserTurn(text,route?.requestId);
    const receipt = await this.dispatchTaskAction({requestId:route?.requestId ?? randomUUID(),conversationId:id,source:'voice',action:'steer',expectedRunId:route ? route.runId : snapshot.runId ?? null,text},stillCurrent);
    if (receipt.status !== 'accepted') throw new TaskReceiptError(receipt);
    return receipt;
  }
  private publishDelivery(conversationId: string, kind: UserDeliveryKind, text: string, replyTo?: string, expected?: { runId: string | null; controlVersion?: number; states?: TaskProgressSnapshot["state"][] }, deliveryId?: string): UserDelivery | null {
    const snap = this.getTaskProgress(conversationId);
    if (!snap) return null;
    if (kind === "finding" && !(expected?.runId ?? snap.runId)) return null;
    if (expected) {
      if (snap.runId !== expected.runId) return null;
      if (expected.controlVersion !== undefined && (this.controlVersions.get(conversationId) ?? 0) !== expected.controlVersion) return null;
      if (expected.states && !expected.states.includes(snap.state)) return null;
    }
    const runId = expected && "runId" in expected ? expected.runId : snap.runId ?? null;
    try {
      const delivery = createUserDelivery({ conversationId, runId, kind, text, replyTo, ...(deliveryId?{id:deliveryId}:{}) });
      const message: ServerMessage = { type: "agent_event", conversationId, event: { kind: "user_delivery", delivery } };
      this.progress.get(conversationId)?.observe(message);
      this.emit(message);
      return delivery;
    } catch {
      return null;
    }
  }
  private beginDeliveryStream(conversationId:string,kind:UserDeliveryKind,before:TaskProgressSnapshot,stillCurrent:()=>boolean,voiceTurn?:number){
    const id=randomUUID(),runId=before.runId??null,control=this.controlVersions.get(conversationId)??0;
    let sent=false;
    return {id,onText:(text:string)=>{
      const now=this.getTaskProgress(conversationId);
      if(!stillCurrent()||!now||now.runId!==runId||(this.controlVersions.get(conversationId)??0)!==control||['paused','aborted','error'].includes(now.state))return false;
      sent=true;this.emit({type:'agent_event',conversationId,event:{kind:'user_delivery_stream',stream:{id,runId,kind,text,phase:'streaming',...(voiceTurn!==undefined?{voiceTurn}:{})}}});return true;
    },cancel:()=>{if(sent)this.emit({type:'agent_event',conversationId,event:{kind:'user_delivery_stream',stream:{id,runId,kind,text:'',phase:'cancelled'}}});}};
  }
  private async answerSourcedChat(id: string, text: string, before: TaskProgressSnapshot, stillCurrent: () => boolean, session: Runtime["session"],voiceTurn?:number): Promise<VoiceRouteResult> {
    const facts = before.conversationContext?.latestResult?.text;
    if (!facts) return { kind: "none", resumeReadOnly: "chat" };
    if (typeof session.composeUserDelivery !== "function") return { kind: "none", resumeReadOnly: "chat" };
    const originRun = before.runId ?? null;
    const originControl = this.controlVersions.get(id) ?? 0;
    const streaming=this.beginDeliveryStream(id,'reply',before,stillCurrent,voiceTurn);
    try {
      const spoken = await session.composeUserDelivery({
        question: text,
        facts,
        recentTurns: before.conversationContext?.recentTurns ?? [],
        latestDelivery: before.conversationContext?.latestDelivery ?? null,
      },streaming.onText);
      const now = this.getTaskProgress(id);
      if (!stillCurrent() || !now || now.runId !== originRun || (this.controlVersions.get(id) ?? 0) !== originControl) {streaming.cancel();return { kind: "silent" };}
      if (now.state === "error" || now.state === "aborted" || now.state === "paused") {streaming.cancel();return { kind: "silent" };}
      const delivery = this.publishDelivery(id, "reply", spoken, text, { runId: originRun, controlVersion: originControl },streaming.id);
      if (!delivery) {streaming.cancel();return { kind: "silent" };}
      const published = this.getTaskProgress(id);
      return { kind: "none", resumeReadOnly: "chat", snapshot: published ?? now, spokenText: delivery.text };
    } catch {
      streaming.cancel();
      const now = this.getTaskProgress(id);
      if (!now || now.runId !== originRun) return { kind: "silent" };
      return { kind: "none", spokenText: "这一轮的正式回答还没有交出来。" };
    }
  }
  private async fulfillOwedDelivery(id: string): Promise<void> {
    const progress = this.progress.get(id);
    const session = this.entries.get(id)?.runtime.session;
    const snap = this.getTaskProgress(id);
    const facts = snap?.conversationContext?.latestResult;
    if (!progress || !snap || !facts?.text || snap.state !== "idle" || !snap.runId) return;
    const existing = snap.conversationContext?.latestDelivery;
    if (progress.hasFinding() || (existing && existing.kind !== "ack" && existing.runId === snap.runId)) return;
    if (typeof session?.composeUserDelivery !== "function") return;
    if (this.makeupRuns.has(snap.runId)) {
      this.emit({ type: "agent_event", conversationId: id, event: { kind: "notice", message: "这一轮有来源结果，但正式回答还没有交出来。" } });
      return;
    }
    const originRun = snap.runId;
    const originControl = this.controlVersions.get(id) ?? 0;
    this.makeupRuns.add(originRun);
    const streaming=this.beginDeliveryStream(id,'finding',snap,()=>this.getTaskProgress(id)?.state==='idle');
    try {
      const spoken = await session.composeUserDelivery({
        question: snap.goal,
        facts: facts.text,
        recentTurns: snap.conversationContext?.recentTurns ?? [],
        latestDelivery: snap.conversationContext?.latestDelivery ?? null,
      },streaming.onText);
      const now = this.getTaskProgress(id);
      if (!now || now.runId !== originRun || now.state !== "idle" || (this.controlVersions.get(id) ?? 0) !== originControl) {streaming.cancel();return;}
      if (this.progress.get(id)?.hasFinding() || (now.conversationContext?.latestDelivery && now.conversationContext.latestDelivery.kind !== "ack")) {streaming.cancel();return;}
      if (!this.publishDelivery(id, "finding", spoken, undefined, { runId: originRun, controlVersion: originControl, states: ["idle"] },streaming.id)) {streaming.cancel();return;}
    } catch {
      streaming.cancel();
      const now = this.getTaskProgress(id);
      if (now?.runId === originRun && now.state === "idle" && !progress.hasFinding()) {
        this.emit({ type: "agent_event", conversationId: id, event: { kind: "notice", message: "这一轮有来源结果，但正式回答还没有交出来。" } });
      }
    }
  }
  private emitReceipt(receipt: TaskReceipt): void {
    for(const id of new Set([receipt.conversationId,...(receipt.originConversationId?[receipt.originConversationId]:[])]))this.emit({type:'agent_event',conversationId:id,event:{kind:'notice',message:receipt.message,
      ...(receipt.message.startsWith('同一请求编号')?{}:{receipt})}});
  }
  async dispatchTaskAction(request: TaskActionRequest, stillCurrent = () => true): Promise<TaskReceipt> {
    if (!isTaskActionRequest(request)) throw new Error('无效的任务请求');
    const currentTitle=this.entries.get(request.conversationId)?.summary.title;
    const title = request.action==='start'&&currentTitle==='新会话' ? request.text?.trim().slice(0,36)||currentTitle : currentTitle ?? '会话不可用';
    const receipt = await this.dispatcher.dispatch(request,title,async()=>{
      if (!stillCurrent()) throw new TaskActionRejected('语音已结束或你正在说新指令，本句未发送。');
      const entry = this.entries.get(request.conversationId), snapshot = this.getTaskProgress(request.conversationId);
      if (!entry || !snapshot) throw new TaskActionRejected('目标会话不可用，操作未执行。');
      if (request.expectedRunId !== (snapshot.runId??null))throw new TaskActionRejected('原任务已停止或发生变化，操作未执行。');
      if(request.expectedControlVersion!==undefined&&request.expectedControlVersion!==(this.controlVersions.get(request.conversationId)??0))throw new TaskActionRejected('页面控制权已再次变化，旧计划的后续步骤未执行。');
      if (request.action === 'status')return {status:'applied',runId:snapshot.runId??null,message:progressSpeech(snapshot)};
      if (request.action === 'start') {
        if(snapshot.state==='running'||entry.runtime.session.isStreaming())throw new TaskActionRejected('当前任务还在执行。要另开会话处理这个新任务吗？');
        if(snapshot.state==='paused'||entry.runtime.session.isHeld())throw new TaskActionRejected('页面现在归你。请继续原任务，或另开会话。');
        if(!entry.runtime.session.available)throw new TaskActionRejected('当前执行模型不可用，任务未启动。');
        entry.runtime.fleet.reset();
        this.progress.get(request.conversationId)!.request(request.text??'');
        entry.runtime.session.persistTaskResults?.(this.progress.get(request.conversationId)!.snapshot());
        if(entry.summary.title==='新会话')entry.summary.title=title;
        entry.runtime.session.startTask(request.text??'',request.context,request.attachments);
        entry.summary.runId=this.getTaskProgress(request.conversationId)!.runId;
        entry.summary.updatedAt=Date.now();this.store?.save(this.list());
        this.emit({type:'conversation_updated',conversationId:request.conversationId,conversation:{...entry.summary}});
        return {status:'accepted',runId:entry.summary.runId??null,message:`已接收新任务：${request.text??'使用所选资料'}`};
      }
      if(request.action==='pause'||request.action==='resume'||request.action==='abort'){
        if(!request.expectedRunId)throw new TaskActionRejected('当前没有可控制的任务。');
        if(request.action==='resume'&&!entry.runtime.session.isHeld()&&!entry.runtime.fleet.isGroupHeld())throw new TaskActionRejected(snapshot.state==='aborted'?'任务已经终止，不能继续原任务。':'原任务没有暂停，未执行交还。');
        if(request.action!=='resume'&&!['running','paused',...(request.action==='abort'?['aborted']:[])].includes(snapshot.state))throw new TaskActionRejected('当前没有正在执行的任务，操作未执行。');
        this.controlVersions.set(request.conversationId,(this.controlVersions.get(request.conversationId)??0)+1);
        const result=await this.controls.request(request.conversationId,request.requestId,request.action,request.expectedRunId,request.scope,request.tabId);
        if(!result.ok){
          if(result.uncertain)throw new Error('Control outcome unknown');
          if(result.partial)throw new TaskActionFailed(result.reason??'部分成员已继续，其余仍暂停。');
          throw new TaskActionRejected(result.reason??'页面控制没有生效。');
        }
        if(this.getTaskProgress(request.conversationId)?.runId!==request.expectedRunId)throw new Error('Run changed during control');
        return {status:'applied',runId:request.expectedRunId,message:request.action==='pause'?(request.scope==='page'?'当前页面已接管，你可以操作。':'任务已暂停，页面现在归你。'):request.action==='resume'?'原任务已恢复。':'任务已终止。'};
      }
      if (request.action !== 'steer') throw new TaskActionRejected('这项调度能力尚未开放。');
      if(entry.runtime.session.isHeld()){
        const originRun=snapshot.runId;
        entry.runtime.session.queueSteerForResume(request.text??'',request.context,request.attachments);
        if(this.progress.get(request.conversationId)?.snapshot().runId===originRun) {
          this.progress.get(request.conversationId)?.reviseResults();
          this.progress.get(request.conversationId)?.recordUserTurn(request.text??'',request.requestId);
          entry.runtime.session.persistTaskResults?.(this.progress.get(request.conversationId)!.snapshot());
        }
        return {status:'accepted',runId:originRun??null,message:`修改已保存，继续后生效：${request.text??'所选资料'}`};
      }
      if (!request.expectedRunId || snapshot.runId !== request.expectedRunId || snapshot.state !== 'running' || !entry.runtime.session.isStreaming()) {
        throw new TaskActionRejected('原任务已停止或发生变化，修改未发送。');
      }
      if (entry.runtime.session.isHeld()) throw new TaskActionRejected('页面现在归你，请先交还。');
      const originRun=snapshot.runId;
      await entry.runtime.session.steerCurrentTask(request.text!,request.context,request.attachments);
      if(this.progress.get(request.conversationId)?.snapshot().runId===originRun) {
        this.progress.get(request.conversationId)?.reviseResults();
        this.progress.get(request.conversationId)?.recordUserTurn(request.text??'',request.requestId);
        entry.runtime.session.persistTaskResults?.(this.progress.get(request.conversationId)!.snapshot());
      }
      return {status:'accepted',runId:originRun,message:`${request.source==='voice'?'语音修改':'修改'}已送达当前任务：${request.text}`};
    });
    this.emitReceipt(receipt);
    return receipt;
  }
  list(): ConversationSummary[] { return [...this.entries.values()].map(({ summary }) => ({ ...summary })); }
  private epochs(runtime:Runtime):Record<string,number>{
    return Object.fromEntries([['main',runtime.session.executionEpoch?.()??0],...(runtime.fleet.list?.()??[]).map(w=>[w.id,runtime.fleet.get(w.id)?.executionEpoch?.()??0])]);
  }

  private create(id: string, title: string, restored?: ConversationSummary): Promise<ConversationEntry> {
    const existing = this.entries.get(id);
    if (existing) return Promise.resolve(existing);
    const pending = this.pending.get(id);
    if (pending) return pending;
    const summary: ConversationSummary = { id, title, createdAt: Date.now(), updatedAt: Date.now(), state: "idle", mode: "act", ...restored, runId:null };
    const states = new Map<string, "idle" | "running" | "user">();
    const progress = new TaskProgress(id);
    this.progress.set(id, progress);
    const promise = this.factory(id, (message) => {
      const currentRun=progress.snapshot().runId;
      const stale=typeof message.runId==='string'&&currentRun!==null&&message.runId!==currentRun;
      if(stale){
        // 显式旧 run 只按原身份转发诊断，不得改当前 summary/epochs/补交付。
        this.emit({...message,conversationId:id});
        return;
      }
      progress.observe(message);
      // 页面读数只用于结果账本的前后对比，不下发侧栏。
      if (message.type === "agent_event" && message.event.kind === "tool_observation") return;
      this.entries.get(id)?.runtime.session.persistTaskResults?.(progress.snapshot());
      summary.runId = progress.snapshot().runId;
      const live=this.entries.get(id)?.runtime;
      const carriesIdentity=['tool_call','control_result','team_status','status'].includes(message.type)||(message.type==='agent_event'&&message.event.kind==='agent_start');
      const scoped:ServerMessage = { ...message, conversationId: id, ...(live&&carriesIdentity?{epochs:{...this.epochs(live),...message.epochs}}:{}) };
      if(carriesIdentity&&scoped.type!=='task_control')scoped.runId=progress.snapshot().runId;
      this.emit(scoped);
      if (message.type === 'agent_event' && message.event.kind === 'agent_end' && isLeadSession(message.sessionId)) void this.fulfillOwedDelivery(id);
      if (message.type === 'agent_event' && message.event.kind === 'agent_start') this.emit({type:'conversation_updated',conversationId:id,conversation:{...summary}});
      if (message.type === "status") {
        states.set(message.sessionId ?? "main", message.state);
        summary.state = [...states.values()].includes("running") ? "running" : [...states.values()].includes("user") ? "user" : "idle";
        summary.updatedAt = Date.now();
        this.emit({ type: "conversation_updated", conversationId: id, conversation: { ...summary } });
      }
      if (message.type === "model_info") {
        summary.model = message.model;
        this.emit({ type: "conversation_updated", conversationId: id, conversation: { ...summary } });
      }
      if (message.type === "status" || message.type === "model_info") this.store?.save(this.list());
    }, summary).then((runtime) => {
      summary.model = runtime.session.modelName();
      runtime.fleet.setTabCoordinator?.(async (owner, members) => {
        const source = this.entries.get(owner)?.runtime;
        if (!source) return; // 已结束的运行时：扩展仍会检查归属并排空旧操作。
        const sessions = members.map(member => member === "main" ? source.session : source.fleet.get(member));
        if (sessions.some(session => session?.isHeld())) throw new Error("页面现在归你，操作未执行");
        await Promise.all(members.map(member => member === "main"
          ? source.session.yieldTab()
          : source.fleet.stopAndRelease(member)));
      });
      const entry = { summary, runtime };
      const restoredResults = runtime.session.readPersistedTaskResults?.();
      if (restoredResults) { progress.restoreResults(restoredResults); summary.runId = progress.snapshot().runId; }
      runtime.session.bindTaskResults?.({
        getSnapshot: () => progress.snapshot(),
        register: items => {
          if (!progress.snapshot().runId || progress.snapshot().state === "aborted") throw new Error("当前没有可登记结果的任务");
          progress.registerResults(items); runtime.session.persistTaskResults?.(progress.snapshot());
        },
        verify: input => {
          const outcome = progress.verifyUnknownResult(input);
          if (outcome.ok) runtime.session.persistTaskResults?.(progress.snapshot());
          return outcome;
        },
      });
      runtime.session.bindDeliveryRun?.(() => this.progress.get(id)?.snapshot().runId ?? null);
      runtime.session.bindConversationContext?.(() => this.getTaskProgress(id));
      runtime.fleet.bindConversationContext?.(() => this.getTaskProgress(id));
      this.entries.set(id, entry);
      this.store?.save(this.list());
      this.pending.delete(id);
      return entry;
    }, (error: unknown) => { this.pending.delete(id); throw error; });
    this.pending.set(id, promise);
    return promise;
  }

  async handleMessage(message: ClientMessage): Promise<void> {
    if (message.type === "conversation_create") {
      let request = this.requests.get(message.requestId);
      if (!request) {
        request = this.create(randomUUID(), message.title?.trim() || "新会话");
        this.requests.set(message.requestId, request);
      }
      const entry = await request;
      this.emit({ type: "conversation_created", requestId: message.requestId, conversationId: entry.summary.id, conversation: { ...entry.summary } });
      return;
    }
    if (message.type === "conversation_list") {
      this.emit({ type: "conversation_list", requestId: message.requestId, conversations: this.list() });
      this.replayState(this.emit);
      return;
    }
    const id = normalizeConversationId(message.conversationId);
    const entry = this.entries.get(id) ?? (id === DEFAULT_CONVERSATION_ID ? await this.ensureDefault() : undefined);
    if (!entry) throw new Error(`CONVERSATION_NOT_FOUND: ${id}`);
    if(message.type==='task_control_result'){this.controls.receive({...message,conversationId:id});return;}
    if((message.type==='takeover'||message.type==='handback'||message.type==='abort')&&!message.taskRequestId)this.controlVersions.set(id,(this.controlVersions.get(id)??0)+1);
    if((message.type==='takeover'||message.type==='handback'||message.type==='abort')&&message.taskRequestId){
      const action=message.type==='takeover'?'pause':message.type==='handback'?'resume':'abort';
      const snapshot=this.getTaskProgress(id)!;
      const valid=this.controls.permits(id,message.taskRequestId,action,snapshot.runId??null)
        &&(action==='abort'||action==='pause'&&['running','paused'].includes(snapshot.state)||action==='resume'&&(entry.runtime.session.isHeld()||entry.runtime.fleet.isGroupHeld()));
      if(!valid){
        if(message.type==='abort')this.emit({type:'task_control_ack',conversationId:id,requestId:message.taskRequestId,action:'abort',ok:false});
        else this.emit({type:'control_result',conversationId:id,requestId:message.requestId,action:message.type,ok:false,state:entry.summary.state,reason:'控制请求已过期，操作未执行。'});
        return;
      }
      if(message.type==='abort'){
        const sessions=[entry.runtime.session,...entry.runtime.fleet.list().map(w=>entry.runtime.fleet.get(w.id)).filter((s):s is NonNullable<typeof s>=>!!s)];
        this.progress.get(id)?.abort();entry.runtime.handleMessage(message);
        try{await Promise.all(sessions.map(s=>s.waitForStop()));this.emit({type:'task_control_ack',conversationId:id,requestId:message.taskRequestId,action:'abort',ok:true});}
        catch{this.emit({type:'task_control_ack',conversationId:id,requestId:message.taskRequestId,action:'abort',ok:false});}
        return;
      }
    }
    if (message.type === 'task_action') { await this.dispatchTaskAction(message.request); return; }
    if (message.type === 'task_receipt_query') {
      const receipt = this.dispatcher.get(id,message.requestId)??this.dispatcher.store.list(id).find(r=>r.requestId===message.requestId);
      if (receipt) this.emitReceipt(receipt);
      else {const result=this.voicePlans.get(id,message.requestId);this.emit({type:'agent_event',conversationId:id,event:{kind:'notice',message:result?'这份语音计划的结果见逐步记录；不会自动重做。':'未找到这条请求的回执，请不要自动重发。',...(result?.plan?.steps.length?{plan:result.plan}:{})}});}
      return;
    }
    if (message.type === "memory_list" || message.type === "memory_update" || message.type === "memory_forget") {
      await this.handleMemoryMessage(message, id);
      return;
    }
    if (message.type === "user_message" && entry.summary.title === "新会话") entry.summary.title = message.text.trim().slice(0, 36) || "新会话";
    if (message.type === "set_mode") entry.summary.mode = message.mode;
    if (message.type === "user_message") this.progress.get(id)?.request(message.text);
    if (message.type === "abort") this.progress.get(id)?.abort();
    entry.runtime.handleMessage(message);
    if (message.type === "user_message" || message.type === "set_mode") {
      entry.summary.updatedAt = Date.now();
      this.store?.save(this.list());
      this.emit({ type: "conversation_updated", conversationId: id, conversation: { ...entry.summary } });
    }
  }

  private async handleMemoryMessage(
    message: Extract<ClientMessage, { type: "memory_list" | "memory_update" | "memory_forget" }>,
    conversationId: string,
  ): Promise<void> {
    const action = message.type === "memory_list" ? "list" : message.type === "memory_update" ? "update" : "forget";
    try {
      if (!this.memoryStore) throw new Error("记忆存储不可用");
      if (message.type === "memory_list") {
        const entries = await this.memoryStore.list();
        this.emit({ type: "memory_result", conversationId, requestId: message.requestId, action, ok: true, entries });
        return;
      }
      if (message.type === "memory_update") {
        const changed = await this.memoryStore.update({
          id: message.id,
          expectedVersion: message.expectedVersion,
          text: message.text,
          scope: message.scope,
        });
        this.emit({ type: "memory_result", conversationId, requestId: message.requestId, action, ok: true, entry: changed });
        return;
      }
      await this.memoryStore.forget({ id: message.id, expectedVersion: message.expectedVersion });
      this.emit({ type: "memory_result", conversationId, requestId: message.requestId, action, ok: true, deletedId: message.id });
    } catch (error) {
      this.emit({
        type: "memory_result",
        conversationId,
        requestId: message.requestId,
        action,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  replayState(emit: (message: ServerMessage) => void): void {
    for (const { summary, runtime } of this.entries.values()) {
      for(const result of this.voicePlans.list(summary.id))if(result.plan)emit({type:'agent_event',conversationId:summary.id,event:{kind:'notice',message:'语音计划',plan:result.plan}});
      for (const receipt of this.dispatcher.store.list(summary.id)) emit({type:'agent_event',conversationId:summary.id,event:{kind:'notice',message:receipt.message,receipt}});
      emit({ type: "status", conversationId: summary.id, epochs:this.epochs(runtime),state: runtime.session.isHeld() ? "user" : runtime.session.isStreaming() ? "running" : "idle" });
      void runtime.session.availableModels().then((models) => emit({ type: "model_info", conversationId: summary.id, model: runtime.session.modelName(), models }));
      for (const worker of runtime.fleet.list()) emit({ type: "status", conversationId: summary.id, sessionId: worker.id, state: runtime.fleet.get(worker.id)?.isHeld() ? "user" : worker.streaming ? "running" : "idle" });
      const team = runtime.fleet.teamView();
      if (team) emit({ type: "team_status", conversationId: summary.id, team });
    }
  }

  disconnect(): void {
    this.controls.disconnect();
    for (const { runtime } of this.entries.values()) {
      runtime.rpc.rejectAll(new Error("Extension disconnected"));
      if (!runtime.session.isHeld() && !runtime.fleet.isGroupHeld()) {
        runtime.session.abort();
        runtime.fleet.abortTeam();
      }
    }
  }
  dispose(): void { this.controls.disconnect();for (const { runtime } of this.entries.values()) runtime.dispose(); }
}
