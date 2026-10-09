import { realtimeBrowserError, validateRealtimeBrowserTool, type RealtimeBrowserCall } from './realtime-browser-tools.js';
import { isSupersededUnknown } from '../../shared/task-results.js';
import type { VoiceInputContext } from '../../shared/voice.js';
import {TaskQueue} from "./task-queue.js";
import {TASK_CHECKPOINT_UNAVAILABLE} from '../../shared/task-recovery.js';
import { ReadingRequests } from "./reading.js";
import {join} from "node:path";
import type {UserInputOptions} from "./session.js";
import {VoicePlanStore,type VoicePlanStep,type VoiceProposal} from "./voice-plan-store.js";
import {isControlConfirm,isControlReject,type ControlConfirmSnapshot} from "./voice-confirm.js";
import { createHash, randomUUID } from "node:crypto";
import {
  DEFAULT_CONVERSATION_ID, isLeadSession, normalizeConversationId,
  type ClientMessage, type ConversationSummary, type ServerMessage,
} from "../../shared/protocol.js";
import type { UserDelivery, UserDeliveryKind, UserDeliveryStream } from "../../shared/voice.js";
import { createUserDelivery, projectDeliveryFacts, factsForDelivery } from "./user-delivery.js";
import type { ConversationPersistence } from "./conversation-persistence.js";
import type { createConversationRuntime } from "./conversation-runtime.js";
import type { MemoryStore } from "./memory-store.js";
import { MEMORY_ASK_EXPIRED, MemoryAskClosed } from "./memory-runtime.js";
import { TaskProgress } from "./task-progress.js";
import type { TaskProgressSnapshot, UserDeliveryFacts, VoiceRouteContext, VoiceRouteResult, VoiceTarget } from "../../shared/voice.js";
import { projectTaskView } from "../../shared/task-view.js";
import { isTaskActionRequest, type TaskActionRequest, type TaskReceipt } from "../../shared/task-actions.js";
import { TaskDispatcher, TaskActionRejected, TaskActionFailed, TaskReceiptError } from "./task-dispatcher.js";
import {normalizeSpeech,progressSpeech} from './voice-receipt.js';
import {TaskControlBroker} from './task-control.js';
import {VoiceTurnGate} from './voice-turn.js';
import {isFactFreeClosedUtterance,isVoiceBackchannel,isVoiceSilenceRequest,type VoiceIntentPlan} from './voice-intent.js';
import type {VoiceTurnPreparation} from './voice-model.js';
import {VoiceIntentError} from './voice-errors.js';
import {pageRecoveryKey} from './task-recovery.js';
import {redactTaskSecrets, type TaskHistoryStore} from './task-history.js';
import {memoryHostOfUrl} from '../../shared/memory.js';
import {asksUser} from './goal-check.js';
import {resultHasWriteEffect} from '../../shared/task-results.js';
import type {TaskHistoryEntry} from '../../shared/task-history.js';

type Runtime = Awaited<ReturnType<typeof createConversationRuntime>>;

/** Recognize explicit control language, preserving any separately stated amendment. */
function continuationInput(text:string):{amendment?:string}|null {
  const request=text.trim().replace(/^(?:请\s*|please\s+)/i,'');
  const compound=request.match(/^(继续原任务|继续刚才的任务|继续刚才任务|从中断处继续|接着完成原任务|resume previous task|continue the previous task)\s*[，,；;。:：]\s*(\S[\s\S]*)$/i);

  if(compound)return {amendment:compound[2]!.trim()};
  const normalized = request.replace(/[\s。！!？?，,；;：:]+/g, '').toLowerCase();

  return [
    '继续', '继续原任务', '继续刚才的任务', '继续刚才任务', '从中断处继续', '接着完成原任务',
    'continue', 'resumeprevioustask', 'continuetheprevioustask',
  ].includes(normalized)?{}:null;
}

function isInterruptedResumeText(text:string):boolean { return continuationInput(text)!==null; }

export interface ConversationEntry { summary: ConversationSummary; runtime: Runtime }

/** Identity is captured by each runtime's emitter, never read from the selected panel. */
/** 旧会话能否让出标签页：没有进行中/等待交还/中断的任务、没有在途浏览器调用、没有未知结果的写入。 */
export function tabOwnerIdle(input: { busy: boolean; snapshot: TaskProgressSnapshot | null }): boolean {
  if (input.busy) return false;
  const snapshot = input.snapshot;

  if (!snapshot) return true;

  if (['running', 'paused', 'interrupted'].includes(snapshot.state) || snapshot.active.length) return false;
  const results = snapshot.results ?? [];

  return !results.some(item => item.status === 'unknown' && !isSupersededUnknown(item, results));
}

export class ConversationManager {
  private readonly taskQueue:TaskQueue;
  private readonly pendingStarts=new Set<string>();
  /** Narrow fence while an interrupted run re-reads the page before agent_start. */
  private readonly checkpointResumes=new Set<string>();
  private readonly taskPages=new Map<string,number>();
  private readonly reading = new ReadingRequests();
  private readonly entries = new Map<string, ConversationEntry>();
  private readonly pending = new Map<string, Promise<ConversationEntry>>();
  private readonly requests = new Map<string, Promise<ConversationEntry>>();
  private readonly progress = new Map<string, TaskProgress>();
  private readonly voiceConfirmations=new Map<string,VoiceProposal>();
  /** 语音控制句的读回确认：等用户"对/不"再落动作（改正在跑的任务、终止）。 */
  private readonly controlConfirmations=new Map<string,ControlConfirmSnapshot>();
  private readonly controlVersions=new Map<string,number>();
  private readonly makeupRuns=new Set<string>();
  private readonly voicePlans:VoicePlanStore;
  /** 语义轮次的输出闸门：PREPARING 的交付流前缀先扣住，COMMITTED 之后才对外发。 */
  private readonly voiceTurns=new VoiceTurnGate();
  /** 每个会话当前在跑的提案请求：新一句话到来时先取消它，不让旧候选继续占模型预算。 */
  private readonly voiceTurnAborts=new Map<string,AbortController>();
  voiceTargets(){return [...this.list().map(c=>({id:c.id,title:c.title,runId:this.getTaskProgress(c.id)?.runId??null,controlVersion:this.controlVersions.get(c.id)??0})),...this.taskQueue.list().filter(j=>['queued','suspended'].includes(j.state)&&!this.entries.has(j.request.conversationId)).map(j=>({id:j.request.conversationId,title:j.title,runId:null,controlVersion:0}))];}
  isVoiceTask(origin:string,target:string){const job=this.taskQueue.get(target);

return !!job&&job.request.originConversationId===origin&&job.receipt.runId===this.getTaskProgress(target)?.runId;}
  private queueClosed=false;
  private connected=true;
  reconnect():void { this.connected=true; }
  private pumpTasks(){if(!this.queueClosed&&this.connected)void this.taskQueue.pump().catch(()=>this.emit({type:'agent_event',conversationId:DEFAULT_CONVERSATION_ID,event:{kind:'error',message:'待办调度未能保存状态，请核对任务记录；不会自动重做。'}}));}
  private runningTasks(){return new Set([...this.pendingStarts,...[...this.entries.values()].flatMap(e => e.runtime.session.isStreaming()||this.getTaskProgress(e.summary.id)?.state==='running' ? [e.summary.id] : [])]).size;}
  readonly controls:TaskControlBroker;
  constructor(
    private readonly factory: (id: string, emit: (message: ServerMessage) => void, summary?: ConversationSummary) => Promise<Runtime>,
    private readonly emit: (message: ServerMessage) => void,
    private readonly store?: ConversationPersistence,
    private readonly memoryStore?: MemoryStore,
    readonly dispatcher = new TaskDispatcher(),
  ) {this.controls=new TaskControlBroker(emit);this.voicePlans=new VoicePlanStore(dispatcher.store.directory?join(dispatcher.store.directory,"voice-plans"):undefined);
    this.taskQueue=new TaskQueue({directory:dispatcher.store.directory?join(dispatcher.store.directory,'requirements'):undefined,maxRunning:2,maxWaiting:8,
      enabled:()=>this.connected&&!this.queueClosed,
      running:()=>this.runningTasks(),
      blocked:request=>request.context?.tabId!==undefined&&[...this.taskPages].some(([id,tab])=>tab===request.context!.tabId&&(this.pendingStarts.has(id)||['running','paused'].includes(this.getTaskProgress(id)?.state??''))),
      execute:async request=>{
        if(this.queueClosed||!this.connected)throw new TaskActionRejected('连接已关闭，任务未启动。');
        this.pendingStarts.add(request.conversationId);

        try{
          const entry=await this.create(request.conversationId,request.text?.slice(0,36)||'独立任务');

          if(this.queueClosed){entry.runtime.dispose();throw new TaskActionRejected('连接已关闭，任务未启动。');}

          const receipt=await this.dispatchTaskAction(request,()=>true,request.context?undefined:{pageObservation:'on-demand'});

          if(receipt.status!=='accepted')this.pendingStarts.delete(request.conversationId);

          return receipt;
        }catch(error){this.pendingStarts.delete(request.conversationId);throw error;}
      },
      changed:job=>this.emitReceipt(job.receipt),
    });}

  async ensureDefault(): Promise<ConversationEntry> {
    for (const summary of this.store?.load() ?? []) {
      const restoring = !this.entries.has(summary.id) && !this.pending.has(summary.id);
      const entry = await this.create(summary.id, summary.title, summary);
      const reading = restoring ? this.store?.readingFor?.(summary.id) : undefined;

      if (reading) await entry.runtime.session.importReading(reading);
    }

    return this.create(DEFAULT_CONVERSATION_ID, "新会话");
  }
  get(id: string): ConversationEntry | undefined { return this.entries.get(id); }
  getTaskProgress(id: string): TaskProgressSnapshot | null { const snapshot=this.progress.get(id)?.snapshot();

return snapshot?{...snapshot,controlVersion:this.controlVersions.get(id)??0}:null; }

  /** T02：投影当前真实状态为只读任务视图并下发；内容不变则不发（幂等）。 */
  private readonly lastTaskViews = new Map<string, string>();
  private readonly taskViewQueued = new Set<string>();
  private taskViewDisposed = false;
  /** 微任务合并：同一同步块内的多次突变只发一次，且原始事件先到达。 */
  private queueTaskView(conversationId: string): void {
    if (this.taskViewDisposed || this.taskViewQueued.has(conversationId)) return;
    this.taskViewQueued.add(conversationId);
    queueMicrotask(() => {
      this.taskViewQueued.delete(conversationId);

      if (this.taskViewDisposed) return;
      this.emitTaskView(conversationId);
    });
  }
  private conversationIdle(conversationId: string): boolean {
    const entry = this.entries.get(conversationId);

    return tabOwnerIdle({
      busy: entry?.summary.state === 'running' || !!entry?.runtime.session.isStreaming() || !!entry?.runtime.session.isHeld(),
      snapshot: this.progress.get(conversationId)?.snapshot() ?? null,
    });
  }

  private emitTaskView(conversationId: string, force = false): void {
    const progress = this.progress.get(conversationId);

    if (!progress) return;
    const snapshot = { ...progress.snapshot(), controlVersion: this.controlVersions.get(conversationId) ?? 0 };
    const view = projectTaskView(snapshot);
    const { observedAt: _omit, ...content } = view;
    const key = JSON.stringify(content);

    if (!force && this.lastTaskViews.get(conversationId) === key) return;
    this.lastTaskViews.set(conversationId, key);
    this.emit({ type: "task_view", conversationId, view });
  }
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
    if (this.entries.get(id)?.summary.checkpoint === 'unavailable') throw new TaskActionRejected(TASK_CHECKPOINT_UNAVAILABLE);

