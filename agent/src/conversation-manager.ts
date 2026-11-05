import { realtimeBrowserError, validateRealtimeBrowserTool, type RealtimeBrowserCall } from './realtime-browser-tools.js';
import type { VoiceInputContext } from '../../shared/voice.js';
import {isMerged, TaskQueue} from "./task-queue.js";
import {TASK_CHECKPOINT_UNAVAILABLE} from '../../shared/task-recovery.js';
import {answerSpeech} from '../../shared/answer-cards.js';
import { ReadingRequests } from "./reading.js";
import {join} from "node:path";
import type {UserInputOptions} from "./session.js";
import {VoicePlanStore,type VoicePlanStep,type VoiceProposal} from "./voice-plan-store.js";
import {isControlConfirm,isControlReject,type ControlConfirmSnapshot} from "./voice-confirm.js";
import { createHash, randomUUID } from "node:crypto";
import {
  DEFAULT_CONVERSATION_ID, isLeadSession, normalizeConversationId,
  type ClientMessage, type ConversationSummary, type ServerMessage,
  type PageContext,
} from "../../shared/protocol.js";
import type { UserDelivery, UserDeliveryKind, UserDeliveryStream } from "../../shared/voice.js";
import { deliveryTextWithNote } from "../../shared/voice.js";
import { createUserDelivery, projectDeliveryFacts, factsForDelivery } from "./user-delivery.js";
import type { ConversationPersistence } from "./conversation-persistence.js";
import type { createConversationRuntime } from "./conversation-runtime.js";
import type { MemoryStore } from "./memory-store.js";
import type { MemoryEntry } from "../../shared/memory.js";
import { MEMORY_ASK_EXPIRED, MemoryAskClosed } from "./memory-runtime.js";
import { TaskProgress } from "./task-progress.js";
import { TaskContinuationObserver } from './task-continuation.js';
import type { TaskContinuation } from '../../shared/task-continuation.js';
import type { TaskProgressSnapshot, UserDeliveryFacts, VoiceRouteContext, VoiceRouteResult, VoiceTarget } from "../../shared/voice.js";
import { projectTaskView } from "../../shared/task-view.js";
import { isTaskActionRequest, type TaskActionRequest, type TaskReceipt } from "../../shared/task-actions.js";
import { TaskDispatcher, TaskActionRejected, TaskActionFailed, TaskReceiptError } from "./task-dispatcher.js";
import {normalizeSpeech,progressSpeech} from './voice-receipt.js';
import {TaskControlBroker} from './task-control.js';
import {VoiceTurnGate} from './voice-turn.js';
import {isFactFreeClosedUtterance,isVoiceBackchannel,isVoiceSilenceRequest,type VoiceIntentPlan} from './voice-intent.js';
import {matchQuickNavTab,parseQuickNavIntent} from '../../shared/quick-nav.js';
import type {VoiceTurnPreparation} from './voice-model.js';
import {VoiceIntentError} from './voice-errors.js';
import {pageRecoveryKey} from './task-recovery.js';
import {redactTaskSecrets, type TaskHistoryStore} from './task-history.js';
import { runLearnedOperation, type LearnedOperationStore } from './learned-operations.js';
import type { SiteNotesStore } from './site-notes.js';
import {memoryHostOfUrl} from '../../shared/memory.js';
import type {BrowseHabit} from '../../shared/browse-habits.js';
import {asksUser} from './goal-check.js';
import {endingFromResults,resultHasWriteEffect,resultLocksWhenUnknown} from '../../shared/task-results.js';
import type {TaskHistoryEntry} from '../../shared/task-history.js';
import { warmUpStarted } from './warm-connection.js';
import { RESUME_UNCONFIRMED } from '../../shared/handoff-choice.js';

type Runtime = Awaited<ReturnType<typeof createConversationRuntime>>;

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

interface ConversationEntry { summary: ConversationSummary; runtime: Runtime }

function tabOwnerIdle(input: { busy: boolean; snapshot: TaskProgressSnapshot | null }): boolean {
  if (input.busy) return false;
  const snapshot = input.snapshot;

  if (!snapshot) return true;

  return !(['running', 'paused', 'interrupted'].includes(snapshot.state) || snapshot.active.length);
}

const WARM_UP_INTERVAL_MS = 30_000;