    if(route&&!route.resumeReadOnly){
      const result=await this.voicePlans.run(id,route.requestId,{text,voiceId:route.voiceId,turn:route.turn,runId:route.runId,input:route.input,targets:route.targets,controlVersion:route.controlVersion},()=>this.executeVoiceInput(id,text,startedAt,stillCurrent,route));

      if(result.plan&&result.plan.steps.length>1)this.emit({type:'agent_event',conversationId:id,event:{kind:'notice',message:'语音计划',plan:result.plan}});

      return result;
    }

    return this.executeVoiceInput(id,text,startedAt,stillCurrent,route);
  }
  private async executeVoiceInput(id:string,text:string,_startedAt:number|null,stillCurrent:()=>boolean,route?:VoiceRouteContext):Promise<VoiceRouteResult>{
    const session = this.entries.get(id)?.runtime.session;

    if (!session || !text.trim() || text.length > 2000) throw new Error("这句话没有听清或过长，请重新说。");
    const before=this.getTaskProgress(id)!;

    // SDK teardown/preparation can still own the run after a UI idle event.
    if (['none','idle'].includes(before.state) && session.isStreaming()) before.state='running';

    if(route?.recentTurns?.length)before.conversationContext={latestResult:null,...before.conversationContext,recentTurns:[...(before.conversationContext?.recentTurns??[]),...route.recentTurns].slice(-12)};
    const catalog=route?.targets??this.voiceTargets();
    const pending=route?.resumeReadOnly?undefined:this.voiceConfirmations.get(id)??(route?this.voicePlans.proposal(id,route.voiceId,route.turn-1):undefined);
    const short=normalizeSpeech(text);
    // 语音控制句的读回确认：上一轮问过"你是说…吗"，这一轮的"对/不"直接决定动作落不落。
    const control=route?.resumeReadOnly?undefined:this.controlConfirmations.get(id);

    const consumeConfirmation=()=>{
      if(route?.resumeReadOnly)return;

      if(!stillCurrent())throw new TaskActionRejected('语音已结束或你正在说新指令，本句未发送。');

      if(this.controlConfirmations.get(id)===control)this.controlConfirmations.delete(id);

      if(this.voiceConfirmations.get(id)===pending)this.voiceConfirmations.delete(id);

      if(pending)this.voicePlans.update(id,pending.id,{proposal:{...pending,expiresAt:0}});
    };

    if(route&&((control?.voiceId===route.voiceId&&route.turn<=control.turn)||(pending?.voiceId===route.voiceId&&route.turn<=pending.turn))){
      route.onInputDecision?.(false);

      return {kind:'clarify',message:'这句回应已过期，当前待确认要求保持不变。'};
    }

    if(control&&route&&control.voiceId===route.voiceId&&route.turn>control.turn&&Date.now()<control.expiresAt){
      if(isControlReject(text)){consumeConfirmation();route.onInputDecision?.(false);

return {kind:'clarify',message:'好，那我不动它。'};}

      if(isControlConfirm(text)){
        route.onInputDecision?.(false);

        if(!stillCurrent())throw new TaskActionRejected('语音已结束或你正在说新指令，本句未发送。');
        consumeConfirmation();

        // 确认轮可以看着另一页/另一份附件，但送达的必须是复述时那份原要求，且按原控制版本验证。
        const receipt=await this.dispatchTaskAction({
          requestId: route.requestId,
          conversationId: id,
          source: 'voice',
          action: control.action,
          expectedRunId: control.expectedRunId,
          expectedControlVersion: control.expectedControlVersion,
          text: control.text,
          ...(control.action === 'steer' ? {
            ...(control.context ? {context: control.context} : {}),
            ...(control.attachments ? {attachments: control.attachments} : {}),
          } : {}),
        },stillCurrent);

        return receipt.action==='steer'
          ?{kind:'steer',ok:receipt.status==='accepted'||receipt.status==='applied',status:receipt.status,message:receipt.message,receipts:[receipt]}
          :{kind:'action',ok:receipt.status==='accepted'||receipt.status==='applied',status:receipt.status,message:receipt.message,receipts:[receipt]};
      }
    }

    if(pending&&route&&pending.voiceId===route.voiceId&&route.turn>pending.turn&&Date.now()<pending.expiresAt){
      const openReply=short.replace(/(?:另开会话|另开|开吧)$/, '');

      if(isControlConfirm(text)||short==='同意'||(openReply!==short&&(!openReply||isControlConfirm(openReply)))){
        route.onInputDecision?.(false);

        if(!stillCurrent())throw new TaskActionRejected('语音已结束或你正在说新指令，本句未发送。');
        consumeConfirmation();
        const entry=await this.create(pending.conversationId,pending.text.slice(0,36));
        this.emit({type:'conversation_updated',conversationId:entry.summary.id,conversation:{...entry.summary}});
        const receipt=await this.dispatchTaskAction({requestId:route.requestId,conversationId:entry.summary.id,originConversationId:id,source:'voice',action:'start',expectedRunId:null,text:pending.text,...pending.input},stillCurrent);

        return {kind:'action',ok:receipt.status==='accepted',status:receipt.status,message:receipt.message,receipts:[receipt]};
      }

      if(isControlReject(text)||/^(不另开|不要另开会话)$/.test(short)){consumeConfirmation();route.onInputDecision?.(false);

return {kind:'clarify',message:'没有另开会话，原任务保持原状。'};}
    }

    // 失效身份不能留作下一次确认；只读系统恢复完全不触碰待办。
    if(route&&!route.resumeReadOnly&&(
      (control&&(control.voiceId!==route.voiceId||Date.now()>=control.expiresAt))||
      (pending&&(pending.voiceId!==route.voiceId||Date.now()>=pending.expiresAt))
    ))consumeConfirmation();

    // 纯确认只回答已经提出的动作，不能重新交给分类器变成“确认这句确认”。
    if (route && !route.resumeReadOnly && isControlConfirm(text) && (control || pending || short.includes("确认"))) {
      consumeConfirmation();
      route.onInputDecision?.(false);

      return {kind:'clarify',message:control||pending
        ?'刚才那项操作已失效，我没有执行。请重新说明要做什么。'
        :'目前没有等待确认的操作，我没有执行新动作。'};
    }

    // Real confirmation handling above keeps priority. Pure conversational
    // feedback needs neither another model response nor a task action.
    if(!route?.resumeReadOnly&&isVoiceSilenceRequest(text)){
      route?.onInputDecision?.(true);

      return {kind:'silent',quiet:true};
    }

    if(!route?.resumeReadOnly&&isVoiceBackchannel(text)&&(route?.interruptedSpeech||route?.recentTurns?.some(t=>t.role==='assistant'))){
      route?.onInputDecision?.(true);

      return {kind:'silent'};
    }

    route?.reportStage?.('classifying');

    // 准备阶段：一次提案推理同时给出意图计划与批准后要执行的那一件事。
    // 没有提案入口的会话替身仍走原来的分类调用（行为不变）。
    const prepared=route?.resumeReadOnly
      ?{plan:{steps:[{action:route.resumeReadOnly,target:null,text}]},replyText:null,protocol:'plan' as const}
      :before.state==='interrupted'&&isInterruptedResumeText(text)
        ?{plan:{steps:[{action:'resume' as const,target:null,text}]},replyText:null,protocol:'plan' as const}
      :await this.proposeVoiceTurn(id,session,text,before,catalog,route);

    const plan=prepared.plan;
    const single=plan.steps.length===1?plan.steps[0]:undefined;

    const willStart=!route?.resumeReadOnly&&!route?.pendingDelegation&&single?.target===null&&['none','idle'].includes(before.state)
      &&(['observe','chat'].includes(single.action)||single.action==='steer'&&!before.recoveryInput)&&!session.isHeld()&&!session.isStreaming();

    // A capable reply may internally start a session, but that does not turn
    // an old chat/page question into a durable user command. New speech can
    // supersede that reply; only explicit task actions survive a later query.
    route?.onInputDecision?.(plan.steps.every(step=>['chat','status','observe','silence','listen'].includes(step.action)),single?.action==='listen');

    // Waiting has no task effect. Return it while the following utterance is
    // still being captured so the voice ledger can join the unfinished text.
    // Waiting for that next utterance's decision here would lose the prefix.
    if(single?.action==='listen')return {kind:'listening'};
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

      if(action==='listen')return {kind:'listening'};

      if(action==='chat'||action==='observe')return {kind:'none',resumeReadOnly:action};
      throw new TaskActionRejected('语音已结束或你正在说新指令，本句未发送。');
    }

    // 进度/页面查询和空白轮不消耗待确认；新指令或新话题替换旧要求。系统只读恢复由 helper 排除。
    if(willStart||plan.steps.some(step=>!['status','observe','silence','clarify','listen'].includes(step.action)))consumeConfirmation();
    const receipts:TaskReceipt[]=[];

    if(!route?.resumeReadOnly)this.progress.get(id)?.recordUserTurn(text,route?.requestId);
    const versions=new Map(catalog.map(c=>[c.id,c.controlVersion??0]));
    versions.set(id,route?.controlVersion??before.controlVersion??0);
    const expected=new Map(catalog.map(c=>[c.id,c.runId]));
    expected.set(id,route?route.runId:before.runId??null);
    const requestId=route?.requestId??randomUUID();
    const only=plan.steps.length===1?plan.steps[0]:undefined;

    if(route?.nativeChat && only?.action==='chat') return {kind:'none',nativeChat:true};

    if(only?.action==='chat'&&route?.pendingDelegation)return {kind:'none',resumeReadOnly:'chat'};

    // 提交分支 reply：白名单句子的正文已经由最小请求产出，直接走现有交付通道播出。
    // 程序侧再守一道（失败关闭）：只有白名单类别允许直答；其余一律退回原路径，
    // 由主 Agent 带上下文与工具回答。宁可慢，也不靠精简上下文编事实。
    if(prepared.replyText&&only?.action==='chat'&&isFactFreeClosedUtterance(text)){
      if(!stillCurrent())return {kind:'none',resumeReadOnly:'chat'};

      return this.deliverVoiceReply(id,prepared.replyText,before,stillCurrent,route?.turn);
    }

    if(route?.resumeReadOnly==='status'){const targetId=route.resumeTargetId??id,target=this.getTaskProgress(targetId);

return target?{kind:'none',resumeReadOnly:'status',resumeTargetId:targetId,snapshot:target,spokenText:(targetId===id?'':'指定会话：')+progressSpeech(target)}:{kind:'clarify',message:'原目标会话已不可用，请重新询问。'};}

    // Idle conversational requests use the same capable session as typed input.
    // Classification still resolves controls, but cannot strip tools from ordinary content.
    if (willStart) {
      // 既有派发与页面预观察原样复用：observe/需要事实的追问交给主 Agent，由它读页面后回答；
      // 不再给主 Agent 塞"已批准的工具意图"续跑文案（那会丢掉预观察并让它多绕一轮）。
      const inputOptions=single?.action==='chat'?{pageObservation:'on-demand' as const,conversationOnly:true}:undefined;
      const receipt=await this.dispatchTaskAction({requestId,conversationId:id,source:'voice',action:'start',expectedRunId:before.runId??null,expectedControlVersion:versions.get(id),text,...route?.input},stillCurrent,inputOptions);

      // 隐式派发也是真实发生的一步 start：写进计划，让回执反映事实，而不是留下空计划假装零步已知。
      if(route&&!route.resumeReadOnly&&receipt.status==='accepted')this.voicePlans.update(id,route.requestId,{steps:[{action:'start',text,targetId:id,targetTitle:this.entries.get(id)?.summary.title,status:'complete',receipt}]});

      return {kind:'action',ok:receipt.status==='accepted',status:receipt.status,message:receipt.message,receipts:[receipt],awaitDelivery:receipt.status==='accepted',turn:{branch:'read_only',phase:'COMMITTED',protocol:prepared.protocol}};
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

    if(only?.action==='listen')return {kind:'listening'};

    if(only?.action==='silence')return {kind:'silent',quiet:true};
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

      if(step.action==='silence')return {kind:'silent',quiet:true};

      if(step.action==='listen')return {kind:'listening'};

      if(step.action==='clarify')return {kind:'clarify',message:/^(停止|停|停下)[。！!？?\s]*$/.test(step.text.trim())?'你是想停止播报，还是暂停任务？':'请说出目标会话的名称。'};
      const targetId=targetIds[index]!;

      if(step.action==='start'&&targetId===id&&(['running','paused'].includes(before.state)||this.pendingStarts.has(id)||this.runningTasks()>=2)){
        if(!route||!stillCurrent())throw new TaskActionRejected('请求已变化，未登记新任务。');
        const target='voice-'+createHash('sha256').update(id+':'+requestId+':'+index).digest('hex').slice(0,32);
        // Explicit new-tab work does not acquire the source page. Otherwise preserve it and wait for its owner.
        const newPage=/(新(的)?标签页|新(的)?窗口)/.test(step.text);
        const receipt=this.taskQueue.add({requestId:plan.steps.length===1?requestId:`${requestId}-${index}`,conversationId:target,originConversationId:id,source:'voice',action:'start',expectedRunId:null,text:step.text,...(!newPage&&route.input?.context?{context:route.input.context}:{}),...(route.input?.attachments?{attachments:route.input.attachments}:{})},step.text.slice(0,36));
        receipts.push(receipt);journal[index]!.targetId=target;journal[index]!.targetTitle=receipt.targetTitle;journal[index]!.status='complete';journal[index]!.receipt=receipt;save();

        if(receipt.status==='rejected')return {kind:'action',ok:false,status:receipt.status,message:receipt.message,receipts};
        await this.taskQueue.pump();
        const current=this.taskQueue.get(target)!.receipt;
        receipts[receipts.length-1]=current;journal[index]!.receipt=current;save();

        if(!['queued','accepted','applied'].includes(current.status))return {kind:'action',ok:false,status:current.status,message:current.message,receipts};
        continue;
      }

      const sharesInput=targetId===id||/(当前页面|当前页|所选资料|所选图片|所选内容|所选文字|选中的)/.test(step.text);

      // 普通修改与终止都直接送达（2026-09-24 用户决定不再读回）；具体危险网页动作仍由执行层确认。

      if(['pause','resume','abort'].includes(step.action))route?.reportStage?.('controlling');
      journal[index]!.status='pending';save();
      const resumeCheckpoint=step.action==='resume'&&(['interrupted','idle','error'].includes(this.getTaskProgress(targetId)?.state??'')||this.taskQueue.get(targetId)?.state==='suspended');
      const receipt=await this.dispatchTaskAction({expectedControlVersion:versions.get(targetId)??0,requestId:plan.steps.length===1?requestId:`${requestId}-${index}`,conversationId:targetId,...(targetId!==id?{originConversationId:id}:{}),source:'voice',action:step.action,expectedRunId:expected.get(targetId)??null,text:step.text,...(((step.action==='start'||step.action==='steer')&&sharesInput||resumeCheckpoint)?{...(route?.input?.context?{context:route.input.context}:{}),...(route?.input?.attachments?{attachments:route.input.attachments}:{})}:{})},stillCurrent);
      receipts.push(receipt);journal[index]!.status='complete';journal[index]!.receipt=receipt;save();

      if(receipt.status!=='queued'&&receipt.status!=='accepted'&&receipt.status!=='applied') {
        if(step.action==='start'&&receipt.message.includes('另开会话')&&route&&plan.steps.length===1){
          const proposal:VoiceProposal={id:route.requestId,conversationId:'voice-'+createHash('sha256').update(id+':'+route.requestId).digest('hex').slice(0,32),voiceId:route.voiceId,turn:route.turn,expiresAt:Date.now()+90000,text:step.text,...(sharesInput?{input:route.input}:{})};
          this.voiceConfirmations.set(id,proposal);this.voicePlans.update(id,route.requestId,{proposal});

          return {kind:'clarify',message:'当前任务还在执行。要另开会话处理这个新任务吗？'};
        }

        return {kind:step.action==='steer'?'steer':'action',ok:false,status:receipt.status,message:receipt.message,receipts,turn:{branch:'control',phase:'COMMITTED',protocol:'plan'}};
      }

      expected.set(targetId,receipt.runId);

      if(['pause','abort'].includes(step.action)||(step.action==='resume'&&!resumeCheckpoint))versions.set(targetId,(versions.get(targetId)??0)+1);
    }

    const last=receipts.at(-1);

    if(!last)return {kind:'none'};

    if(receipts.length===1&&last.action==='status')return {kind:'none',resumeReadOnly:'status',resumeTargetId:last.conversationId,snapshot:this.getTaskProgress(last.conversationId)!,spokenText:(last.originConversationId?'指定会话：':'')+last.message};

    return {kind:receipts.length===1&&last.action==='steer'?'steer':'action',ok:true,status:last.status,message:receipts.map(r=>r.message).join('；'),receipts,turn:{branch:'control',phase:'COMMITTED',protocol:'plan'}};
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

    if (receipt.status !== 'accepted' && receipt.status !== 'applied') throw new TaskReceiptError(receipt);

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
      // T06：正式结果带上宿主事实链；补发路径与工具路径同一口径，自己写不进事实。
      const facts = kind === "finding" ? this.deliveryFactsOf(conversationId) : undefined;
      const delivery = createUserDelivery({ conversationId, runId, kind, text, replyTo, ...(deliveryId?{id:deliveryId}:{}), ...(facts ? { facts } : {}) });
      const message: ServerMessage = { type: "agent_event", conversationId, event: { kind: "user_delivery", delivery } };
      this.progress.get(conversationId)?.observe(message);
      this.emit(message);

      return delivery;
    } catch {
      return null;
    }
  }
  /** 语音补发沿用正式工具的宿主事实投影，空账本不能证明完成。 */
  private deliveryFactsOf(conversationId: string): UserDeliveryFacts | undefined {
    const progress = this.progress.get(conversationId);

    if (!progress) return undefined;
    const facts = progress.deliveryFacts();
    const snap = this.getTaskProgress(conversationId);

    return projectDeliveryFacts(factsForDelivery(facts,snap?.nextStep), snap?.nextStep);
  }
  /**
   * 准备 → 校验 → 提交。一次提案推理同时给出意图计划与 next；
   * 校验不通过或超时（VoiceIntentError）由调用方给确定的失败回执，轮次进入 DISCARDED，
   * 候选输出全部丢弃，绝不自动放行。
   *
   * 没有提案入口的会话（测试替身、工人）仍走原来的分类调用，行为不变。
   */
  private async proposeVoiceTurn(id:string,session:Runtime['session'],text:string,before:TaskProgressSnapshot,catalog:VoiceTarget[],route?:VoiceRouteContext):Promise<{plan:VoiceIntentPlan;replyText:string|null;protocol:'free_reply'|'plan'}>{
    const titles=catalog.flatMap(c=>text.includes(c.title) ? [c.title] : []);

    if(typeof session.prepareVoiceTurn!=='function'||session.canPrepareVoiceTurn?.()===false){
      return {plan:await session.classifyVoiceInput(text,before.state,titles,{goal:before.goal,requestId:route?.requestId},before.conversationContext),replyText:null,protocol:'plan' as const};
    }

    const turnId=route?.requestId??`${route?.voiceId??id}-${route?.turn??randomUUID()}`;
    // 同一会话里上一轮还没拿到终态：已在准备的是被新一句话取代（INTERRUPTED，前缀丢弃）；
    // 已经提交的是正常做完（COMPLETED）。取消顺序里"先失效"的一步：旧候选的模型请求先取消。
    this.voiceTurnAborts.get(id)?.abort();
    const abort=new AbortController();
    this.voiceTurnAborts.set(id,abort);

    for(const previous of this.voiceTurns.preparing(id)){
      if(previous===turnId)continue;
      this.releaseVoiceOutput(id,this.voiceTurns.interrupt(previous));
    }

    for(const previous of this.voiceTurns.committed?.(id)??[])this.voiceTurns.complete(previous);
    this.voiceTurns.begin(turnId,id);
    // 失败关闭：默认这句话需要外部事实（页面/任务/记忆），走精简协议 + 原派发，由主 Agent 带上下文回答。
    // 只有程序能确定"不需要任何外部事实"的封闭类别（问候/寒暄/致谢/告别/应答、纯算术）才走独立最小请求，
    // 由模型直接给一两句正文。两条路径都不发计划 JSON：白名单句子不发计划提示词（模型会误读"不要编事实"而拒答），
    // 其余句子走与旧分类逐字同形的精简协议，控制链/派发之前的固定成本不因合并而增加。
    const protocol=!route?.nativeChat&&isFactFreeClosedUtterance(text)?'free_reply' as const:'plan' as const;
    let prepared:VoiceTurnPreparation;

    try{
      prepared=await session.prepareVoiceTurn({text,state:before.state,conversationTitles:titles,task:{goal:before.goal,requestId:route?.requestId},conversation:before.conversationContext},{cancel:abort.signal,protocol});
    }catch(error){
      // 校验不通过或超时：候选进入 DISCARDED，前缀丢弃；被扣住的真实交付仍然送达。
      if(this.voiceTurnAborts.get(id)===abort)this.voiceTurnAborts.delete(id);
      this.releaseVoiceOutput(id,this.voiceTurns.discard(turnId));
      throw error;
    }

    if(this.voiceTurnAborts.get(id)===abort)this.voiceTurnAborts.delete(id);
    const released=this.voiceTurns.commit(turnId);

    if(!released)throw new VoiceIntentError('classifier_invalid_reply','turn_superseded');
    this.releaseVoiceOutput(id,released);

    return {plan:prepared.plan,replyText:prepared.replyText,protocol:prepared.protocol};
  }
  /** 把闸门放出的本轮输出按原顺序发出去（交付流先于正式交付，保持原有先后关系）。 */
  private releaseVoiceOutput(id:string,released:{streams:UserDeliveryStream[];deliveries:UserDelivery[]}):void{
    for(const stream of released.streams)this.emit({type:'agent_event',conversationId:id,event:{kind:'user_delivery_stream',stream}});

    for(const delivery of released.deliveries){
      const message:ServerMessage={type:'agent_event',conversationId:id,event:{kind:'user_delivery',delivery}};
      this.progress.get(id)?.observe(message);
      this.emit(message);
    }
  }
  /** 提交分支 reply 的正式交付：正文已在同一次推理里产出，这里只发布，不再补模型请求。 */
  private deliverVoiceReply(id:string,text:string,before:TaskProgressSnapshot,stillCurrent:()=>boolean,voiceTurn?:number):VoiceRouteResult{
    const originRun=before.runId??null,originControl=this.controlVersions.get(id)??0;
    const streaming=this.beginDeliveryStream(id,'reply',before,stillCurrent,voiceTurn);

    if(streaming.onText(text)===false){streaming.cancel();

return {kind:'none',resumeReadOnly:'chat'};}

    const delivery=this.publishDelivery(id,'reply',text,text,{runId:originRun,controlVersion:originControl},streaming.id);

    if(!delivery){streaming.cancel();

return {kind:'none',resumeReadOnly:'chat'};}

    const published=this.getTaskProgress(id);

    return {kind:'none',resumeReadOnly:'chat',snapshot:published??undefined,spokenText:delivery.text,turn:{branch:'reply',phase:'COMMITTED',protocol:'free_reply'}};
  }
  private beginDeliveryStream(conversationId:string,kind:UserDeliveryKind,before:TaskProgressSnapshot,stillCurrent:()=>boolean,voiceTurn?:number){
    const id=randomUUID(),runId=before.runId??null,control=this.controlVersions.get(conversationId)??0;
    let sent=false;

    return {id,onText:(text:string)=>{
      const now=this.getTaskProgress(conversationId);

      if(!stillCurrent()||!now||now.runId!==runId||(this.controlVersions.get(conversationId)??0)!==control||['paused','aborted','error'].includes(now.state))return false;
      sent=true;this.emit({type:'agent_event',conversationId,event:{kind:'user_delivery_stream',stream:{id,runId,kind,text,phase:'streaming',...(voiceTurn!==undefined?{voiceTurn}:{})}}});

return true;
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

      if (!stillCurrent() || !now || now.runId !== originRun || (this.controlVersions.get(id) ?? 0) !== originControl) {streaming.cancel();

return { kind: "silent" };}

      if (now.state === "error" || now.state === "aborted" || now.state === "paused") {streaming.cancel();

return { kind: "silent" };}

      const delivery = this.publishDelivery(id, "reply", spoken, text, { runId: originRun, controlVersion: originControl },streaming.id);

      if (!delivery) {streaming.cancel();

return { kind: "silent" };}

      const published = this.getTaskProgress(id);

      return { kind: "none", resumeReadOnly: "chat", snapshot: published ?? now, spokenText: delivery.text };
    } catch {
      streaming.cancel();
      const now = this.getTaskProgress(id);

      if (!now || now.runId !== originRun) return { kind: "silent" };

      return { kind: "none", spokenText: "这一轮的正式回答还没有交出来。" };
    }
  }
  private makeupFacts(snap: TaskProgressSnapshot): string | null {
    const latest = snap.conversationContext?.latestResult?.text?.trim();

    if (latest) return latest;
    const results = snap.results ?? [];

    if (results.length) {
      return results.map((item) => `${item.description}：${item.status}`).join("\n").slice(0, 6000);
    }

    if (snap.lastAction) {
      return `最后动作：${snap.lastAction.action}${snap.lastAction.failed ? "（未成功）" : ""}。`;
    }

    if (snap.startedAt !== null && snap.goal) return `任务「${snap.goal}」已结束，没有形成文字结果。`;

    return null;
  }
  /** 模型调用 hand_to_user：与侧栏「接管」同一条暂停通道，扩展确认页面已归用户后才返回。 */
  private async handToUser(id:string,ask:string):Promise<void>{
    const runId=this.getTaskProgress(id)?.runId;

    if(!runId)throw new Error('没有正在执行的任务，页面没有交给用户。');
    this.controlVersions.set(id,(this.controlVersions.get(id)??0)+1);
    const result=await this.controls.request(id,randomUUID(),'pause',runId,'page',undefined,ask);

    if(!result.ok)throw new Error(result.reason??'页面没有交给用户。');
  }

  /** 文字新消息是否接着做上一个没做完的任务：只在确有没做完的任务时按简单规则判断，不调模型。 */
  private async continuesOpenTask(request:TaskActionRequest,snapshot:TaskProgressSnapshot,entry:ConversationEntry):Promise<boolean>{
    if(request.source!=='text'||request.action!=='start'||request.forkedFrom||!request.text?.trim())return false;

    if(!['idle','error'].includes(snapshot.state)||!snapshot.runId||!snapshot.goal||!snapshot.recoveryInput||!request.context?.tabId)return false;
    const view=projectTaskView(snapshot);

    if(!view.resumable)return false;
    const session=entry.runtime.session;

    if(!session.available||session.isStreaming())return false;
    const lastReply=[...(snapshot.conversationContext?.recentTurns??[])].reverse().find(turn=>turn.role==='assistant')?.text??'';

    // 不另调模型判断：任务正等用户回话（核对说「等用户」或助手最后在问用户），这句就按接着做（09-27 回的邮箱被当成了新任务）。
    return view.goalStatus?.status==='waiting'||asksUser(lastReply);
  }
  /** 过往任务：宿主在 host-core 里接上；没有就不记。 */
  taskHistory?: TaskHistoryStore;
  /** 输入框旁选的思考强度；没选过为 undefined（按模型登记的起始档）。 */
  private thinkingDeep: boolean | undefined;

  /**
   * 任务一轮结束时留一条摘要。只记动手做过事的任务（列过目标或有执行记录），纯聊天和读页问答不记。
   * 同一任务接着做（恢复同一 runId）时覆盖原条目。写失败只丢这条摘要，不影响任务。
   */
  /** 这一轮在等目标核对结论的会话：结论到之前不记过往任务。 */
  private readonly goalCheckPending = new Set<string>();

  private recordTaskHistory(id: string): void {
    const history=this.taskHistory,progress=this.progress.get(id),snap=this.getTaskProgress(id);

    if(!history||!progress||!snap?.runId||!snap.goal||!['idle','aborted','error'].includes(snap.state))return;

    // 只记动手做过事的任务（有改动页面的执行记录），或还没做完、在等用户的任务。读页、查询、纯聊天（核对为「做完」）不记：
    // 09-27 阶跃实测「我的手机号是 …」被记成一条过往任务，撤销记忆后号码仍留在过往任务里。
    const acted=(snap.results??[]).some(item=>resultHasWriteEffect(item));

    if(!acted&&(!snap.goalCheck||snap.goalCheck.status==='done'))return;
    const view=projectTaskView(snap);
    const delivery=snap.conversationContext?.latestDelivery;
    const lastReply=[...(snap.conversationContext?.recentTurns??[])].reverse().find(turn=>turn.role==='assistant')?.text??'';

    // 只有 http(s) 网页算网站：扩展页、浏览器页不记成网站。
    const hosts=[...new Set(progress.visitedUrls().flatMap(url=>{const host=memoryHostOfUrl(url);

return host?[host]:[];}))].slice(0,16);

    const clip=(text:string,max:number)=>text.length>max?`${text.slice(0,max-1)}…`:text;
    const unfinished=(snap.goalCheck?(snap.goalCheck.status!=='done'&&snap.goalCheck.remaining?[snap.goalCheck.remaining]:[]):delivery?.unfinished?.length?delivery.unfinished:view.outstanding.map(item=>item.description)).slice(0,16).map(text=>clip(text,300));

    const raw:TaskHistoryEntry={
      id:snap.runId,conversationId:id,goal:clip(snap.goal,600),
      revisions:(snap.recoveryInput?.requirements??[]).filter(text=>text!==snap.goal).slice(-16).map(text=>clip(text,600)),
      hosts,
      outcome:snap.state==='aborted'?'stopped':snap.state==='error'?'error':snap.goalCheck?(snap.goalCheck.status==='done'?'complete':'partial'):view.resumable||unfinished.length?'partial':'complete',
      summary:clip((delivery?.text||lastReply).replace(/\s+/g,' ').trim(),600),
      unfinished,startedAt:snap.startedAt,endedAt:Date.now(),
    };

    if(snap.goalPage?.title)raw.page=clip(snap.goalPage.title,200);
    // 像密码验证码的用户原话不进过往任务，也不交给判断日期的模型。
    const entry=redactTaskSecrets(raw);
    // 决定点 A（任务结束）：结果关联哪一天（订的是哪天的票）→ 标上日期，有效期到那天结束。判断不了照样记，只是不带日期。
    // 先立即写入（查「之前订了什么」不用等，也不会因等待被删后复活）；日期晚到时只补 date/validity。
    const session=this.entries.get(id)?.runtime.session;
    const written=history.record(entry).catch(()=>{});

    const dating=(session?.datePastTask?.(entry)??Promise.resolve(null)).catch(()=>null);
    void Promise.all([written,dating]).then(([,dated])=>dated?history.patchDate(entry.id,entry.endedAt,dated):undefined).catch(()=>{});
    // 没做完的事：起短主题与下一步，给「继续上次的事」；晚到时只补这两个字段。
    const labeling=(session?.labelPastTask?.(entry)??Promise.resolve(null)).catch(()=>null);
    void Promise.all([written,labeling]).then(([,label])=>label?history.patchLabel(entry.id,entry.endedAt,label):undefined).catch(()=>{});

    // 改过页面的任务计入习惯：同一件事在 3 个对话里做过，就问一次要不要记住。
    if(acted)void session?.noticeHabit?.(entry).catch(()=>{});
  }
  private async fulfillOwedDelivery(id: string): Promise<void> {
    const progress = this.progress.get(id);
    const session = this.entries.get(id)?.runtime.session;
    const snap = this.getTaskProgress(id);
    const facts = snap ? this.makeupFacts(snap) : null;

    if (!progress || !snap || !facts || snap.state !== "idle" || !snap.runId) return;
    const existing = snap.conversationContext?.latestDelivery;

    if (progress.hasFinding() || (existing && existing.kind !== "ack" && existing.runId === snap.runId)) return;

    if(snap.nextStep?.delivery==='none')return;

    if(snap.nextStep?.delivery==='partial'){
      // A fallback must not bypass the same decision that rejected a premature
      // finding tool. No extra completion request or unsafe spoken prefix here.
      const count=(snap.results??[]).filter(item=>item.status==='satisfied').length;

      // 一步都没做成（常见于模型报错）：出错原因已在侧栏，单独一句「没做完」只是账本的话。
      if(!count)return;
      // 账本只有「填写 @4」这类步骤名，说不出用户的话；只说发生了什么，请用户看页面（10-09 用户定）。
      this.publishDelivery(id,'finding','助手没给出最后的回答就停了。页面上可能已经改了一部分，请看一下。',
        undefined,{runId:snap.runId,controlVersion:snap.controlVersion,states:['idle']});

      return;
    }

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
      // 模型正文通常已由会话在本轮结束时直接交付；走到这里的是没有正文或正文未能交付的兜底。
      const spoken=await session.composeUserDelivery({question:snap.goal,facts,
        recentTurns:snap.conversationContext?.recentTurns??[],latestDelivery:snap.conversationContext?.latestDelivery??null},streaming.onText);

      const now = this.getTaskProgress(id);

      if (!now || now.runId !== originRun || now.state !== "idle" || (this.controlVersions.get(id) ?? 0) !== originControl) {streaming.cancel();

return;}

      if (this.progress.get(id)?.hasFinding() || (now.conversationContext?.latestDelivery && now.conversationContext.latestDelivery.kind !== "ack")) {streaming.cancel();

return;}

      if (!this.publishDelivery(id, "finding", spoken, undefined, { runId: originRun, controlVersion: originControl, states: ["idle"] },streaming.id)) {streaming.cancel();

return;}
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
  /**
   * 把当前 runId 立刻发布给扩展。扩展 executeToolCall 按 conversationSummaries.runId 校验每个工具帧，
   * 新任务的首轮预观察会先发 snapshot 帧；身份若还没同步过去就会被判成"原任务已停止或发生变化"。
   */
  private publishRunIdentity(conversationId: string): void {
    const entry = this.entries.get(conversationId);
    const snapshot = this.getTaskProgress(conversationId);

    if (!entry || !snapshot) return;
    entry.summary.runId = snapshot.runId ?? null;

    if(snapshot.state==='interrupted')entry.summary.checkpoint='interrupted';
    else delete entry.summary.checkpoint;
    entry.summary.updatedAt = Date.now();
    this.store?.save(this.list());
    this.emit({ type: "conversation_updated", conversationId, conversation: { ...entry.summary } });
  }
  private readonly directVoiceInputs = new Map<string, {inputId: string; runId: string | null}>();

  async executeRealtimeBrowserTool(id: string, call: RealtimeBrowserCall, input: VoiceInputContext, signal: AbortSignal): Promise<unknown> {
    validateRealtimeBrowserTool(call.name, call.args);
    const entry = this.entries.get(id), progress = this.progress.get(id);

    if (!entry || !progress || !this.connected || signal.aborted) throw realtimeBrowserError('语音会话或浏览器连接已失效，未执行。', 'not_executed');
    const snapshot = progress.snapshot();

    const readOnly = ['snapshot','read_element','read_elements'].includes(call.name)
      || call.name === 'tabs' && ['list','active'].includes(String(call.args.action));

    if (entry.runtime.session.isStreaming() || entry.runtime.session.isHeld() || this.pendingStarts.has(id) || ['running','paused'].includes(snapshot.state)
      || snapshot.state === 'interrupted' && !readOnly) {
      throw realtimeBrowserError('原任务仍在执行、接管或等待恢复；请先处理原任务，未并发操作页面。', 'not_executed');
    }

    const previous = this.directVoiceInputs.get(id);

    if (previous?.inputId === call.inputId && previous.runId !== snapshot.runId) throw realtimeBrowserError('原任务已变化，旧语音工具未执行。', 'not_executed');
    const auditMissing = snapshot.runId && (snapshot.unresolvedEffect || snapshot.untrackedWritePending || snapshot.executionAuditComplete === false);

    if (auditMissing && !readOnly) {
      throw realtimeBrowserError(`原任务 ${snapshot.runId} 缺少可关联的执行记录，无法安全解除写入限制。可先读取页面或列出标签核查；历史记录不足时需人工核对原任务，不能用新语音清除风险。`, 'not_executed');
    }

    const unknown = snapshot.results?.some(item => item.status === 'unknown' && !isSupersededUnknown(item, snapshot.results ?? []));

    if (previous?.inputId !== call.inputId) {
      const before = snapshot;

      // Inspection belongs to the unresolved run. Never reset its receipts on a new voice input.
      if (!auditMissing && !unknown && snapshot.state !== 'interrupted') progress.request(call.text,input.context,input.attachments);
      else progress.recordUserTurn(call.text,call.inputId);

      try { await entry.runtime.session.persistAcceptedTask(progress.snapshot(),input.attachments); }
      catch (error) { progress.restoreResults(before); throw realtimeBrowserError(error, 'not_executed'); }

      entry.runtime.session.prepareRealtimeBrowserInput(call.text,input.context);
      this.directVoiceInputs.set(id,{inputId:call.inputId,runId:progress.snapshot().runId ?? null});
      this.publishRunIdentity(id);
    }

    return entry.runtime.session.executeRealtimeBrowserTool(call.name,call.args,signal,{inputId:call.inputId,runId:progress.snapshot().runId ?? null});
  }

  async dispatchTaskAction(request: TaskActionRequest, stillCurrent = () => true, inputOptions?: UserInputOptions): Promise<TaskReceipt> {
    if (!isTaskActionRequest(request)) throw new Error('无效的任务请求');

    const waiting=this.taskQueue.get(request.conversationId);

    if(waiting&&['queued','suspended'].includes(waiting.state)&&request.action!=='start'){
      if(!stillCurrent()||request.expectedRunId!==null)throw new TaskActionRejected('待办身份已变化，操作未执行。');

      const receipt=await this.dispatcher.dispatch(request,waiting.title,async()=>{
        if (this.entries.get(request.conversationId)?.summary.checkpoint === 'unavailable') throw new TaskActionRejected(TASK_CHECKPOINT_UNAVAILABLE);

        if(request.action==='resume'&&!this.connected)throw new TaskActionRejected('连接尚未恢复，待办仍保留。');

        if(request.action==='resume'&&waiting.request.context){
          const original=pageRecoveryKey(waiting.request.context.tabId,waiting.request.context.url);

          if(!original||!request.context||pageRecoveryKey(request.context.tabId,request.context.url)?.urlHash!==original.urlHash)throw new TaskActionRejected('请先打开这项待办原来的页面再继续；原要求和附件仍保留。');
        }

        const result=request.action==='abort'?this.taskQueue.cancel(request.conversationId):request.action==='steer'?this.taskQueue.revise(request.conversationId,request.text??''):request.action==='status'?this.taskQueue.get(request.conversationId)?.receipt:request.action==='resume'?this.taskQueue.resumePending(request.conversationId,request.context):undefined;

        if(!result)throw new TaskActionRejected('待办已变化，这条操作未执行。');

        return {...result,status:request.action==='steer'?'accepted':request.action==='status'?'applied':result.status};
      });

      this.emitReceipt(receipt);

if(request.action==='resume'&&receipt.status==='queued')this.pumpTasks();

return receipt;
    }

    const currentTitle=this.entries.get(request.conversationId)?.summary.title;
    const title = request.action==='start'&&currentTitle==='新会话' ? request.text?.trim().slice(0,36)||currentTitle : currentTitle ?? '会话不可用';
    const originalRequest = request;

    const receipt = await this.dispatcher.dispatch(originalRequest,title,async()=>{
      if (!stillCurrent()) throw new TaskActionRejected('语音已结束或你正在说新指令，本句未发送。');
      const entry = this.entries.get(originalRequest.conversationId);
      let snapshot = this.getTaskProgress(originalRequest.conversationId);

      if (!entry || !snapshot) throw new TaskActionRejected('目标会话不可用，操作未执行。');

      if (entry.summary.checkpoint === 'unavailable') throw new TaskActionRejected(TASK_CHECKPOINT_UNAVAILABLE);
      // The panel sends ordinary typed input as start. Resolve continuation inside
      // the acceptance boundary so retries retain the ORIGINAL request fingerprint.
      const continuation=originalRequest.source==='text'?continuationInput(originalRequest.text??''):null;
      const explicitAmendment=!!continuation?.amendment&&!!snapshot.runId&&!!snapshot.recoveryInput;

      let request = originalRequest.source === 'text' && originalRequest.action === 'start' && !originalRequest.forkedFrom
        && continuation
        && (snapshot.state === 'interrupted' || ['idle','error'].includes(snapshot.state) && (projectTaskView(snapshot).resumable||explicitAmendment))
        ? { ...originalRequest, action: 'resume' as const } : originalRequest;

      // 任务不随一轮结束：上一个任务还没做完时，随口补的一句（不必说「继续」）由快速模型判断是不是接着做它；
      // 是就按补充交给原任务（下面 steer 分支：登记为修订、从原任务接着做），目标不变。
      if (request===originalRequest&&await this.continuesOpenTask(originalRequest,snapshot,entry))request={...originalRequest,action:'steer' as const};

      if (request.expectedRunId !== (snapshot.runId??null))throw new TaskActionRejected('原任务已停止或发生变化，操作未执行。');

      if(request.expectedControlVersion!==undefined&&request.expectedControlVersion!==(this.controlVersions.get(request.conversationId)??0))throw new TaskActionRejected('页面控制权已再次变化，旧计划的后续步骤未执行。');

      if (request.action === 'status')return {status:'applied',runId:snapshot.runId??null,message:progressSpeech(snapshot)};

      if(!this.connected&&request.action!=='abort')throw new TaskActionRejected('连接尚未恢复，原任务和待办已保留。');

      const amendment=request.action==='resume'&&originalRequest.source==='text'
        ?continuation?.amendment:undefined;

      if(amendment&&(snapshot.state==='interrupted'||['idle','error'].includes(snapshot.state)&&explicitAmendment)) {
        const progress=this.progress.get(request.conversationId)!;
        const rollback=progress.recordRequirement(amendment,undefined,request.attachments);

        try {
          await entry.runtime.session.persistRecoveryAttachments?.(snapshot.runId??null,request.attachments);
          await entry.runtime.session.persistTaskResults?.(progress.snapshot());
        } catch(error) { rollback(); throw error; }

        progress.recordUserTurn(originalRequest.text??'',request.requestId);
        snapshot=progress.snapshot();
      }

      if (request.action==='steer' && ['idle','error'].includes(snapshot.state) && !entry.runtime.session.isStreaming()) {
        if (!snapshot.runId || !snapshot.recoveryInput || !request.context?.tabId || !entry.runtime.session.available) throw new TaskActionRejected('续接需要原任务记录、当前页面和可用模型；补充尚未发送。');

        if(this.runningTasks()>=2)throw new TaskActionRejected('当前执行名额已满；这条续接未执行，原任务记录保持不变。');
        const progress=this.progress.get(request.conversationId)!;
        const rollback=progress.recordRequirement(request.text??'',request.context,request.attachments);

        try {
          await entry.runtime.session.persistRecoveryAttachments?.(snapshot.runId,request.attachments);
          await entry.runtime.session.persistTaskResults?.(progress.snapshot());
        } catch(error) { rollback(); throw error; }

        progress.recordUserTurn(request.text??'',request.requestId);
        progress.interrupt('manual_continuation');
        snapshot=progress.snapshot();
        request={...request,action:'resume'};
      }

      // 刚登记的修订本身就是待做的事：已结束的任务带修订继续时，不依赖未完成项才能接续。
      if(['idle','error'].includes(snapshot.state)&&(projectTaskView(snapshot).resumable||explicitAmendment)
        &&(request.action==='resume'||request.action==='start'&&isInterruptedResumeText(request.text??''))){
        if(request.action!=='resume')throw new TaskActionRejected('请继续原任务，不要将未完成事项重新登记为新任务。');

        if(!request.context?.tabId||!entry.runtime.session.available)throw new TaskActionRejected('继续前需要当前页面和可用模型，原任务的未完成记录保持不变。');
        this.progress.get(request.conversationId)!.interrupt('manual_continuation');
        snapshot=this.getTaskProgress(request.conversationId)!;
        this.publishRunIdentity(request.conversationId);
      }

      if(request.action==='resume'&&snapshot.state==='interrupted'){
        if(!request.expectedRunId||!snapshot.goal)throw new TaskActionRejected('没有可从检查点继续的原任务。');

        if(this.checkpointResumes.has(request.conversationId))throw new TaskActionRejected('正在从检查点恢复原任务，请不要重复继续。');

        if(this.runningTasks()>=2)throw new TaskActionRejected('当前执行名额已满，原任务仍保留在检查点；请稍后再继续。');

        if(!entry.runtime.session.available)throw new TaskActionRejected('当前执行模型不可用，原任务仍保留在检查点。');

        if(!request.context?.tabId)throw new TaskActionRejected('继续前需要打开原任务页面，让我先重新读取当前状态。');
        this.taskPages.set(request.conversationId,request.context.tabId);
        this.pendingStarts.add(request.conversationId);
        this.checkpointResumes.add(request.conversationId);
        const version=this.controlVersions.get(request.conversationId)??0;

        try{
          await entry.runtime.session.waitForStop?.();
          const now=this.getTaskProgress(request.conversationId);

          if(!this.connected||!stillCurrent()||!now||now.runId!==snapshot.runId||now.state!=='interrupted'||version!==(this.controlVersions.get(request.conversationId)??0))throw new TaskActionRejected('原检查点已取消或发生变化，恢复任务未启动。');
          this.progress.get(request.conversationId)!.prepareResume();
          await entry.runtime.session.resumeInterruptedTask(snapshot,request.context,request.attachments);
        }
        catch(error){this.pendingStarts.delete(request.conversationId);this.checkpointResumes.delete(request.conversationId);throw error;}

        return {action:'resume' as const,status:'accepted',runId:request.expectedRunId,message:'已从检查点继续原任务；先重新读取当前页面，再处理未完成项。'};
      }

      if(request.action==='pause'&&snapshot.state==='interrupted'){
        this.controlVersions.set(request.conversationId,(this.controlVersions.get(request.conversationId)??0)+1);
        this.pendingStarts.delete(request.conversationId);this.checkpointResumes.delete(request.conversationId);
        this.progress.get(request.conversationId)!.interrupt(snapshot.interruptionReason??'manual_continuation');
        entry.runtime.session.abort();
        await entry.runtime.session.persistTaskResults?.(this.progress.get(request.conversationId)!.snapshot());

        return {status:'applied',runId:request.expectedRunId,message:'恢复已停止，原任务仍保留在检查点；没有继续执行。'};
      }

      if(request.action==='abort'&&snapshot.state==='interrupted'){
        this.pendingStarts.delete(request.conversationId);
        this.checkpointResumes.delete(request.conversationId);
        this.controlVersions.set(request.conversationId,(this.controlVersions.get(request.conversationId)??0)+1);
        this.progress.get(request.conversationId)?.abort();
        entry.runtime.handleMessage({type:'abort'});
        await entry.runtime.session.persistTaskResults?.(this.progress.get(request.conversationId)!.snapshot());

        return {status:'applied',runId:request.expectedRunId,message:'已终止保留在检查点的原任务。'};
      }

      if (request.action === 'start') {
        const reserved=this.taskQueue.get(request.conversationId);
        const ownsReservation=reserved?.state==='starting'&&reserved.request.requestId===request.requestId;

        if((this.pendingStarts.has(request.conversationId)&&!ownsReservation)||snapshot.state==='running'||entry.runtime.session.isStreaming())throw new TaskActionRejected('当前任务还在执行。要另开会话处理这个新任务吗？', true);

        if(snapshot.state==='paused'||entry.runtime.session.isHeld())throw new TaskActionRejected('页面现在归你。请继续原任务，或另开会话。');

        if(this.runningTasks()-(ownsReservation?1:0)>=2)throw new TaskActionRejected('当前执行名额已满，请等待运行中的任务完成。');

        if(request.context?.tabId!==undefined)this.taskPages.set(request.conversationId,request.context.tabId);

        if(!entry.runtime.session.available)throw new TaskActionRejected('当前执行模型不可用，任务未启动。');

        // A click that moves a rejected voice request consumes only that matching proposal.
        if (request.forkedFrom) {
          const source = request.forkedFrom;
          const original = this.dispatcher.get(source.conversationId, source.requestId);

          if (!original?.newConversationRequest) throw new TaskActionRejected('原请求已变化，请重新确认任务内容。');
          const proposal = this.voiceConfirmations.get(source.conversationId);

          if (proposal?.id === source.requestId) {
            this.voiceConfirmations.delete(source.conversationId);
            this.voicePlans.update(source.conversationId, proposal.id, {proposal:{...proposal,expiresAt:0}});
          }
        }

        // “已接收”回执必须以真实可恢复存储为准：先把附件与检查点写盘，失败则回滚为未接收，
        // 不启动模型或网页动作。
        const targetProgress=this.progress.get(request.conversationId)!;
        const beforeAccept=targetProgress.snapshot();
        targetProgress.request(request.text??'',request.context,request.attachments);

        if (inputOptions?.conversationOnly) targetProgress.goals.clear();
        const acceptedRunId=targetProgress.snapshot().runId??null;

        try{
          if(entry.runtime.session.persistAcceptedTask)await entry.runtime.session.persistAcceptedTask(targetProgress.snapshot(),request.attachments);
          else{
            // Test/legacy runtime fallback; production BrowserAgentSession uses the atomic envelope above.
            await entry.runtime.session.persistRecoveryAttachments?.(acceptedRunId,request.attachments);
            await entry.runtime.session.persistTaskResults?.(targetProgress.snapshot());
          }
        }catch(error){
          targetProgress.restoreResults(beforeAccept);
          throw new TaskActionRejected(`任务未能保存到本地，尚未接收、没有启动：${error instanceof Error?error.message:String(error)}`);
        }

        this.taskQueue.bindRun(request.conversationId,acceptedRunId);

        if(entry.summary.title==='新会话')entry.summary.title=title;
        this.publishRunIdentity(request.conversationId);
        this.pendingStarts.add(request.conversationId);

        try{
          if(inputOptions)entry.runtime.session.startTask(request.text??'',request.context,request.attachments,inputOptions);
          else entry.runtime.session.startTask(request.text??'',request.context,request.attachments);
        }catch(error){this.pendingStarts.delete(request.conversationId);throw error;}

        return {status:'accepted',runId:entry.summary.runId??null,message:`已接收新任务：${request.text??'使用所选资料'}`};
      }

      if(request.action==='pause'||request.action==='resume'||request.action==='abort'){
        if(!request.expectedRunId)throw new TaskActionRejected('当前没有可控制的任务。');

        if(request.action==='resume'&&!entry.runtime.session.isHeld()&&!entry.runtime.control.isGroupHeld())throw new TaskActionRejected(snapshot.state==='aborted'?'任务已经终止，不能继续原任务。':'原任务没有暂停，未执行交还。');

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

      if(snapshot.state==='interrupted'){
        if(this.checkpointResumes.has(request.conversationId))throw new TaskActionRejected('正在恢复检查点，这条修改尚未发送。');
        const progress=this.progress.get(request.conversationId)!;
        progress.recordRequirement(request.text??'',undefined,request.attachments);
        await entry.runtime.session.persistRecoveryAttachments?.(snapshot.runId??null,request.attachments);
        progress.reviseResults();progress.recordUserTurn(request.text??'',request.requestId);
        await entry.runtime.session.persistTaskResults?.(progress.snapshot());

        return {status:'accepted',runId:snapshot.runId??null,message:'修改已保存到原任务；明确说“继续原任务”后再执行。'};
      }

      if(entry.runtime.session.isHeld()){
        const originRun=snapshot.runId;
        this.progress.get(request.conversationId)!.recordRequirement(request.text??'',request.context,request.attachments);
        await entry.runtime.session.persistRecoveryAttachments?.(originRun??null,request.attachments);
        entry.runtime.session.queueSteerForResume(request.text??'',request.context,request.attachments);

        if(this.progress.get(request.conversationId)?.snapshot().runId===originRun) {
          this.progress.get(request.conversationId)?.reviseResults();
          this.progress.get(request.conversationId)?.recordUserTurn(request.text??'',request.requestId);
          await entry.runtime.session.persistTaskResults?.(this.progress.get(request.conversationId)!.snapshot());
        }

        return {status:'accepted',runId:originRun??null,message:`修改已保存，继续后生效：${request.text??'所选资料'}`};
      }

      if (!request.expectedRunId || snapshot.runId !== request.expectedRunId || !['running','idle'].includes(snapshot.state) || !entry.runtime.session.isStreaming()) {
        throw new TaskActionRejected('原任务已停止或发生变化，修改未发送。');
      }

      if (entry.runtime.session.isHeld()) throw new TaskActionRejected('页面现在归你，请先交还。');
      const originRun=snapshot.runId;
      const revokeRequirement=this.progress.get(request.conversationId)!.recordRequirement(request.text??'',request.context,request.attachments);
      await entry.runtime.session.persistRecoveryAttachments?.(originRun??null,request.attachments);

      try{await entry.runtime.session.steerCurrentTask(request.text!,request.context,request.attachments,{rewrite:request.source==='text'});}
      catch(error){
        if(error instanceof TaskActionRejected){
          revokeRequirement();
          await entry.runtime.session.persistTaskResults?.(this.progress.get(request.conversationId)!.snapshot());
        }

        throw error;
      }

      if(this.progress.get(request.conversationId)?.snapshot().runId===originRun) {
        this.progress.get(request.conversationId)?.reviseResults();
        this.progress.get(request.conversationId)?.recordUserTurn(request.text??'',request.requestId);
        await entry.runtime.session.persistTaskResults?.(this.progress.get(request.conversationId)!.snapshot());
      }

      return {status:'accepted',runId:originRun,message:`${request.source==='voice'?'语音修改':'修改'}已送达当前任务：${request.text}`};
    },{deferredResume:request.action==='resume'&&['interrupted','idle','error'].includes(this.getTaskProgress(request.conversationId)?.state??'')});

    this.emitReceipt(receipt);

    return receipt;
  }
  list(): ConversationSummary[] { return [...this.entries.values()].map(({ summary }) => ({ ...summary })); }
  private epochs(runtime:Runtime){
    return {main:runtime.session.executionEpoch?.()??0};
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

    // T02：任何状态突变后投影并下发只读任务视图（微任务合并 + 去重，保证原始事件先到达）。包裹只加通知，不改原语义。
    for (const method of ["observe", "request", "abort", "recordRequirement", "interrupt", "prepareResume", "restoreResults", "reviseResults", "invalidatePage", "registerResults", "stopAfterFailures"] as const) {
      const original = progress[method].bind(progress) as (...args: unknown[]) => unknown;
      // SAFETY: 同名方法按原签名包装，参数与返回值形状不变；动态按方法名赋值 TypeScript 无法表达。
      (progress as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
        const result = original(...args);
        this.queueTaskView(id);

        return result;
      };
    }

    const promise = this.factory(id, (message) => {
      // A rejected checkpoint must not be replaced by a late runtime event.
      if (summary.checkpoint === 'unavailable') return;
      const currentRun=progress.snapshot().runId;
      const stale=typeof message.runId==='string'&&currentRun!==null&&message.runId!==currentRun;

      if(stale){
        // 显式旧 run 只按原身份转发诊断，不得改当前 summary/epochs/补交付。
        this.emit({...message,conversationId:id});

        return;
      }

      // Stop tails from a disconnected runtime cannot resurrect or finish its checkpoint.
      if(progress.snapshot().state==='interrupted'&&!this.checkpointResumes.has(id)
        &&(message.type==='status'||message.type==='agent_event'&&['agent_start','agent_end','turn_start','turn_end','text_delta','thinking_delta','user_delivery','user_delivery_stream','tool_start','tool_end'].includes(message.event.kind)))return;

      if(message.type==='agent_event'&&isLeadSession(message.sessionId)&&['agent_start','agent_end','error'].includes(message.event.kind)){this.pendingStarts.delete(id);this.checkpointResumes.delete(id);}

      if(message.type==='status'&&isLeadSession(message.sessionId)&&message.state==='running'){this.pendingStarts.delete(id);this.checkpointResumes.delete(id);}

      progress.observe(message);
      const progressSnapshot=progress.snapshot();

      if(progressSnapshot.state==='interrupted')summary.checkpoint='interrupted';
      else delete summary.checkpoint;

      // 页面读数只用于结果账本的前后对比，不下发侧栏。
      if (message.type === "agent_event" && message.event.kind === "tool_observation") {
        this.entries.get(id)?.runtime.session.persistTaskResults?.(progressSnapshot);

        return;
      }

      this.entries.get(id)?.runtime.session.persistTaskResults?.(progressSnapshot);
      summary.runId = progressSnapshot.runId;
      const live=this.entries.get(id)?.runtime;
      const carriesIdentity=['tool_call','control_result','team_status','status'].includes(message.type)||(message.type==='agent_event'&&message.event.kind==='agent_start');
      const scoped:ServerMessage = { ...message, conversationId: id, ...(live&&carriesIdentity?{epochs:{...this.epochs(live),...message.epochs}}:{}) };
      // 直连 display 帧（新用户请求）不继承任务 runId：旧任务已中止时不被扩展身份闸门连坐；
      // 任务族帧保持原身份绑定，中止后的迟到任务帧仍按原身份被拒（原语义不变）。
      const freshDisplayCall = message.type === 'tool_call' && typeof message.sdkId === 'string' && message.sdkId.startsWith('display-');

      if(carriesIdentity&&scoped.type!=='task_control'&&!freshDisplayCall)scoped.runId=progressSnapshot.runId;
      this.emit(scoped);

      // 宿主说这一轮要核对（goal_check checking，先于 agent_end）：过往任务等核对结论再记，判继续时不记那句没核对过的回答。
      if (message.type === 'agent_event' && isLeadSession(message.sessionId) && message.event.kind === 'agent_start') this.goalCheckPending.delete(id);

      if (message.type === 'agent_event' && isLeadSession(message.sessionId) && message.event.kind === 'goal_check' && message.event.status === 'checking') this.goalCheckPending.add(id);

      if (message.type === 'agent_event' && message.event.kind === 'agent_end' && isLeadSession(message.sessionId)) {
        void this.fulfillOwedDelivery(id).finally(()=>{ if (!this.goalCheckPending.has(id)) this.recordTaskHistory(id); });

        try{this.taskQueue.finish(id,progress.snapshot().state==='aborted'?'cancelled':progress.snapshot().state==='error'?'failed':'completed');}catch{this.emit({type:'agent_event',conversationId:id,event:{kind:'error',message:'任务结束状态未能保存，请核对已有结果。'}});}

        this.pumpTasks();
      }

      // 目标核对在交付之后才出结论：任务已空闲时按新结论重记这条过往任务（同一 runId 覆盖）。
      if (message.type === 'agent_event' && message.event.kind === 'goal_check' && message.event.status !== 'continue' && message.event.status !== 'checking' && isLeadSession(message.sessionId) && progress.snapshot().state === 'idle') { this.goalCheckPending.delete(id); this.recordTaskHistory(id); }

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
      runtime.onHandToUser?.(ask => this.handToUser(id, ask));
      runtime.control.setTabCoordinator?.(async (owner, members) => {
        const source = this.entries.get(owner)?.runtime;

        if (!source) return; // 已结束的运行时：扩展仍会检查归属并排空旧操作。

        if (source.session.isHeld()) throw new Error("页面现在归你，操作未执行");
        // 跨会话只停旧会话：这里再发旧 run 的 release 会被身份闸门拒收（错误盖掉新会话接手）。
        // 页面归属由接手方的 claim 与排空动作收敛。
        await source.control.stopMembersForForeignTakeover(members);
      });
      runtime.control.setIdleOwnerCheck?.(owner => this.conversationIdle(owner));
      const entry = { summary, runtime };
      let restoredResults: TaskProgressSnapshot | null | undefined;

      try {
        restoredResults = runtime.session.readPersistedTaskResults?.();

        if (restoredResults && restoredResults.conversationId !== id) throw new Error(TASK_CHECKPOINT_UNAVAILABLE);
      } catch {
        // Quarantine this conversation, not the entire host. Leave its Pi file intact.
        summary.state = 'idle';
        summary.runId = restored?.runId ?? null;
        summary.checkpoint = 'unavailable';
        restoredResults = null;
        progress.observe({type:'agent_event',event:{kind:'error',message:TASK_CHECKPOINT_UNAVAILABLE}});
      }

      let restoredInterrupted=false;

      if (restoredResults) {
        progress.restoreResults(restoredResults);
        const restoredSnapshot=progress.snapshot();
        summary.runId = restoredSnapshot.runId;
        restoredInterrupted=restoredSnapshot.state==='interrupted';

        if(restoredInterrupted){summary.state='idle';summary.checkpoint='interrupted';summary.updatedAt=Date.now();}
        else delete summary.checkpoint;
      }
      else if (summary.checkpoint !== 'unavailable') delete summary.checkpoint;
      runtime.session.bindTaskResults?.({
        getSnapshot: () => progress.snapshot(),
        stopAfterFailures: () => { progress.stopAfterFailures(); runtime.session.persistTaskResults?.(progress.snapshot()); },
        register: items => {
          if (!progress.snapshot().runId || progress.snapshot().state === "aborted") throw new Error("当前没有可登记结果的任务");
          progress.registerResults(items); runtime.session.persistTaskResults?.(progress.snapshot());
        },
        deliveryFacts: () => progress.deliveryFacts(),
        answerSources: () => progress.answerSources(),
        releaseAfterHandback: () => {
          const released = progress.releaseAfterHandback();

          if (released.length) runtime.session.persistTaskResults?.(progress.snapshot());

          return released;
        },
      });
      runtime.session.bindDeliveryRun?.(() => this.progress.get(id)?.snapshot().runId ?? null);

      if (this.thinkingDeep !== undefined) runtime.session.mainEffort?.prefer(this.thinkingDeep);
      // 语义轮次的输出闸门接进会话：PREPARING 的交付流前缀先扣住，COMMITTED 之后才对外发。
      runtime.session.bindVoiceTurnGate?.(this.voiceTurns);
      runtime.session.bindConversationContext?.(() => this.getTaskProgress(id));
      // 纠正询问的网站：用户不在网页上时，取这个任务最近碰过的网页。
      runtime.session.bindVisitedUrls?.(() => this.progress.get(id)?.visitedUrls() ?? []);
      this.entries.set(id, entry);
      this.store?.save(this.list());
      this.pending.delete(id);

      if (summary.checkpoint === 'unavailable') {
        this.emit({type:'conversation_updated',conversationId:id,conversation:{...summary}});
        this.emit({type:'agent_event',conversationId:id,event:{kind:'error',message:TASK_CHECKPOINT_UNAVAILABLE}});
      }

      if(restoredInterrupted){
        this.emit({type:'conversation_updated',conversationId:id,conversation:{...summary}});
        this.emit({type:'agent_event',conversationId:id,event:{kind:'notice',message:progressSpeech(progress.snapshot())}});
      }

      return entry;
    }, (error: unknown) => { this.pending.delete(id); throw error; });

    this.pending.set(id, promise);

    return promise;
  }

  async handleMessage(message: ClientMessage): Promise<void> {
    if (message.type === 'reading_cancel') { this.reading.cancel(message.threadId, message.requestId);

 return; }

    if (message.type === 'reading_request') {
      await this.reading.run(message.requestId, message.transcript, async (transcript, signal, onText) => {
        const id = normalizeConversationId(message.conversationId);
        const entry = this.get(id) ?? (id === DEFAULT_CONVERSATION_ID ? await this.ensureDefault() : undefined);

        if (signal.aborted || !entry) throw new Error('阅读请求不可用');

        return entry.runtime.session.answerReading(transcript, signal, onText);
      }, event => this.emit(event));

      return;
    }

    if (message.type === 'nudge_request') {
      // 主动建议（#52）：失败、超时、没有模型都当作不建议，只回 nudge:null，不打扰会话。
      let nudge = null;

      try {
        const id = normalizeConversationId(message.conversationId);
        const entry = this.get(id) ?? (id === DEFAULT_CONVERSATION_ID ? await this.ensureDefault() : undefined);
        nudge = entry ? await entry.runtime.session.judgeNudge(message.context) : null;
      } catch { nudge = null; }

      this.emit({ type: 'nudge_result', requestId: message.requestId, nudge });

      return;
    }

    if (message.type === "conversation_create") {
      let request = this.requests.get(message.requestId);

      if (!request) {
        request = this.create(randomUUID(), message.title?.trim() || "新会话").then(async entry => {
          if (message.reading) {
            await entry.runtime.session.importReading(message.reading);
            this.store?.saveReading(entry.summary.id, message.reading);
          }

          return entry;
        });
        this.requests.set(message.requestId, request);
      }

      let entry: ConversationEntry;

      try { entry = await request; }
      catch (error) {
        if (!message.reading) throw error;
        this.requests.delete(message.requestId);
        this.emit({type: 'reading_event', threadId: message.reading.threadId, requestId: message.requestId, state: 'error', text: '', error: '未能建立侧栏会话，阅读内容已保留，请重试。'});

        return;
      }

      this.emit({ type: "conversation_created", requestId: message.requestId, conversationId: entry.summary.id, conversation: { ...entry.summary } });

      return;
    }

    if (message.type === "conversation_list") {
      this.emit({ type: "conversation_list", requestId: message.requestId, conversations: this.list() });
      this.replayState(this.emit);

      return;
    }

    const id = normalizeConversationId(message.conversationId);

    if(message.type==='task_action'&&['queued','suspended'].includes(this.taskQueue.get(message.request.conversationId)?.state??'')){await this.dispatchTaskAction(message.request);

return;}

    const entry = this.entries.get(id) ?? (id === DEFAULT_CONVERSATION_ID ? await this.ensureDefault() : undefined);

    if (!entry) throw new Error(`CONVERSATION_NOT_FOUND: ${id}`);

    if (entry.summary.checkpoint === 'unavailable' && message.type !== 'task_action' && message.type !== 'task_receipt_query' && message.type !== 'task_view_query') {
      this.emit({type:'agent_event',conversationId:id,event:{kind:'error',message:TASK_CHECKPOINT_UNAVAILABLE}});

      return;
    }

    if(message.type==='task_control_result'){this.controls.receive({...message,conversationId:id});

return;}

    if((message.type==='takeover'||message.type==='handback'||message.type==='abort')&&!message.taskRequestId){
      this.controlVersions.set(id,(this.controlVersions.get(id)??0)+1);
    }

    if((message.type==='takeover'||message.type==='handback'||message.type==='abort')&&message.taskRequestId){
      const action=message.type==='takeover'?'pause':message.type==='handback'?'resume':'abort';
      const snapshot=this.getTaskProgress(id)!;

      const valid=this.controls.permits(id,message.taskRequestId,action,snapshot.runId??null)
        &&(action==='abort'||action==='pause'&&['running','paused'].includes(snapshot.state)||action==='resume'&&(entry.runtime.session.isHeld()||entry.runtime.control.isGroupHeld()));

      if(!valid){
        if(message.type==='abort')this.emit({type:'task_control_ack',conversationId:id,requestId:message.taskRequestId,action:'abort',ok:false});
        else this.emit({type:'control_result',conversationId:id,requestId:message.requestId,action:message.type,ok:false,state:entry.summary.state,reason:'控制请求已过期，操作未执行。'});

        return;
      }


      if(message.type==='abort'){
        this.progress.get(id)?.abort();entry.runtime.handleMessage(message);

        try{await entry.runtime.session.waitForStop();this.emit({type:'task_control_ack',conversationId:id,requestId:message.taskRequestId,action:'abort',ok:true});}
        catch{this.emit({type:'task_control_ack',conversationId:id,requestId:message.taskRequestId,action:'abort',ok:false});}

        return;
      }
    }

    if (message.type === 'task_action') { await this.dispatchTaskAction(message.request);

 return; }

    if (message.type === 'task_view_query') { this.emitTaskView(id, true);

 return; }

    if (message.type === 'task_receipt_query') {
      const receipt = this.taskQueue.list(id).find(j=>j.request.requestId===message.requestId)?.receipt??this.dispatcher.get(id,message.requestId)??this.dispatcher.store.list(id).find(r=>r.requestId===message.requestId);

      if (receipt) this.emitReceipt(receipt);
      else {const result=this.voicePlans.get(id,message.requestId);this.emit({type:'agent_event',conversationId:id,event:{kind:'notice',message:result?'这份语音计划的结果见逐步记录；不会自动重做。':'未找到这条请求的回执，请不要自动重发。',...(result?.plan?.steps.length?{plan:result.plan}:{})}});}

      return;
    }

    // 思考强度对所有会话生效，之后新开的会话也按它起步。
    if (message.type === "set_thinking") {
      this.thinkingDeep = message.deep;

      for (const entry of this.entries.values()) entry.runtime.session.mainEffort?.prefer(message.deep);

      return;
    }

    if (message.type === "memory_list" || message.type === "memory_update" || message.type === "memory_forget" || message.type === "memory_restore" || message.type === "memory_ask_answer" || message.type === "memory_site" || message.type === "memory_unforget") {
      await this.handleMemoryMessage(message, id);

      return;
    }

    if (message.type === "task_history_list" || message.type === "task_history_forget" || message.type === "task_history_site" || message.type === "task_history_restore") {
      try {
        if (!this.taskHistory) throw new Error("过往任务记录不可用");
        const history = this.taskHistory;

        const tasks = message.type === "task_history_list" ? await history.list()
          : message.type === "task_history_site" ? await history.setNotHere(message.id, message.hostname, message.off)
            : message.type === "task_history_restore" ? await history.record(message.task).then(() => history.list())
              : await history.forget(message.id);

        this.emit({ type: "task_history_result", conversationId: id, requestId: message.requestId, ok: true, tasks });
      } catch (error) {
        this.emit({ type: "task_history_result", conversationId: id, requestId: message.requestId, ok: false, error: error instanceof Error ? error.message : String(error) });
      }

      return;
    }

    if(message.type==='user_message'){
      const checkpoint=this.getTaskProgress(id);

      if(checkpoint&&(checkpoint.state==='interrupted'||['idle','error'].includes(checkpoint.state)&&checkpoint.nextStep?.delivery==='partial')&&isInterruptedResumeText(message.text)){
        const requestId=`restart-${randomUUID()}`;
        this.progress.get(id)?.recordUserTurn(message.text,requestId);
        entry.summary.updatedAt=Date.now();
        this.store?.save(this.list());
        await this.dispatchTaskAction({requestId,conversationId:id,source:'text',action:'resume',expectedRunId:checkpoint.runId??null,expectedControlVersion:this.controlVersions.get(id)??0,text:message.text,context:message.context,attachments:message.attachments});

        return;
      }

      if(checkpoint?.state==='interrupted'&&!this.checkpointResumes.has(id)){
        await this.dispatchTaskAction({requestId:`amend-${randomUUID()}`,conversationId:id,source:'text',action:'steer',expectedRunId:checkpoint.runId??null,text:message.text,context:message.context,attachments:message.attachments});

        return;
      }
    }

    if(message.type==='user_message'&&this.checkpointResumes.has(id)&&!entry.runtime.session.isStreaming()){
      this.emit({type:'agent_event',conversationId:id,event:{kind:'notice',message:'当前任务正在启动或恢复检查点，这条新要求尚未发送；请等它进入运行后再补充。'}});

      return;
    }

    if(message.type==='user_message'&&!entry.runtime.session.isStreaming()&&!entry.runtime.session.isHeld()&&this.runningTasks()>=2){
      this.emit({type:'agent_event',conversationId:id,event:{kind:'notice',message:'当前执行名额已满，这项新任务尚未接收；请等待运行中的任务完成。'}});

return;
    }

    if(message.type==='user_message'&&message.context?.tabId!==undefined)this.taskPages.set(id,message.context.tabId);

    if (message.type === "user_message" && entry.summary.title === "新会话") entry.summary.title = message.text.trim().slice(0, 36) || "新会话";

    if (message.type === "user_message") {
      const progress = this.progress.get(id);
      const before = progress?.snapshot().runId ?? null;
      progress?.request(message.text,message.context,message.attachments);
      await entry.runtime.session.persistRecoveryAttachments?.(progress?.snapshot().runId??null,message.attachments);

      if(progress)await entry.runtime.session.persistTaskResults?.(progress.snapshot());

      // 只有真正开了新任务才换身份：运行中的同一条消息会转成插话，沿用当前 runId。
      if (progress && (progress.snapshot().runId ?? null) !== before) this.publishRunIdentity(id);
    }

    if (message.type === "abort") {this.pendingStarts.delete(id);this.checkpointResumes.delete(id);this.progress.get(id)?.abort();}

    if(message.type==='user_message'&&!entry.runtime.session.isStreaming()&&!entry.runtime.session.isHeld())this.pendingStarts.add(id);

    if(message.type==='steer'&&entry.runtime.session.isStreaming()&&!entry.runtime.session.isHeld()){
      // 侧栏文字修改在运行中与语音走同一个调度入口：登记要求、真实回执与请求去重都保留。
      // 空闲/接管仍由原 steer 路径处理（空闲转新任务，接管给提示）。
      await this.dispatchTaskAction({requestId:`steer-${randomUUID()}`,conversationId:id,source:'text',action:'steer',expectedRunId:this.getTaskProgress(id)?.runId??null,text:message.text,context:message.context,attachments:message.attachments});

      return;
    }

    try{entry.runtime.handleMessage(message);}catch(error){this.pendingStarts.delete(id);throw error;}

    if (message.type === "user_message") {
      entry.summary.updatedAt = Date.now();
      this.store?.save(this.list());
      this.emit({ type: "conversation_updated", conversationId: id, conversation: { ...entry.summary } });
    }
  }

  private async handleMemoryMessage(
    message: Extract<ClientMessage, { type: "memory_list" | "memory_update" | "memory_forget" | "memory_restore" | "memory_ask_answer" | "memory_site" | "memory_unforget" }>,
    conversationId: string,
  ): Promise<void> {
    const action = message.type === "memory_list" ? "list" : message.type === "memory_update" ? "update" : message.type === "memory_restore" ? "restore" : message.type === "memory_ask_answer" ? "ask"
      : message.type === "memory_site" ? "site" : message.type === "memory_unforget" ? "unforget" : "forget";

    try {
      if (!this.memoryStore) throw new Error("记忆存储不可用");

      // 回执带整份记忆的版本号 rev。列表先读 rev 再读条目：其间若有新写入，面板拿到的 rev 偏旧，下次会重读，不会漏。
      if (message.type === "memory_list") {
        const rev = await this.memoryStore.currentRev();
        const entries = await this.memoryStore.list();
        this.emit({ type: "memory_result", conversationId, requestId: message.requestId, action, ok: true, entries, rev });

        return;
      }

      if (message.type === "memory_update") {
        const changed = await this.memoryStore.update({
          id: message.id,
          expectedVersion: message.expectedVersion,
          text: message.text,
          scope: message.scope,
        });

        this.emit({ type: "memory_result", conversationId, requestId: message.requestId, action, ok: true, entry: changed, rev: await this.memoryStore.currentRev() });

        return;
      }

      // 回答「要我记住吗」：询问只在这个对话的后台内存里；对话不在或后台重启过就是已失效。
      if (message.type === "memory_ask_answer") {
        const session = this.entries.get(conversationId)?.runtime.session;

        if (!session?.answerMemoryAsk) throw new MemoryAskClosed(MEMORY_ASK_EXPIRED);
        const answered = await session.answerMemoryAsk(message.askId, message.answer, message.text);
        // 版本号用运行时写入后取到的那个；取不到就不带（不再读一次，免得把已存下的说成失败）。
        const result: Extract<ServerMessage, { type: "memory_result" }> = { type: "memory_result", conversationId, requestId: message.requestId, action, ok: true };

        if (answered.rev !== undefined) result.rev = answered.rev;

        if (answered.entry) result.entry = answered.entry;

        if (answered.entries) result.entries = answered.entries;

        // 早已记着同一条：这次没写入，面板说「已经记着了」、不给撤销。
        if (answered.alreadySaved) result.alreadySaved = true;
        this.emit(result);

        return;
      }

      if (message.type === "memory_restore") {
        const entries = await this.memoryStore.restore({ id: message.id, expectedVersion: message.expectedVersion });
        this.emit({ type: "memory_result", conversationId, requestId: message.requestId, action, ok: true, entries, rev: await this.memoryStore.currentRev() });

        return;
      }

      if (message.type === "memory_site") {
        const entry = await this.memoryStore.setNotHere({ id: message.id, expectedVersion: message.expectedVersion, hostname: message.hostname, off: message.off });
        this.emit({ type: "memory_result", conversationId, requestId: message.requestId, action, ok: true, entry, rev: await this.memoryStore.currentRev() });

        return;
      }

      if (message.type === "memory_unforget") {
        const entries = await this.memoryStore.unforget(message.entries);
        this.emit({ type: "memory_result", conversationId, requestId: message.requestId, action, ok: true, entries, rev: await this.memoryStore.currentRev() });

        return;
      }

      const removed = await this.memoryStore.forget({ id: message.id, expectedVersion: message.expectedVersion });
      this.emit({ type: "memory_result", conversationId, requestId: message.requestId, action, ok: true, deletedId: message.id, entries: removed, rev: await this.memoryStore.currentRev() });
    } catch (error) {
      // 失败（如版本冲突）也带上当前 rev，面板据此重读；记忆读不出来时不带。
      const rev = await this.memoryStore?.currentRev().catch(() => undefined);

      const result: Extract<ServerMessage, { type: "memory_result" }> = {
        type: "memory_result",
        conversationId,
        requestId: message.requestId,
        action,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ...(rev === undefined ? {} : { rev }),
      };

      // 询问已不在后台（没问过、已回答、作废、重启过）：面板收起按钮。可再试的写入失败不带。
      if (error instanceof MemoryAskClosed) result.askClosed = true;
      this.emit(result);

      // 这次才作废的询问：先让面板收到带原因的结果，再发结局事件（进对话历史）。
      if (error instanceof MemoryAskClosed) error.announce?.();
    }
  }

  replayState(emit: (message: ServerMessage) => void): void {
    for(const job of this.taskQueue.list())if(job.request.originConversationId)emit({type:'agent_event',conversationId:job.request.originConversationId,event:{kind:'notice',message:job.receipt.message,receipt:job.receipt}});

    for (const { summary, runtime } of this.entries.values()) {
      if (summary.checkpoint === 'unavailable') {
        emit({type:'agent_event',conversationId:summary.id,event:{kind:'error',message:TASK_CHECKPOINT_UNAVAILABLE}});
        this.emitTaskView(summary.id, true);
        continue;
      }

      for(const result of this.voicePlans.list(summary.id))if(result.plan)emit({type:'agent_event',conversationId:summary.id,event:{kind:'notice',message:'语音计划',plan:result.plan}});

      for (const receipt of this.dispatcher.store.list(summary.id)) emit({type:'agent_event',conversationId:summary.id,event:{kind:'notice',message:receipt.message,receipt}});
      emit({ type: "status", conversationId: summary.id, epochs:this.epochs(runtime),state: runtime.session.isHeld() ? "user" : runtime.session.isStreaming() ? "running" : "idle" });
      this.emitTaskView(summary.id, true);
      void runtime.session.availableModels().then((models) => emit({ type: "model_info", conversationId: summary.id, model: runtime.session.modelName(), models }));

      const team = runtime.control.teamView();

      if (team) emit({ type: "team_status", conversationId: summary.id, team });
    }
  }

  disconnect(): void {
    this.connected=false;
    this.controls.disconnect();

    try{this.taskQueue.suspendPending();}catch{this.emit({type:'agent_event',event:{kind:'error',message:'待办暂停状态未能保存；连接恢复后请核对，不会自动执行。'}});}

    for (const { summary, runtime } of this.entries.values()) {
      const progress=this.progress.get(summary.id)!;
      const before=progress.snapshot();
      this.controlVersions.set(summary.id,(this.controlVersions.get(summary.id)??0)+1);
      this.voiceTurnAborts.get(summary.id)?.abort();

      if(['running','interrupted'].includes(before.state)||this.pendingStarts.has(summary.id)){
        progress.interrupt('connection_lost');
        summary.state='idle';summary.checkpoint='interrupted';

        try{runtime.session.persistTaskResults?.(progress.snapshot());this.publishRunIdentity(summary.id);}
        catch{this.emit({type:'agent_event',conversationId:summary.id,event:{kind:'error',message:'中断检查点未能完整保存，执行已停止；请核对原记录，不要重放操作。'}});}
      }

      this.pendingStarts.delete(summary.id);this.checkpointResumes.delete(summary.id);
      runtime.rpc.rejectAll(new Error("Extension disconnected"));

      if (!runtime.session.isHeld() && !runtime.control.isGroupHeld()) {
        runtime.session.abort();
        runtime.control.abortTeam();
      }
    }
  }
  dispose(): void { this.queueClosed=true;this.taskViewDisposed=true;this.taskViewQueued.clear();this.controls.disconnect();

for (const { runtime } of this.entries.values()) runtime.dispose(); }
}