export class ConversationManager {
  continuationEnabled: () => boolean = () => false;
  private readonly observers = new Map<string, TaskContinuationObserver>();
  private async saveContinuation(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('委托会话不可用。');
    await entry.runtime.session.persistTaskResults(this.progress.get(id)!.snapshot());
    await entry.runtime.session.flushPersistence();
  }
  private async wakeContinuation(id: string, pending: TaskContinuation): Promise<boolean> {
    const entry = this.entries.get(id), progress = this.progress.get(id);
    if (!entry || !progress || !pending.requestId || !pending.pendingVersion || !this.connected || this.runningTasks() >= 2) return false;
    const request: TaskActionRequest = { requestId: pending.requestId, conversationId: id, source: 'text', action: 'resume', expectedRunId: progress.snapshot().runId ?? null, text: '条件已复核，继续原委托' };
    const receipt = await this.dispatcher.dispatch(request, entry.summary.title, async () => {
      const live = progress.snapshot().continuation;
      if (!this.continuationEnabled() || !live || live.id !== pending.id || live.goalVersion !== pending.goalVersion || live.controlVersion !== pending.controlVersion || live.state !== 'WAITING_CONDITION' || live.pendingVersion !== pending.pendingVersion || entry.runtime.session.isStreaming() || entry.runtime.session.isHeld() || Date.now() >= live.expiresAt) throw new TaskActionRejected('等待条件已失效，未自动继续。');
      const running: TaskContinuation = { ...live, state: 'RUNNING', processingVersion: live.pendingVersion, pendingVersion: null, segmentStartedAt: Date.now() };
      progress.setContinuation(running);
      await this.saveContinuation(id);
      if (progress.snapshot().continuation?.controlVersion !== running.controlVersion || progress.snapshot().continuation?.state !== 'RUNNING') throw new TaskActionRejected('委托已中止，未自动继续。');
      this.pendingStarts.add(id);
      try { await entry.runtime.session.continueCondition(progress.snapshot()); }
      catch (error) { this.pendingStarts.delete(id); throw error; }
      return { status: 'accepted', runId: request.expectedRunId, message: '页面条件已满足，正在继续原任务。' };
    }, { deferredResume: true });
    if (receipt.status !== 'accepted') await this.observers.get(id)?.control('pause', receipt.message);
    return receipt.status === 'accepted';
  }
  private readonly taskQueue:TaskQueue;
  private readonly pendingStarts=new Set<string>();
  private readonly merging=new Set<string>();
  private readonly checkpointResumes=new Set<string>();
  private readonly taskPages=new Map<string,number>();
  private readonly taskNames=new Map<string,{key:string;busy:boolean;count:number}>();
  private readonly reading = new ReadingRequests();
  private readonly memoryForgetRequests = new Map<string, { id: string; version: number; result: Promise<MemoryEntry[]> }>();
  private readonly entries = new Map<string, ConversationEntry>();
  private readonly pending = new Map<string, Promise<ConversationEntry>>();
  private readonly requests = new Map<string, Promise<ConversationEntry>>();
  private readonly progress = new Map<string, TaskProgress>();
  private readonly voiceConfirmations=new Map<string,VoiceProposal>();
  private readonly controlConfirmations=new Map<string,ControlConfirmSnapshot>();
  private readonly controlVersions=new Map<string,number>();
  private readonly pendingHandoffs = new Map<string, { runId: string; version: number }>();
  private readonly makeupRuns=new Set<string>();
  private readonly voicePlans:VoicePlanStore;
  private readonly voiceTurns=new VoiceTurnGate();
  private readonly voiceTurnAborts=new Map<string,AbortController>();
  private readonly messagePumps=new Map<string,(message:ServerMessage)=>void>();
  voiceTargets(){return [...this.list().map(c=>({id:c.id,title:c.title,runId:this.getTaskProgress(c.id)?.runId??null,controlVersion:this.controlVersions.get(c.id)??0})),...this.taskQueue.list().filter(j=>['queued','suspended'].includes(j.state)&&!this.entries.has(j.request.conversationId)).map(j=>({id:j.request.conversationId,title:j.title,runId:null,controlVersion:0}))];}
  isVoiceTask(origin:string,target:string){const job=this.taskQueue.get(target);

return !!job&&job.request.originConversationId===origin&&job.receipt.runId===this.getTaskProgress(target)?.runId;}
  private queueClosed=false;
  private connected=true;
  reconnect(): void {
    this.connected = true;
  }
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
    this.taskQueue=new TaskQueue({directory:dispatcher.store.directory?join(dispatcher.store.directory,'requirements'):undefined,persist:dispatcher.store.directory?undefined:store?.taskQueue,maxRunning:2,maxWaiting:8,
      enabled:()=>this.connected&&!this.queueClosed,
      running:()=>this.runningTasks(),
      blocked:request=>request.context?.tabId!==undefined&&[...this.taskPages].some(([id,tab])=>tab===request.context!.tabId&&(this.pendingStarts.has(id)||['running','paused'].includes(this.getTaskProgress(id)?.state??''))),
      execute:async request=>{
        if(this.queueClosed||!this.connected)throw new TaskActionRejected('连接已关闭，任务未启动。');
        this.pendingStarts.add(request.conversationId);

        try{
          const entry=await this.create(request.conversationId,request.text?.slice(0,36)||'独立任务');

          if(this.queueClosed){entry.runtime.dispose();throw new TaskActionRejected('连接已关闭，任务未启动。');}
          const earlier=request.originConversationId?this.getTaskProgress(request.originConversationId)?.conversationContext?.recentTurns:undefined;

          if(earlier?.length)this.progress.get(request.conversationId)?.inheritTurns(earlier);

          const receipt=await this.dispatchTaskAction(request,()=>true,request.context?undefined:{pageObservation:'on-demand'});

          if(receipt.status!=='accepted')this.pendingStarts.delete(request.conversationId);

          return receipt;
        }catch(error){this.pendingStarts.delete(request.conversationId);throw error;}
      },
      changed:job=>this.emitReceipt(job.receipt),
    });}

  async ensureDefault(): Promise<ConversationEntry> {
    const summaries = this.store?.load() ?? [];
    for (let at = 0; at < summaries.length; at += 4) {
      await Promise.all(summaries.slice(at, at + 4).map(async summary => {
        const restoring = !this.entries.has(summary.id) && !this.pending.has(summary.id);
        const entry = await this.create(summary.id, summary.title, summary);
        const reading = restoring ? this.store?.readingFor?.(summary.id) : undefined;

        if (reading) await entry.runtime.session.importReading(reading);
      }));
    }

    return this.create(DEFAULT_CONVERSATION_ID, "新会话");
  }
  get(id: string): ConversationEntry | undefined { return this.entries.get(id); }

  private warmedAt = new Map<string, number>();

  private warmUp(id: string, context?: PageContext, connectionOnly = false): void {
    const session = (this.entries.get(id) ?? [...this.entries.values()][0])?.runtime.session;
    const origin = session?.modelOrigin();

    if (session && !connectionOnly) void session.warmPageObservation(context);
    if (!session || !origin) return;
    const now = Date.now();

    if (now - (this.warmedAt.get(origin) ?? 0) < WARM_UP_INTERVAL_MS) {
      if (!connectionOnly) void session.warmPromptCache();
      return;
    }
    this.warmedAt.set(origin, now);
    const settle = warmUpStarted(origin, now);
    void fetch(origin, { method: "HEAD", credentials: "omit", cache: "no-store" })
      .then(() => true, () => false)
      .then(ok => {
        settle(ok, Date.now());
        if (ok && !connectionOnly) void session.warmPromptCache();
      });
  }
  getTaskProgress(id: string): TaskProgressSnapshot | null { const snapshot=this.progress.get(id)?.snapshot();

return snapshot?{...snapshot,controlVersion:this.controlVersions.get(id)??0}:null; }

  private readonly lastTaskViews = new Map<string, string>();
  private readonly taskViewQueued = new Set<string>();
  private taskViewDisposed = false;
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

    if (['none','idle'].includes(before.state) && session.isStreaming()) before.state='running';

    if(route?.recentTurns?.length)before.conversationContext={latestResult:null,...before.conversationContext,recentTurns:[...(before.conversationContext?.recentTurns??[]),...route.recentTurns].slice(-12)};
    const catalog=route?.targets??this.voiceTargets();
    const pending=route?.resumeReadOnly?undefined:this.voiceConfirmations.get(id)??(route?this.voicePlans.proposal(id,route.voiceId,route.turn-1):undefined);
    const short=normalizeSpeech(text);
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

    if(route&&!route.resumeReadOnly&&(
      (control&&(control.voiceId!==route.voiceId||Date.now()>=control.expiresAt))||
      (pending&&(pending.voiceId!==route.voiceId||Date.now()>=pending.expiresAt))
    ))consumeConfirmation();

    if (route && !route.resumeReadOnly && isControlConfirm(text) && (control || pending || short.includes("确认"))) {
      consumeConfirmation();
      route.onInputDecision?.(false);

      return {kind:'clarify',message:control||pending
        ?'刚才那项操作已失效，我没有执行。请重新说明要做什么。'
        :'目前没有等待确认的操作，我没有执行新动作。'};
    }

    if(!route?.resumeReadOnly&&isVoiceSilenceRequest(text)){
      route?.onInputDecision?.(true);

      return {kind:'silent',quiet:true};
    }

    if(!route?.resumeReadOnly&&isVoiceBackchannel(text)&&(route?.interruptedSpeech||route?.recentTurns?.some(t=>t.role==='assistant'))){
      route?.onInputDecision?.(true);

      return {kind:'silent'};
    }

    route?.reportStage?.('classifying');

    const prepared=route?.resumeReadOnly
      ?{plan:{steps:[{action:route.resumeReadOnly,target:null,text}]},replyText:null,protocol:'plan' as const}
      :before.state==='interrupted'&&isInterruptedResumeText(text)
        ?{plan:{steps:[{action:'resume' as const,target:null,text}]},replyText:null,protocol:'plan' as const}
      :await this.proposeVoiceTurn(id,session,text,before,catalog,route);

    const plan=prepared.plan;
    const single=plan.steps.length===1?plan.steps[0]:undefined;

    const willStart=!route?.resumeReadOnly&&!route?.pendingDelegation&&single?.target===null&&['none','idle'].includes(before.state)
      &&(['observe','chat'].includes(single.action)||single.action==='steer'&&!before.recoveryInput)&&!session.isHeld()&&!session.isStreaming();

    route?.onInputDecision?.(plan.steps.every(step=>['chat','status','observe','silence','listen'].includes(step.action)),single?.action==='listen');

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

    if(prepared.replyText&&only?.action==='chat'&&isFactFreeClosedUtterance(text)){
      if(!stillCurrent())return {kind:'none',resumeReadOnly:'chat'};

      return this.deliverVoiceReply(id,prepared.replyText,before,stillCurrent,route?.turn);
    }

    if(route?.resumeReadOnly==='status'){const targetId=route.resumeTargetId??id,target=this.getTaskProgress(targetId);

return target && this.entries.has(targetId) ? this.answerSourcedChat(targetId,text,target,stillCurrent,this.entries.get(targetId)!.runtime.session,route.turn,'status') : {kind:'clarify',message:'原目标会话已不可用，请重新询问。'};}

    if (willStart) {
      const inputOptions: UserInputOptions = {
        ...(single?.action==='chat'?{pageObservation:'on-demand' as const,conversationOnly:true}:{}),
        ...(route?.nativeChat && route.recentTurns?.length ? { voiceHistory: route.recentTurns } : {}),
      };
      const receipt=await this.dispatchTaskAction({requestId,conversationId:id,source:'voice',action:'start',expectedRunId:before.runId??null,expectedControlVersion:versions.get(id),text,...route?.input},stillCurrent,inputOptions);

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

      if(['pause','resume','abort'].includes(step.action))route?.reportStage?.('controlling');
      journal[index]!.status='pending';save();
      const resumeCheckpoint=step.action==='resume'&&(['interrupted','idle','error'].includes(this.getTaskProgress(targetId)?.state??'')||this.taskQueue.get(targetId)?.state==='suspended');
      const inputOptions = step.action === 'start' && targetId === id && route?.nativeChat && route.recentTurns?.length ? { voiceHistory: route.recentTurns } : undefined;
      const receipt=await this.dispatchTaskAction({expectedControlVersion:versions.get(targetId)??0,requestId:plan.steps.length===1?requestId:`${requestId}-${index}`,conversationId:targetId,...(targetId!==id?{originConversationId:id}:{}),source:'voice',action:step.action,expectedRunId:expected.get(targetId)??null,text:step.text,...(((step.action==='start'||step.action==='steer')&&sharesInput||resumeCheckpoint)?{...(route?.input?.context?{context:route.input.context}:{}),...(route?.input?.attachments?{attachments:route.input.attachments}:{})}:{})},stillCurrent,inputOptions);
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

    if(receipts.length===1&&last.action==='status') {
      const target = this.getTaskProgress(last.conversationId);
      const targetSession = this.entries.get(last.conversationId)?.runtime.session;
      if (target && targetSession) return this.answerSourcedChat(last.conversationId,text,target,stillCurrent,targetSession,route?.turn,'status');
      return {kind:'clarify',message:'原目标会话已不可用，请重新询问。'};
    }

    return {kind:receipts.length===1&&last.action==='steer'?'steer':'action',ok:true,status:last.status,message:receipts.map(r=>r.message).join('；'),receipts,turn:{branch:'control',phase:'COMMITTED',protocol:'plan'}};
  }

  async steerFromVoice(id: string, text: string, expectedStartedAt: number | null, route?: VoiceRouteContext, stillCurrent = () => true): Promise<TaskReceipt> {
    const entry = this.entries.get(id);
    const snapshot = this.getTaskProgress(id);

    if (!entry || !snapshot || snapshot.state !== "running" || expectedStartedAt === null || snapshot.startedAt !== expectedStartedAt) {
      throw new Error("原任务已中止或变了，修改没有发送。");
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
  private deliveryFactsOf(conversationId: string): UserDeliveryFacts | undefined {
    const progress = this.progress.get(conversationId);

    if (!progress) return undefined;
    const facts = progress.deliveryFacts();
    const snap = this.getTaskProgress(conversationId);

    return projectDeliveryFacts(factsForDelivery(facts,snap?.nextStep), snap?.nextStep);
  }
  private async proposeVoiceTurn(id:string,session:Runtime['session'],text:string,before:TaskProgressSnapshot,catalog:VoiceTarget[],route?:VoiceRouteContext):Promise<{plan:VoiceIntentPlan;replyText:string|null;protocol:'free_reply'|'plan'}>{
    const titles=catalog.flatMap(c=>text.includes(c.title) ? [c.title] : []);

    if(typeof session.prepareVoiceTurn!=='function'||session.canPrepareVoiceTurn?.()===false){
      return {plan:await session.classifyVoiceInput(text,before.state,titles,{goal:before.goal,requestId:route?.requestId},before.conversationContext),replyText:null,protocol:'plan' as const};
    }

    const turnId=route?.requestId??`${route?.voiceId??id}-${route?.turn??randomUUID()}`;
    this.voiceTurnAborts.get(id)?.abort();
    const abort=new AbortController();
    this.voiceTurnAborts.set(id,abort);

    for(const previous of this.voiceTurns.preparing(id)){
      if(previous===turnId)continue;
      this.releaseVoiceOutput(id,this.voiceTurns.interrupt(previous));
    }

    for(const previous of this.voiceTurns.committed?.(id)??[])this.voiceTurns.complete(previous);
    this.voiceTurns.begin(turnId,id);
    const protocol=!route?.nativeChat&&isFactFreeClosedUtterance(text)?'free_reply' as const:'plan' as const;
    let prepared:VoiceTurnPreparation;

    try{
      prepared=await session.prepareVoiceTurn({text,state:before.state,conversationTitles:titles,task:{goal:before.goal,requestId:route?.requestId},conversation:before.conversationContext},{cancel:abort.signal,protocol});
    }catch(error){
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
  private releaseVoiceOutput(id:string,released:{streams:UserDeliveryStream[];deliveries:UserDelivery[]}):void{
    for(const stream of released.streams)this.emit({type:'agent_event',conversationId:id,event:{kind:'user_delivery_stream',stream}});

    for(const delivery of released.deliveries){
      const message:ServerMessage={type:'agent_event',conversationId:id,event:{kind:'user_delivery',delivery}};
      this.progress.get(id)?.observe(message);
      this.emit(message);
    }
  }
  private deliverVoiceReply(id:string,text:string,before:TaskProgressSnapshot,stillCurrent:()=>boolean,voiceTurn?:number):VoiceRouteResult{
    const originRun=before.runId??null,originControl=this.controlVersions.get(id)??0;
    const streaming=this.beginDeliveryStream(id,'reply',before,stillCurrent,voiceTurn);

    if(streaming.onText(text)===false){streaming.cancel();

return {kind:'none',resumeReadOnly:'chat'};}

    const delivery=this.publishDelivery(id,'reply',text,text,{runId:originRun,controlVersion:originControl},streaming.id);

    if(!delivery){streaming.cancel();

return {kind:'none',resumeReadOnly:'chat'};}

    const published=this.getTaskProgress(id);

    return {kind:'none',resumeReadOnly:'chat',snapshot:published??undefined,spokenText:answerSpeech(delivery.text),turn:{branch:'reply',phase:'COMMITTED',protocol:'free_reply'}};
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
  private async answerSourcedChat(id: string, text: string, before: TaskProgressSnapshot, stillCurrent: () => boolean, session: Runtime["session"],voiceTurn?:number,readOnly:'chat'|'status'='chat'): Promise<VoiceRouteResult> {
    const facts = JSON.stringify({ currentStatus: progressSpeech(before), ...session.voiceTaskEvidence(before) });

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

      if (now.state !== before.state && ["error", "aborted", "paused"].includes(now.state)) {streaming.cancel();

return { kind: "silent" };}

      const delivery = this.publishDelivery(id, "reply", spoken, text, { runId: originRun, controlVersion: originControl },streaming.id);

      if (!delivery) {streaming.cancel();

return { kind: "silent" };}

      const published = this.getTaskProgress(id);

      return { kind: "none", resumeReadOnly: readOnly, snapshot: published ?? now, spokenText: delivery.text };
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
  private async handToUser(id:string,ask:string,targets?:string[]):Promise<void>{
    const runId=this.getTaskProgress(id)?.runId;

    if(!runId)throw new Error('没有正在执行的任务，页面没有交给用户。');
    const version = (this.controlVersions.get(id) ?? 0) + 1;
    this.controlVersions.set(id, version);
    this.pendingHandoffs.delete(id);
    const result=await this.controls.request(id,randomUUID(),'pause',runId,'page',undefined,ask,targets);

    if(!result.ok)throw new Error(result.reason??'页面没有交给用户。');
    if (this.getTaskProgress(id)?.runId === runId && this.controlVersions.get(id) === version) this.pendingHandoffs.set(id, { runId, version });
  }

  private async continuesOpenTask(request:TaskActionRequest,snapshot:TaskProgressSnapshot,entry:ConversationEntry):Promise<boolean>{
    if(request.source!=='text'||request.action!=='start'||request.forkedFrom||!request.text?.trim())return false;

    if(!['idle','error'].includes(snapshot.state)||!snapshot.runId||!snapshot.goal||!snapshot.recoveryInput||!request.context?.tabId)return false;
    const delegating=!!snapshot.continuation&&!['COMPLETED','STOPPED','FAILED'].includes(snapshot.continuation.state);
    const view=projectTaskView(snapshot);

    if(!view.resumable&&!delegating)return false;
    const session=entry.runtime.session;

    if(!session.available||session.isStreaming())return false;
    const lastReply=[...(snapshot.conversationContext?.recentTurns??[])].reverse().find(turn=>turn.role==='assistant')?.text??'';

    return view.goalStatus?.status==='waiting'||asksUser(lastReply);
  }
  taskHistory?: TaskHistoryStore;
  learnedOperations?: LearnedOperationStore;
  siteNotes?: SiteNotesStore;
  private readonly thinkingPreferences = new Map<string, import('../../shared/protocol.js').ThinkingLevel | null>();

  private readonly goalCheckPending = new Set<string>();
  private readonly goalContinuing = new Set<string>();

  private async yieldGoalContinues(except: string, full: () => boolean): Promise<void> {
    for (const id of [...this.goalContinuing]) {
      if (!full()) return;
      const entry = this.entries.get(id);

      if (id === except || !entry?.runtime.session.isStreaming() || entry.runtime.session.isHeld()) continue;
      this.goalContinuing.delete(id);
      this.controlVersions.set(id, (this.controlVersions.get(id) ?? 0) + 1);
      this.progress.get(id)?.abort();
      entry.runtime.handleMessage({ type: 'abort' });
      await entry.runtime.session.waitForStop?.().catch(() => {});
      this.emit({ type: 'agent_event', conversationId: id, event: { kind: 'notice', message: '你发了新任务，这条回答不再接着做。回答保持不变。' } });
    }
  }

  private nameTask(id:string,snap:TaskProgressSnapshot,pages:Array<{url:string;title?:string}>):void{
    const session=this.entries.get(id)?.runtime.session;

    if(!session?.nameTask||!snap.runId||!snap.goal)return;
    const runId=snap.runId,goal=snap.goal;
    const hosts=[...new Set(pages.flatMap(page=>{const host=memoryHostOfUrl(page.url);

return host?[`${host}${pages.some(other=>other.title&&memoryHostOfUrl(other.url)===host)?'+':''}`]:[];}))].sort();
    const key=`${runId}|${hosts.join(',')}`;
    const state=this.taskNames.get(id);

    if(state?.busy||state?.key===key)return;
    const count=state?.key.startsWith(`${runId}|`)?state.count:0;

    if(count>=4)return;
    this.taskNames.set(id,{key,busy:true,count:count+1});
    void session.nameTask({goal,pages}).then(title=>{
      const entry=this.entries.get(id),progress=this.progress.get(id);

      if(!title||!entry||!progress||progress.snapshot().runId!==runId||entry.summary.title===title)return;
      entry.summary.title=title;
      this.store?.save(this.list());
      this.emit({type:'conversation_updated',conversationId:id,conversation:{...entry.summary}});
    }).catch(()=>{}).finally(()=>{
      const latest=this.taskNames.get(id),progress=this.progress.get(id);

      if(latest)latest.busy=false;
      if(progress)this.nameTask(id,progress.snapshot(),progress.visitedPages());
    });
  }

  private recordTaskHistory(id: string): void {
    const history=this.taskHistory,progress=this.progress.get(id),snap=this.getTaskProgress(id);

    if(!history||!progress||!snap?.runId||!snap.goal||!['idle','aborted','error'].includes(snap.state))return;

    const acted=(snap.results??[]).some(item=>resultHasWriteEffect(item));
    const committed=(snap.results??[]).some(item=>resultLocksWhenUnknown(item));
    const view=projectTaskView(snap);
    const delivery=snap.conversationContext?.latestDelivery;
    const lastReply=[...(snap.conversationContext?.recentTurns??[])].reverse().find(turn=>turn.role==='assistant')?.text??'';

    const hosts=[...new Set(progress.visitedUrls().flatMap(url=>{const host=memoryHostOfUrl(url);

return host?[host]:[];}))].slice(0,16);

    const clip=(text:string,max:number)=>text.length>max?`${text.slice(0,max-1)}…`:text;
    const unfinished=(snap.goalCheck?(snap.goalCheck.status!=='done'&&snap.goalCheck.remaining?[snap.goalCheck.remaining]:[]):delivery?.unfinished?.length?delivery.unfinished:view.outstanding.map(item=>item.description)).slice(0,16).map(text=>clip(text,300));

    const raw:TaskHistoryEntry={
      id:snap.runId,conversationId:id,goal:clip(snap.goal,600),
      revisions:(snap.recoveryInput?.requirements??[]).filter(text=>text!==snap.goal).slice(-16).map(text=>clip(text,600)),
      hosts,
      outcome:snap.state==='aborted'?'stopped':snap.state==='error'?'error':snap.goalCheck?(snap.goalCheck.status==='done'?'complete':'partial'):view.resumable||unfinished.length?'partial':'complete',
      summary:clip(answerSpeech((delivery?deliveryTextWithNote(delivery):'')||lastReply).replace(/\s+/g,' ').trim(),600),
      unfinished,startedAt:snap.startedAt,endedAt:Date.now(),
    };

    if(snap.goalPage?.title)raw.page=clip(snap.goalPage.title,200);
    const entrySummary = this.entries.get(id)?.summary;
    if (entrySummary) {
      const line = endingFromResults(snap.results ?? [], raw.outcome);
      if (line) entrySummary.ending = line;
      if (hosts[0]) entrySummary.site = hosts[0];
      this.emit({ type: "conversation_updated", conversationId: id, conversation: { ...entrySummary } });
    }
    const entry=redactTaskSecrets(raw);
    const session=this.entries.get(id)?.runtime.session;

    if(acted)void session?.noticeHabit?.(entry).catch(()=>{});

    if(!committed&&(!snap.goalCheck||snap.goalCheck.status==='done'))return;
    const written=history.record(entry).catch(()=>{});

    const dating=(session?.datePastTask?.(entry)??Promise.resolve(null)).catch(()=>null);
    void Promise.all([written,dating]).then(([,dated])=>dated?history.patchDate(entry.id,entry.endedAt,dated):undefined).catch(()=>{});
    const labeling=(session?.labelPastTask?.(entry)??Promise.resolve(null)).catch(()=>null);
    void Promise.all([written,labeling]).then(([,label])=>label?history.patchLabel(entry.id,entry.endedAt,label):undefined).catch(()=>{});
    const describing=(session?.describePastTaskDone?.(entry)??Promise.resolve(null)).catch(()=>null);
    void Promise.all([written,describing]).then(([,done])=>done?history.patchDone(entry.id,entry.endedAt,done):undefined).catch(()=>{});

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
      const count=(snap.results??[]).filter(item=>item.status==='satisfied').length+(snap.foldedResults?.count??0);

      if(!count)return;
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
  private async startSeparateAsk(id: string, request: TaskActionRequest): Promise<boolean> {
    const text=request.text??'';
    const target='text-'+createHash('sha256').update(id+':'+request.requestId).digest('hex').slice(0,32);
    const sharesPage=/这页|这个页面|当前页|本页|这篇|这个网页|this page/i.test(text);
    const receipt=this.taskQueue.add({requestId:request.requestId,conversationId:target,originConversationId:id,source:'text',action:'start',expectedRunId:null,text,
      ...(sharesPage&&request.context?{context:request.context}:{}),...(request.pages?.length?{pages:request.pages}:{}),...(request.attachments?.length?{attachments:request.attachments}:{})},text.slice(0,36));

    if(receipt.status==='rejected')return false;
    await this.taskQueue.pump();

    return true;
  }

  private async mergeSeparateAsk(id: string, here?: PageContext): Promise<void> {
    const job=this.taskQueue.get(id);

    if(!job?.request.originConversationId||job.request.source!=='text'||job.receipt.result||isMerged(job)||this.merging.has(id))return;
    this.merging.add(id);

    try{
      const origin=job.request.originConversationId,originSession=this.entries.get(origin)?.runtime.session;
      const running=!!originSession?.isStreaming()&&!originSession.isHeld();
      const sent=await this.dispatchTaskAction({requestId:`merge-${randomUUID()}`,conversationId:origin,source:'text',action:running?'steer':'start',
        expectedRunId:this.getTaskProgress(origin)?.runId??null,text:job.request.text,...(job.request.context??here?{context:job.request.context??here}:{}),...(job.request.pages?{pages:job.request.pages}:{}),...(job.request.attachments?{attachments:job.request.attachments}:{})}).catch((error:unknown)=>({status:'rejected' as const,message:error instanceof Error?error.message:String(error)}));

      if(!['accepted','applied','queued'].includes(sent.status)){
        this.emit({type:'agent_event',conversationId:origin,event:{kind:'notice',message:`没能并回上一件：${sent.message.replace(/[。.]+$/,'')}。另开的那件照常在做。`}});
        this.emitReceipt(job.receipt);

        return;
      }

      if(['queued','suspended'].includes(job.state))this.taskQueue.cancel(id);
      else if(this.entries.has(id))await this.dispatchTaskAction({requestId:`merge-abort-${randomUUID()}`,conversationId:id,source:'text',action:'abort',expectedRunId:this.getTaskProgress(id)?.runId??null}).catch(()=>undefined);
      this.taskQueue.settleSeparate(id,{merged:true});
    }finally{this.merging.delete(id);}
  }

  private relaySeparateAnswer(id: string): void {
    const job=this.taskQueue.get(id),snapshot=this.getTaskProgress(id);
    const delivery=snapshot?.conversationContext?.latestDelivery;

    if(!job?.request.originConversationId||job.request.source!=='text')return;

    if(delivery&&delivery.kind!=='ack'&&delivery.text.trim()&&delivery.runId===snapshot?.runId)this.taskQueue.settleSeparate(id,{text:delivery.text});
    else if(snapshot?.state==='error'||snapshot?.state==='aborted')this.taskQueue.settleSeparate(id,{failed:snapshot.state==='aborted'?'已停下，没有做完。':'没做成，出错了。'});
  }

  private emitReceipt(receipt: TaskReceipt): void {
    for(const id of new Set([receipt.conversationId,...(receipt.originConversationId?[receipt.originConversationId]:[])]))this.emit({type:'agent_event',conversationId:id,event:{kind:'notice',message:receipt.message,
      ...(receipt.message.startsWith('同一请求编号')?{}:{receipt})}});
  }
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

    if (previous?.inputId !== call.inputId) {
      const before = snapshot;

      if (snapshot.state !== 'interrupted') progress.request(call.text,input.context,input.attachments);
      else progress.recordUserTurn(call.text,call.inputId);

      try { await entry.runtime.session.persistAcceptedTask(progress.snapshot(),input.attachments); }
      catch (error) { progress.restoreResults(before); throw realtimeBrowserError(error, 'not_executed'); }

      entry.runtime.session.prepareRealtimeBrowserInput(call.text,input.context);
      this.directVoiceInputs.set(id,{inputId:call.inputId,runId:progress.snapshot().runId ?? null});
      this.publishRunIdentity(id);
    }

    return entry.runtime.session.executeRealtimeBrowserTool(call.name,call.args,signal,{inputId:call.inputId,runId:progress.snapshot().runId ?? null});
  }

  private async tryQuickNavSwitch(request: TaskActionRequest, entry: ConversationEntry): Promise<Pick<TaskReceipt, 'status' | 'message' | 'runId'> | null> {
    const intent = parseQuickNavIntent(request.text ?? '');

    if (!intent) return null;

    const tabs = await entry.runtime.session.quickNavTabList?.().catch(() => null) ?? null;

    if (!tabs?.length) return null;

    const tab = matchQuickNavTab(intent.target, tabs);

    if (!tab) return null;

    const targetProgress = this.progress.get(request.conversationId)!;
    const beforeAccept = targetProgress.snapshot();
    targetProgress.request(request.text ?? '', request.context, request.attachments);
    targetProgress.goals.clear();
    const acceptedRunId = targetProgress.snapshot().runId ?? null;

    try {
      if (entry.runtime.session.persistAcceptedTask) await entry.runtime.session.persistAcceptedTask(targetProgress.snapshot(), request.attachments);
      else {
        await entry.runtime.session.persistRecoveryAttachments?.(acceptedRunId, request.attachments);
        await entry.runtime.session.persistTaskResults?.(targetProgress.snapshot());
      }
    } catch (error) {
      targetProgress.restoreResults(beforeAccept);
      throw new TaskActionRejected(`任务未能保存到本地，尚未接收、没有启动：${error instanceof Error ? error.message : String(error)}`);
    }

    this.taskQueue.bindRun(request.conversationId, acceptedRunId);
    if (entry.summary.title === '新会话') entry.summary.title = (request.text ?? '').trim().slice(0, 36) || entry.summary.title;
    this.publishRunIdentity(request.conversationId);
    this.pendingStarts.add(request.conversationId);
    setTimeout(() => { void this.completeQuickNavSwitch(request.conversationId, entry, tab, acceptedRunId); }, 0);

    return { status: 'accepted', runId: acceptedRunId, message: `已接收新任务：${request.text ?? ''}` };
  }

  private async completeQuickNavSwitch(conversationId: string, entry: ConversationEntry, tab: { id: number; title: string; url: string }, runId: string | null): Promise<void> {
    try {
      const landed = await entry.runtime.session.runQuickNavSwitch(tab.id);

      if (!landed.shown) throw new Error('标签页存在，但没能确认它已切到你眼前。');

      const delivery = createUserDelivery({ conversationId, runId, kind: 'finding', text: `已切到「${tab.title}」（${tab.url}）。` });
      this.messagePumps.get(conversationId)?.({ type: 'agent_event', event: { kind: 'user_delivery', delivery } });
      this.messagePumps.get(conversationId)?.({ type: 'agent_event', event: { kind: 'goal_check', status: 'done' } });
    } catch (error) {
      this.messagePumps.get(conversationId)?.({ type: 'agent_event', event: { kind: 'notice', message: `快速切换没有完成：${error instanceof Error ? error.message : String(error)}` } });
    } finally {
      this.pendingStarts.delete(conversationId);
    }
  }

  async dispatchTaskAction(request: TaskActionRequest, stillCurrent = () => true, inputOptions?: UserInputOptions): Promise<TaskReceipt> {
    if (!isTaskActionRequest(request)) throw new Error('无效的任务请求');

    if (request.action !== 'status') this.entries.get(request.conversationId)?.runtime.session.settleAnswerGate();

    if (['start', 'steer', 'abort'].includes(request.action)) this.goalContinuing.delete(request.conversationId);

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
      const continuation=originalRequest.source==='text'?continuationInput(originalRequest.text??''):null;
      const explicitAmendment=!!continuation?.amendment&&!!snapshot.runId&&!!snapshot.recoveryInput;

      let request = originalRequest.source === 'text' && originalRequest.action === 'start' && !originalRequest.forkedFrom
        && continuation
        && (snapshot.state === 'interrupted' || ['idle','error'].includes(snapshot.state) && (projectTaskView(snapshot).resumable||explicitAmendment))
        ? { ...originalRequest, action: 'resume' as const } : originalRequest;

      if (snapshot.continuation && !['COMPLETED','STOPPED','FAILED'].includes(snapshot.continuation.state) && originalRequest.source === 'text' && originalRequest.action === 'start') {
        const command = (originalRequest.text ?? '').trim().replace(/[。！!？?\s]/g, '');
        if (['停止','停止关注','中止','中止关注','取消关注'].includes(command)) request = { ...originalRequest, action: 'abort' };
        else if (['暂停','暂停关注'].includes(command)) request = { ...originalRequest, action: 'pause' };
        else if (continuation) request = continuation.amendment ? { ...originalRequest, action: 'steer', text: continuation.amendment } : { ...originalRequest, action: 'resume' };
      }
      if (request===originalRequest&&await this.continuesOpenTask(originalRequest,snapshot,entry))request={...originalRequest,action:'steer' as const};

      if (request.expectedRunId !== (snapshot.runId??null))throw new TaskActionRejected('原任务已停止或发生变化，操作未执行。');

      if(request.expectedControlVersion!==undefined&&request.expectedControlVersion!==(this.controlVersions.get(request.conversationId)??0))throw new TaskActionRejected('页面归属又变了，旧计划的后续步骤没有执行。');

      const observer = this.observers.get(request.conversationId), delegation = snapshot.continuation;
      if (observer && delegation && !['COMPLETED','STOPPED','FAILED'].includes(delegation.state) && ['pause','abort','steer','start','resume'].includes(request.action)) {
        if (request.action === 'pause' || request.action === 'abort') {
          await observer.control(request.action === 'abort' ? 'stop' : 'pause', request.action === 'abort' ? '用户停止' : '用户暂停');
          this.controlVersions.set(request.conversationId, (this.controlVersions.get(request.conversationId) ?? 0) + 1);
          this.queueTaskView(request.conversationId);
          if (entry.runtime.session.isStreaming()) entry.runtime.session.abort();
          if (request.action === 'abort') this.progress.get(request.conversationId)!.abort();
          await this.saveContinuation(request.conversationId);
          return { status: 'applied', runId: snapshot.runId ?? null, message: request.action === 'abort' ? '关注已停止，已有结果保留。' : '关注已暂停，等待你继续。' };
        }
        if (request.action === 'start') throw new TaskActionRejected('原来的网页关注还在进行。要另开会话处理这个新问题吗？', true);
        if (request.action === 'resume') {
          if (delegation.state === 'WAITING_CONDITION') return { status: 'applied', runId: snapshot.runId ?? null, message: `仍在关注：${delegation.condition.description}` };
          if (delegation.state === 'RUNNING' || delegation.state === 'VERIFYING') return { status: 'applied', runId: snapshot.runId ?? null, message: '正在按原委托处理。' };
          try { await observer.resume(request.context); }
          catch (error) { throw new TaskActionRejected(error instanceof Error ? error.message : '未能继续关注。'); }
          this.queueTaskView(request.conversationId);
          return { status: 'applied', runId: snapshot.runId ?? null, message: '已继续关注，条件满足后自动处理。' };
        }
        if (request.action === 'steer' && !entry.runtime.session.isStreaming()) {
          if (!request.context || request.context.url !== delegation.url) throw new TaskActionRejected('请先回到原委托页面。');
          await observer.control('revise', '用户修改了原委托');
          const current = this.progress.get(request.conversationId)!;
          current.recordRequirement(request.text ?? '', request.context, request.attachments); current.recordUserTurn(request.text ?? '', request.requestId); current.reviseResults();
          const live = current.snapshot().continuation!;
          current.setContinuation({ ...live, state: 'RUNNING', processingVersion: live.observedVersion, segmentStartedAt: Date.now() });
          await this.saveContinuation(request.conversationId);
          try { await entry.runtime.session.continueCondition(current.snapshot(), true); }
          catch (error) { await observer.control('pause', error instanceof Error ? error.message : '未能继续原委托'); throw error; }
          return { status: 'accepted', runId: snapshot.runId ?? null, message: '正在按当前要求继续原委托。' };
        }
        if (request.action === 'steer') {
          await observer.control('revise', '用户修改了目标，旧条件已撤销');
          const c = this.progress.get(request.conversationId)!.snapshot().continuation!;
          this.progress.get(request.conversationId)!.setContinuation({ ...c, state: 'RUNNING', segmentStartedAt: Date.now() });
        }
        snapshot = this.getTaskProgress(request.conversationId)!;
      }

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

      if(['idle','error'].includes(snapshot.state)&&(projectTaskView(snapshot).resumable||explicitAmendment)
        &&(request.action==='resume'||request.action==='start'&&isInterruptedResumeText(request.text??''))){
        if(request.action!=='resume')throw new TaskActionRejected('请继续原任务，不要将未完成事项重新登记为新任务。');

        if(!request.context?.tabId||!entry.runtime.session.available)throw new TaskActionRejected('继续前需要当前页面和可用模型，原任务的未完成记录保持不变。');
        this.progress.get(request.conversationId)!.interrupt('manual_continuation');
        snapshot=this.getTaskProgress(request.conversationId)!;
        this.publishRunIdentity(request.conversationId);
      }

      if(request.action==='resume'&&snapshot.state==='interrupted'){
        if(!request.expectedRunId||!snapshot.goal)throw new TaskActionRejected('没有可以接着做的原任务。');

        if(this.checkpointResumes.has(request.conversationId))throw new TaskActionRejected('正在恢复原任务，不用再点继续。');

        if(this.runningTasks()>=2)throw new TaskActionRejected('现在同时做的任务太多，原任务还在，稍后再继续。');

        if(!entry.runtime.session.available)throw new TaskActionRejected('当前模型不可用，原任务还在。');

        this.pendingStarts.add(request.conversationId);
        this.checkpointResumes.add(request.conversationId);
        const version=this.controlVersions.get(request.conversationId)??0;

        try{
          await entry.runtime.session.waitForStop?.();
          const context = await entry.runtime.session.recoveryContext(snapshot, request.context);
          const now=this.getTaskProgress(request.conversationId);

          if(!this.connected||!stillCurrent()||!now||now.runId!==snapshot.runId||now.state!=='interrupted'||version!==(this.controlVersions.get(request.conversationId)??0))throw new TaskActionRejected('原任务已取消或变了，没有恢复。');
          this.taskPages.set(request.conversationId, context.tabId);
          this.progress.get(request.conversationId)!.prepareResume();
          await entry.runtime.session.resumeInterruptedTask(snapshot,context,request.attachments,request.pages);
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

        if(this.runningTasks()-(ownsReservation?1:0)>=2)await this.yieldGoalContinues(request.conversationId,()=>this.runningTasks()-(ownsReservation?1:0)>=2);

        if(this.runningTasks()-(ownsReservation?1:0)>=2)throw new TaskActionRejected('当前执行名额已满，请等待运行中的任务完成。');

        if(request.context?.tabId!==undefined)this.taskPages.set(request.conversationId,request.context.tabId);

        if(!entry.runtime.session.available)throw new TaskActionRejected('当前执行模型不可用，任务未启动。');

        if (request.source === 'text' && !request.attachments?.length && !request.pages?.length) {
          const quickReceipt = await this.tryQuickNavSwitch(request, entry);

          if (quickReceipt) return quickReceipt;
        }

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

        const targetProgress=this.progress.get(request.conversationId)!;
        const beforeAccept=targetProgress.snapshot();
        targetProgress.request(request.text??'',request.context,request.attachments);

        if (inputOptions?.conversationOnly) targetProgress.goals.clear();
        const acceptedRunId=targetProgress.snapshot().runId??null;

        try{
          if(entry.runtime.session.persistAcceptedTask)await entry.runtime.session.persistAcceptedTask(targetProgress.snapshot(),request.attachments);
          else{
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
          const options = request.pages?.length || request.source === 'voice' ? { ...inputOptions, ...(request.pages?.length ? { pages: request.pages } : {}), ...(request.source === 'voice' ? { spoken: true } : {}) } : inputOptions;
          if(options)entry.runtime.session.startTask(request.text??'',request.context,request.attachments,options);
          else entry.runtime.session.startTask(request.text??'',request.context,request.attachments);
        }catch(error){this.pendingStarts.delete(request.conversationId);throw error;}

        return {status:'accepted',runId:entry.summary.runId??null,message:`已接收新任务：${request.text??'使用所选资料'}`};
      }

      if(request.action==='pause'||request.action==='resume'||request.action==='abort'){
        if(!request.expectedRunId)throw new TaskActionRejected('当前没有可控制的任务。');

        if(request.action==='resume'&&!entry.runtime.session.isHeld()&&!entry.runtime.control.isGroupHeld())throw new TaskActionRejected(snapshot.state==='aborted'?'任务已经中止，不能继续原任务。':'原任务没有暂停，未执行交还。');

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
        if(this.checkpointResumes.has(request.conversationId))throw new TaskActionRejected('正在恢复原任务，这条修改还没发送。');
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
        entry.runtime.session.queueSteerForResume(request.text??'',request.context,request.attachments,request.pages);

        if(this.progress.get(request.conversationId)?.snapshot().runId===originRun) {
          this.progress.get(request.conversationId)?.reviseResults();
          this.progress.get(request.conversationId)?.recordUserTurn(request.text??'',request.requestId);
          await entry.runtime.session.persistTaskResults?.(this.progress.get(request.conversationId)!.snapshot());
        }

        const handoff = this.pendingHandoffs.get(request.conversationId);
        if (handoff && originRun === handoff.runId && handoff.version === (this.controlVersions.get(request.conversationId) ?? 0)) {
          this.pendingHandoffs.delete(request.conversationId);
          this.controlVersions.set(request.conversationId, handoff.version + 1);
          let reason = '页面控制没有确认';
          try {
            const resumed = await this.controls.request(request.conversationId, randomUUID(), 'resume', handoff.runId);
            if (resumed.ok) return {status:'accepted',runId:originRun,message:'已收到，正在继续原任务。'};
            reason = resumed.reason ?? reason;
          } catch (error) { reason = error instanceof Error ? error.message : reason; }
          return {status:'accepted',runId:originRun,message:`${RESUME_UNCONFIRMED}：${reason}。请先查看当前页面状态。`};
        }

        return {status:'accepted',runId:originRun??null,message:`修改已保存，继续后生效：${request.text??'所选资料'}`};
      }

      if (!request.expectedRunId || snapshot.runId !== request.expectedRunId || !['running','idle'].includes(snapshot.state) || !entry.runtime.session.isStreaming()) {
        throw new TaskActionRejected('原任务已中止或变了，修改没有发送。');
      }

      if (entry.runtime.session.isHeld()) throw new TaskActionRejected('页面现在归你，请先交还。');
      const originRun=snapshot.runId;
      const revokeRequirement=this.progress.get(request.conversationId)!.recordRequirement(request.text??'',request.context,request.attachments);
      await entry.runtime.session.persistRecoveryAttachments?.(originRun??null,request.attachments);

      try{await entry.runtime.session.steerCurrentTask(request.text!,request.context,request.attachments,{rewrite:request.source==='text',pages:request.pages,spoken:request.source==='voice'||inputOptions?.spoken});}
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

    for (const method of ["observe", "request", "abort", "recordRequirement", "interrupt", "prepareResume", "restoreResults", "reviseResults", "invalidatePage", "registerResults", "stopAfterFailures", "stopForRestrictedPage"] as const) {
      const original = progress[method].bind(progress) as (...args: unknown[]) => unknown;
      (progress as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
        const result = original(...args);
        this.queueTaskView(id);

        return result;
      };
    }

    const pump = (message: ServerMessage) => {
      if (summary.checkpoint === 'unavailable') return;
      const currentRun=progress.snapshot().runId;
      const stale=typeof message.runId==='string'&&currentRun!==null&&message.runId!==currentRun;

      if(stale){
        this.emit({...message,conversationId:id});

        return;
      }

      if(progress.snapshot().state==='interrupted'&&!this.checkpointResumes.has(id)
        &&(message.type==='status'||message.type==='agent_event'&&['agent_start','agent_end','turn_start','turn_end','text_delta','thinking_delta','user_delivery','user_delivery_stream','tool_start','tool_end'].includes(message.event.kind)))return;

      if(message.type==='agent_event'&&isLeadSession(message.sessionId)&&['agent_start','agent_end','error'].includes(message.event.kind)){this.pendingStarts.delete(id);this.checkpointResumes.delete(id);}

      if(message.type==='status'&&isLeadSession(message.sessionId)&&message.state==='running'){this.pendingStarts.delete(id);this.checkpointResumes.delete(id);}

      progress.observe(message);
      if (message.type === 'agent_event' && isLeadSession(message.sessionId) && message.event.kind === 'goal_check') {
        const c = progress.snapshot().continuation;
        if (c && message.event.status === 'checking' && c.state === 'RUNNING') progress.setContinuation({ ...c, state: 'VERIFYING' });
        if (c && message.event.status === 'continue' && c.state === 'VERIFYING') progress.setContinuation({ ...c, state: 'RUNNING' });
      }
      const progressSnapshot=progress.snapshot();

      if(message.type==='agent_event'&&['agent_start','tool_end','agent_end'].includes(message.event.kind))this.nameTask(id,progressSnapshot,progress.visitedPages());

      if(progressSnapshot.state==='interrupted')summary.checkpoint='interrupted';
      else delete summary.checkpoint;

      if (message.type === "agent_event" && message.event.kind === "tool_observation") {
        this.entries.get(id)?.runtime.session.persistTaskResults?.(progressSnapshot);

        return;
      }

      this.entries.get(id)?.runtime.session.persistTaskResults?.(progressSnapshot);
      summary.runId = progressSnapshot.runId;
      const live=this.entries.get(id)?.runtime;
      const carriesIdentity=['tool_call','control_result','team_status','status'].includes(message.type)||(message.type==='agent_event'&&message.event.kind==='agent_start');
      const scoped:ServerMessage = { ...message, conversationId: id, ...(live&&carriesIdentity?{epochs:{...this.epochs(live),...message.epochs}}:{}) };
      const freshDisplayCall = message.type === 'tool_call' && typeof message.sdkId === 'string' && message.sdkId.startsWith('display-');

      if(carriesIdentity&&scoped.type!=='task_control'&&!freshDisplayCall)scoped.runId=progressSnapshot.runId;
      this.emit(scoped);

      if (message.type === 'agent_event' && isLeadSession(message.sessionId) && message.event.kind === 'agent_start') { this.goalCheckPending.delete(id); this.taskQueue.resumeSeparate(id); }

      if (message.type === 'agent_event' && isLeadSession(message.sessionId) && message.event.kind === 'goal_check' && message.event.status === 'checking') this.goalCheckPending.add(id);

      if (message.type === 'agent_event' && isLeadSession(message.sessionId) && message.event.kind === 'goal_check' && message.event.status === 'continue') this.goalContinuing.add(id);

      if (message.type === 'agent_event' && isLeadSession(message.sessionId) && message.event.kind === 'agent_end') this.goalContinuing.delete(id);

      if (message.type === 'agent_event' && message.event.kind === 'agent_end' && isLeadSession(message.sessionId) && !progressSnapshot.continuation) {
        void this.fulfillOwedDelivery(id).finally(()=>{ if (!this.goalCheckPending.has(id)) this.recordTaskHistory(id); this.relaySeparateAnswer(id); });

        try{this.taskQueue.finish(id,progress.snapshot().state==='aborted'?'cancelled':progress.snapshot().state==='error'?'failed':'completed');}catch{this.emit({type:'agent_event',conversationId:id,event:{kind:'error',message:'任务结束状态未能保存，请核对已有结果。'}});}

        this.pumpTasks();
      }

      if (message.type === 'agent_event' && isLeadSession(message.sessionId) && message.event.kind === 'goal_check' && ['done','needs_user','open','blocked','unavailable'].includes(message.event.status)) {
        void this.observers.get(id)?.settled(message.event.status as 'done'|'needs_user'|'open'|'blocked'|'unavailable').catch(error => console.error('[continuation] could not save verification', error));
      }
      if (message.type === 'agent_event' && message.event.kind === 'agent_end' && progressSnapshot.continuation) this.pumpTasks();
      if (message.type === 'agent_event' && message.event.kind === 'error' && progressSnapshot.continuation) void this.observers.get(id)?.settled('unavailable').catch(error => console.error('[continuation] failure checkpoint unavailable', error));

      if (message.type === 'agent_event' && message.event.kind === 'goal_check' && message.event.status !== 'continue' && message.event.status !== 'checking' && isLeadSession(message.sessionId) && progress.snapshot().state === 'idle') { this.goalCheckPending.delete(id); this.recordTaskHistory(id); }

      if (message.type === 'agent_event' && message.event.kind === 'agent_start') this.emit({type:'conversation_updated',conversationId:id,conversation:{...summary}});

      if (message.type === "status") {
        states.set(message.sessionId ?? "main", message.state);
        summary.state = [...states.values()].includes("running") ? "running" : [...states.values()].includes("user") ? "user" : "idle";
        summary.updatedAt = Date.now();
        if (summary.state === "user") summary.ending = "页面现在归你";
        else if (summary.ending === "页面现在归你") delete summary.ending;
        this.emit({ type: "conversation_updated", conversationId: id, conversation: { ...summary } });
      }

      if (message.type === "model_info") {
        summary.model = message.model;
        this.emit({ type: "conversation_updated", conversationId: id, conversation: { ...summary } });
      }

      if (message.type === "status" || message.type === "model_info") this.store?.save(this.list());
    };
    this.messagePumps.set(id, pump);
    const promise = this.factory(id, pump, summary).then((runtime) => {
      summary.model = runtime.session.modelName();
      runtime.onHandToUser?.((ask, targets) => this.handToUser(id, ask, targets));
      runtime.control.setTabCoordinator?.(async (owner, members) => {
        const source = this.entries.get(owner)?.runtime;

        if (!source) return;

        if (source.session.isHeld()) throw new Error("页面现在归你，操作未执行");
        await source.control.stopMembersForForeignTakeover(members);
      });
      runtime.control.setIdleOwnerCheck?.(owner => this.conversationIdle(owner));
      const entry = { summary, runtime };
      let restoredResults: TaskProgressSnapshot | null | undefined;

      try {
        restoredResults = runtime.session.readPersistedTaskResults?.();

        if (restoredResults && restoredResults.conversationId !== id) throw new Error(TASK_CHECKPOINT_UNAVAILABLE);
      } catch {
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
        stopForRestrictedPage: () => { progress.stopForRestrictedPage(); runtime.session.persistTaskResults?.(progress.snapshot()); },
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

      for (const [model, level] of this.thinkingPreferences) runtime.session.setThinking(model, level, true);
      runtime.session.emitThinkingLevel();
      runtime.session.bindVoiceTurnGate?.(this.voiceTurns);
      runtime.session.bindConversationContext?.(() => this.getTaskProgress(id));
      runtime.session.bindVisitedUrls?.(() => this.progress.get(id)?.visitedUrls() ?? []);
      this.entries.set(id, entry);
      const observer = new TaskContinuationObserver({
        rpc: runtime.rpc, enabled: () => this.continuationEnabled() && this.connected && !this.queueClosed,
        snapshot: () => progress.snapshot(), update: value => progress.setContinuation(value),
        save: () => this.saveContinuation(id), changed: () => {
          this.queueTaskView(id);
          const c = progress.snapshot().continuation;
          if (c?.state === 'COMPLETED') {
            this.taskQueue.finish(id, 'completed');
            void this.fulfillOwedDelivery(id).finally(() => { this.recordTaskHistory(id); this.relaySeparateAnswer(id); });
          }
          if (c?.state === 'STOPPED') this.taskQueue.finish(id, 'cancelled');
        },
        idle: () => !runtime.session.isStreaming() && !runtime.session.isHeld() && this.runningTasks() < 2,
        modelCalls: () => progress.modelCalls(),
        wake: value => this.wakeContinuation(id, value),
        stopExecution: () => { if (runtime.session.isStreaming()) runtime.session.abort(); },
      });
      this.observers.set(id, observer);
      runtime.rpc.continuationPage = () => {
        const c = progress.snapshot().continuation;
        return c && !['COMPLETED','STOPPED','FAILED'].includes(c.state) ? { tabId: c.tabId, url: c.url, documentId: c.documentId } : undefined;
      };
      runtime.onWaitForCondition?.(input => observer.register(input));
      if (restoredResults?.continuation) void observer.restore().catch(error => console.error('[continuation] restore stopped', error));
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

        return entry.runtime.session.answerReading(transcript, signal, onText, message.requestId);
      }, event => this.emit(event));

      return;
    }

    if (message.type === 'reading_import') {
      await this.get(normalizeConversationId(message.conversationId))?.runtime.session.importReading(message.transcript);

      return;
    }

    if (message.type === 'reading_route') {
      let route: 'reading' | 'task' = 'task';
      try {
        const id = normalizeConversationId(message.conversationId);
        const entry = this.get(id) ?? (id === DEFAULT_CONVERSATION_ID ? await this.ensureDefault() : undefined);
        route = await entry?.runtime.session.judgeReadingRoute(message) ?? 'task';
      } catch { route = 'task'; }
      this.emit({ type: 'reading_route_result', requestId: message.requestId, route });
      return;
    }

    if (message.type === 'nudge_validate') {
      let valid = false;
      try {
        const id = normalizeConversationId(message.conversationId);
        const entry = this.get(id) ?? (id === DEFAULT_CONVERSATION_ID ? await this.ensureDefault() : undefined);
        valid = await entry?.runtime.session.validateNudgeMemory(message.memory, message.url) ?? false;
      } catch { valid = false; }
      this.emit({ type: 'nudge_validation', requestId: message.requestId, valid });
      return;
    }

    if (message.type === 'browse_habit_ask') {
      try {
        const id = normalizeConversationId(message.conversationId);
        const entry = this.get(id) ?? (id === DEFAULT_CONVERSATION_ID ? await this.ensureDefault() : undefined);
        await entry?.runtime.session.askBrowsing(message.key);
      } catch {  }

      return;
    }

    if (message.type === 'browse_habit_request') {
      let habits: BrowseHabit[] = [];

      try {
        const id = normalizeConversationId(message.conversationId);
        const entry = this.get(id) ?? (id === DEFAULT_CONVERSATION_ID ? await this.ensureDefault() : undefined);
        habits = await entry?.runtime.session.noticeBrowsing(message.days, message.dismissed) ?? [];
      } catch { habits = []; }

      this.emit({ type: 'browse_habit_result', requestId: message.requestId, habits });

      return;
    }

    if (message.type === 'nudge_request') {
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

    if(message.type==='task_action'&&message.request.action==='abort'&&message.request.supplement){await this.mergeSeparateAsk(message.request.conversationId,message.request.context);

      return;}

    const stopped=message.type==='task_action'&&message.request.action==='resume'?this.taskQueue.get(message.request.conversationId):undefined;
    if(message.type==='task_action'&&stopped?.state==='unknown'&&stopped.request.originConversationId){
      const receipt=await this.dispatchTaskAction(message.request);

      if(!['accepted','applied'].includes(receipt.status))this.emitReceipt({...stopped.receipt,message:`还没做完，没能接着做：${receipt.message}`,updatedAt:Date.now()});

      return;
    }

    if(message.type==='task_action'&&['queued','suspended'].includes(this.taskQueue.get(message.request.conversationId)?.state??'')){await this.dispatchTaskAction(message.request);

return;}

    if (message.type === "warm_up") {
      this.warmUp(id, message.context, message.connection === true);

      return;
    }

    if (message.type === "page_translate") {
      const fallback = this.entries.get(id) ? undefined : await this.ensureDefault();
      (this.entries.get(id) ?? fallback)?.runtime.handleMessage(message);

      return;
    }

    const entry = this.entries.get(id) ?? (id === DEFAULT_CONVERSATION_ID ? await this.ensureDefault() : undefined);

    if (!entry) throw new Error(`CONVERSATION_NOT_FOUND: ${id}`);

    if (entry.summary.checkpoint === 'unavailable' && message.type !== 'task_action' && message.type !== 'task_receipt_query' && message.type !== 'task_view_query') {
      this.emit({type:'agent_event',conversationId:id,event:{kind:'error',message:TASK_CHECKPOINT_UNAVAILABLE}});

      return;
    }

    if(message.type==='task_control_result'){this.controls.receive({...message,conversationId:id});

return;}

    if(message.type==='user_message'||message.type==='steer'||message.type==='abort'||message.type==='takeover')entry.runtime.session.settleAnswerGate();

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

    if (message.type === 'task_action') {
      const request=message.request,session=entry.runtime.session;

      const runId=this.getTaskProgress(id)?.runId??null,control=this.controlVersions.get(id)??0;
      const same=()=>session.isStreaming()&&!session.isHeld()&&(this.getTaskProgress(id)?.runId??null)===runId&&(this.controlVersions.get(id)??0)===control;
      if(request.source==='text'&&request.action==='steer'&&request.text?.trim()&&request.expectedRunId===runId&&same()
        &&await session.judgeInterjection(request.text)==='separate'&&same()&&await this.startSeparateAsk(id,request))return;
      await this.dispatchTaskAction(request);

      return;
    }

    if (message.type === 'task_view_query') { this.emitTaskView(id, true);

 return; }

    if (message.type === 'task_receipt_query') {
      const receipt = this.taskQueue.list(id).find(j=>j.request.requestId===message.requestId)?.receipt??this.dispatcher.get(id,message.requestId)??this.dispatcher.store.list(id).find(r=>r.requestId===message.requestId);

      if (receipt) this.emitReceipt(receipt);
      else {const result=this.voicePlans.get(id,message.requestId);this.emit({type:'agent_event',conversationId:id,event:{kind:'notice',message:result?'这份语音计划的结果见逐步记录；不会自动重做。':'未找到这条请求的结果，请不要自动重发。',...(result?.plan?.steps.length?{plan:result.plan}:{})}});}

      return;
    }

    if (message.type === "set_thinking") {
      const current = this.entries.get(id)?.runtime.session;
      if (!current) return;
      current.setThinking(message.model, message.level, message.restore);
      this.thinkingPreferences.set(message.model, message.level);
      for (const entry of this.entries.values()) if (entry.runtime.session !== current) entry.runtime.session.setThinking(message.model,message.level,true);

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

    if (message.type === "site_note_delete" || message.type === "site_note_list") {
      try {
        if (!this.siteNotes) throw new Error("站点笔记不可用");
        if (message.type === "site_note_list") {
          const { notes } = await this.siteNotes.list();
          this.emit({ type: "site_note_list_result", conversationId: id, requestId: message.requestId, ok: true, notes });
        } else {
          await this.siteNotes.remove(message.host, message.text, message.runId);
          this.emit({ type: "site_note_delete_result", conversationId: id, requestId: message.requestId, ok: true });
        }
      } catch (error) {
        const errorText = error instanceof Error ? error.message : String(error);
        if (message.type === "site_note_list") this.emit({ type: "site_note_list_result", conversationId: id, requestId: message.requestId, ok: false, error: errorText });
        else this.emit({ type: "site_note_delete_result", conversationId: id, requestId: message.requestId, ok: false, error: errorText });
      }
      return;
    }

    if (message.type === "skill_operations_list" || message.type === "skill_operation_delete") {
      try {
        if (!this.learnedOperations) throw new Error("可直接运行的技能不可用");
        if (message.type === "skill_operation_delete") await this.learnedOperations.delete(message.id);
        const operations = (await this.learnedOperations.list()).map(({ id, name, purpose, site, inputSchema }) => ({ id, name, purpose, site, inputSchema }));
        this.emit({ type: "skill_operations_result", conversationId: id, requestId: message.requestId, ok: true, operations });
      } catch (error) {
        this.emit({ type: "skill_operations_result", conversationId: id, requestId: message.requestId, ok: false, error: error instanceof Error ? error.message : String(error) });
      }

      return;
    }

    if (message.type === "skill_operation_run") {
      try {
        if (!this.learnedOperations) throw new Error("可直接运行的技能不可用");
        const operation = await this.learnedOperations.get(message.id);
        if (!operation) {
          this.emit({ type: "skill_operation_run_result", conversationId: id, requestId: message.requestId, ok: true, result: { status: "invalid_input", operationId: message.id, reason: "这个技能已经删除。请在技能管理里移除它的入口。", steps: 0 } });
          return;
        }
        if (message.tabId !== undefined) await entry.runtime.rpc.call("dialog_info", { tabId: message.tabId });
        const result = await runLearnedOperation(operation, message.input, { call: (name, params) => entry.runtime.rpc.call(name, params) });
        await this.learnedOperations.recordRun(operation.id, result).catch(() => {});
        this.emit({ type: "skill_operation_run_result", conversationId: id, requestId: message.requestId, ok: true, result });
      } catch (error) {
        this.emit({ type: "skill_operation_run_result", conversationId: id, requestId: message.requestId, ok: false, error: error instanceof Error ? error.message : String(error) });
      }

      return;
    }

    if(message.type==='user_message'){
      const checkpoint=this.getTaskProgress(id);
      if (checkpoint?.continuation && !['COMPLETED','STOPPED','FAILED'].includes(checkpoint.continuation.state)) {
        await this.dispatchTaskAction({ requestId: `continuation-input-${randomUUID()}`, conversationId: id, source: 'text', action: 'start', expectedRunId: checkpoint.runId ?? null, text: message.text, context: message.context, attachments: message.attachments });
        return;
      }

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
      this.emit({type:'agent_event',conversationId:id,event:{kind:'notice',message:'任务正在启动或恢复，这条要求还没发送；等它开始后再补充。'}});

      return;
    }

    if(message.type==='user_message'&&!entry.runtime.session.isStreaming()&&!entry.runtime.session.isHeld()&&this.runningTasks()>=2)await this.yieldGoalContinues(id,()=>this.runningTasks()>=2);

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

      if (progress && (progress.snapshot().runId ?? null) !== before) this.publishRunIdentity(id);
    }

    if (message.type === "abort") {this.pendingStarts.delete(id);this.checkpointResumes.delete(id);this.progress.get(id)?.abort();}

    if (message.type === 'user_message' || message.type === 'steer' || message.type === 'abort') this.goalContinuing.delete(id);

    if(message.type==='user_message'&&!entry.runtime.session.isStreaming()&&!entry.runtime.session.isHeld())this.pendingStarts.add(id);

    if(message.type==='steer'&&entry.runtime.session.isStreaming()&&!entry.runtime.session.isHeld()){
      await this.dispatchTaskAction({requestId:`steer-${randomUUID()}`,conversationId:id,source:'text',action:'steer',expectedRunId:this.getTaskProgress(id)?.runId??null,text:message.text,context:message.context,attachments:message.attachments},undefined,message.spoken?{spoken:true}:undefined);

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

      if (message.type === "memory_ask_answer") {
        const session = this.entries.get(conversationId)?.runtime.session;

        if (!session?.answerMemoryAsk) throw new MemoryAskClosed(MEMORY_ASK_EXPIRED);
        const answered = await session.answerMemoryAsk(message.askId, message.answer, message.text);
        const result: Extract<ServerMessage, { type: "memory_result" }> = { type: "memory_result", conversationId, requestId: message.requestId, action, ok: true };

        if (answered.rev !== undefined) result.rev = answered.rev;

        if (answered.entry) result.entry = answered.entry;

        if (answered.entries) result.entries = answered.entries;

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

      let pending = this.memoryForgetRequests.get(message.requestId);

      if (pending && (pending.id !== message.id || pending.version !== message.expectedVersion)) throw new Error("同一个操作编号不能用于不同的记忆。");
      if (!pending) {
        pending = { id: message.id, version: message.expectedVersion, result: this.memoryStore.forget({ id: message.id, expectedVersion: message.expectedVersion }) };
        this.memoryForgetRequests.set(message.requestId, pending);
        const captured = pending;
        const expire = () => {
          const timer = setTimeout(() => { if (this.memoryForgetRequests.get(message.requestId) === captured) this.memoryForgetRequests.delete(message.requestId); }, 30_000);
          if (typeof timer === "object" && "unref" in timer) timer.unref();
        };
        void pending.result.then(expire, expire);
      }
      const removed = await pending.result;
      this.emit({ type: "memory_result", conversationId, requestId: message.requestId, action, ok: true, deletedId: message.id, entries: removed, rev: await this.memoryStore.currentRev() });
    } catch (error) {
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

      if (error instanceof MemoryAskClosed) result.askClosed = true;
      this.emit(result);

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
      void runtime.session.availableModels().then((models) => {
        emit({ type: "model_info", conversationId: summary.id, model: runtime.session.modelName(), models });
        const thinking = runtime.session.thinkingInfo();
        if (thinking) emit({type:'agent_event',conversationId:summary.id,event:{kind:'thinking_level',...thinking}});
      });

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

      if(!runtime.session.keepsRunAfterDisconnect && (['running','interrupted'].includes(before.state)||this.pendingStarts.has(summary.id))){
        progress.interrupt('connection_lost');
        summary.state='idle';summary.checkpoint='interrupted';

        try{runtime.session.persistTaskResults?.(progress.snapshot());this.publishRunIdentity(summary.id);}
        catch{this.emit({type:'agent_event',conversationId:summary.id,event:{kind:'error',message:'中断时没有保存完整，任务已中止。请核对原记录，不要重复操作。'}});}
      }

      this.pendingStarts.delete(summary.id);this.checkpointResumes.delete(summary.id);
      runtime.rpc.rejectAll(new Error("Extension disconnected"));

      if (!runtime.session.keepsRunAfterDisconnect && !runtime.session.isHeld() && !runtime.control.isGroupHeld()) {
        runtime.session.abort();
        runtime.control.abortTeam();
      }
    }
  }
  dispose(): void { this.queueClosed=true;this.taskViewDisposed=true;this.taskViewQueued.clear();this.controls.disconnect();
    for (const observer of this.observers.values()) observer.dispose();

for (const { runtime } of this.entries.values()) runtime.dispose(); }
}
