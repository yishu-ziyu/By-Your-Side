import { randomUUID } from "node:crypto";
import {
  DEFAULT_CONVERSATION_ID, normalizeConversationId,
  type ClientMessage, type ConversationSummary, type ServerMessage,
} from "../../shared/protocol.js";
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
  private readonly voiceConfirmations=new Map<string,{voiceId:string;turn:number;expiresAt:number;text:string;input?:VoiceInputContext}>();
  voiceTargets(){return this.list().map(c=>({id:c.id,title:c.title,runId:this.getTaskProgress(c.id)?.runId??null}));}
  readonly controls:TaskControlBroker;
  constructor(
    private readonly factory: (id: string, emit: (message: ServerMessage) => void, summary?: ConversationSummary) => Promise<Runtime>,
    private readonly emit: (message: ServerMessage) => void,
    private readonly store?: ConversationStore,
    private readonly memoryStore?: MemoryStore,
    readonly dispatcher = new TaskDispatcher(),
  ) {this.controls=new TaskControlBroker(emit);}

  async ensureDefault(): Promise<ConversationEntry> {
    for (const summary of this.store?.load() ?? []) await this.create(summary.id, summary.title, summary);
    return this.create(DEFAULT_CONVERSATION_ID, "新会话");
  }
  get(id: string): ConversationEntry | undefined { return this.entries.get(id); }
  getTaskProgress(id: string): TaskProgressSnapshot | null { return this.progress.get(id)?.snapshot() ?? null; }
  async routeVoiceInput(id: string, text: string, startedAt: number | null, stillCurrent: () => boolean, route?: VoiceRouteContext):Promise<VoiceRouteResult> {
    const session = this.entries.get(id)?.runtime.session;
    if (!session || !text.trim() || text.length > 2000) throw new Error("这句话没有听清或过长，请重新说。");
    const before=this.getTaskProgress(id)!;
    const catalog=route?.targets??this.voiceTargets();
    const pending=this.voiceConfirmations.get(id);
    this.voiceConfirmations.delete(id);
    const short=text.replace(/[\p{P}\p{Z}\s]/gu,'');
    if(pending&&route&&pending.voiceId===route.voiceId&&route.turn===pending.turn+1&&Date.now()<pending.expiresAt){
      if(/^(好|好的|可以|是的|确认|同意|另开|开吧|好另开会话|另开会话|确认另开会话)$/.test(short)){
        if(!stillCurrent())throw new Error('语音已结束或你正在说新指令，本句未发送。');
        const entry=await this.create(randomUUID(),pending.text.slice(0,36));
        this.emit({type:'conversation_updated',conversationId:entry.summary.id,conversation:{...entry.summary}});
        const receipt=await this.dispatchTaskAction({requestId:route.requestId,conversationId:entry.summary.id,originConversationId:id,source:'voice',action:'start',expectedRunId:null,text:pending.text,...pending.input},stillCurrent);
        return {kind:'action',ok:receipt.status==='accepted',status:receipt.status,message:receipt.message,receipts:[receipt]};
      }
      if(/^(不|不要|不用|算了|取消|不另开|不要另开会话)$/.test(short))return {kind:'clarify',message:'没有另开会话，原任务保持原状。'};
    }
    const plan=await session.classifyVoiceInput(text,before.state,catalog.map(c=>c.title));
    if (!stillCurrent()) throw new Error("语音已结束或你正在说新指令，本句未发送。");
    const receipts:TaskReceipt[]=[];
    const expected=new Map(catalog.map(c=>[c.id,c.runId]));
    expected.set(id,route?route.runId:before.runId??null);
    const requestId=route?.requestId??randomUUID();
    const only=plan.steps.length===1?plan.steps[0]:undefined;
    if(only?.action==='observe'){
      if(only.target!==null)return {kind:'clarify',message:'这次页面问答只查看你当前选中的浏览器页面，请先切到要看的页面。'};
      const page=route?.input?.context;
      if(!page)return {kind:'none',spokenText:'还没有取得当前浏览器页面，请先打开要看的标签页。'};
      try{
        const rpc=this.entries.get(id)!.runtime.rpc;
        if(!stillCurrent())throw new Error('本次观察已取消。');
        const snapshot=await rpc.call('snapshot',{tabId:page.tabId},15000) as {text:string};
        if(!stillCurrent())throw new Error('本次观察已取消。');
        const screenshot=await rpc.call('screenshot',{tabId:page.tabId},15000) as {imageBase64:string};
        if(!snapshot?.text||!screenshot?.imageBase64)throw new Error('页面或截图读取失败。');
        const answer=await session.answerVoiceObservation(text,{...page,text:snapshot.text,imageBase64:screenshot.imageBase64},stillCurrent);
        if(!stillCurrent())throw new Error('本次观察已取消。');
        this.emit({type:'agent_event',conversationId:id,event:{kind:'notice',message:`已查看当前页面：${page.title}\n${answer}`}});
        return {kind:'none',spokenText:answer};
      }catch{return {kind:'none',spokenText:'这次没有完成当前页面的读取，请稍后再试。'};}
    }
    if(only?.action==='chat')return {kind:'none'};
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
    for(const [index,step] of plan.steps.entries()) {
      if(step.action==='observe')return {kind:'clarify',message:'请先单独说出要查看的页面问题。'};
      if(step.action==='chat')return {kind:'none'};
      if(step.action==='silence')return {kind:'silent'};
      if(step.action==='clarify')return {kind:'clarify',message:/^(停止|停|停下)[。！!？?\s]*$/.test(step.text.trim())?'你是想停止播报，还是暂停任务？':'请说出目标会话的名称。'};
      const targetId=targetIds[index]!;
      const sharesInput=targetId===id||/(当前页面|当前页|所选资料|所选图片|所选内容|所选文字|选中的)/.test(step.text);
      const receipt=await this.dispatchTaskAction({requestId:plan.steps.length===1?requestId:`${requestId}-${index}`,conversationId:targetId,...(targetId!==id?{originConversationId:id}:{}),source:'voice',action:step.action,expectedRunId:expected.get(targetId)??null,text:step.text,...((step.action==='start'||step.action==='steer')&&sharesInput?route?.input:{})},stillCurrent);
      receipts.push(receipt);
      if(receipt.status!=='accepted'&&receipt.status!=='applied') {
        if(step.action==='start'&&receipt.message.includes('另开会话')&&route&&plan.steps.length===1){
          this.voiceConfirmations.set(id,{voiceId:route.voiceId,turn:route.turn,expiresAt:Date.now()+90000,text:step.text,...(sharesInput?{input:route.input}:{})});
          return {kind:'clarify',message:'当前任务还在执行。要另开会话处理这个新任务吗？'};
        }
        return {kind:step.action==='steer'?'steer':'action',ok:false,status:receipt.status,message:receipt.message,receipts};
      }
      expected.set(targetId,receipt.runId);
    }
    const last=receipts.at(-1);
    if(!last)return {kind:'none'};
    if(receipts.length===1&&last.action==='status')return {kind:'none',snapshot:this.getTaskProgress(last.conversationId)!,spokenText:(last.originConversationId?'指定会话：':'')+last.message};
    return {kind:receipts.length===1&&last.action==='steer'?'steer':'action',ok:true,status:last.status,message:receipts.map(r=>r.message).join('；'),receipts};
  }

  async steerFromVoice(id: string, text: string, expectedStartedAt: number | null, route?: VoiceRouteContext, stillCurrent = () => true): Promise<TaskReceipt> {
    const entry = this.entries.get(id);
    const snapshot = this.getTaskProgress(id);
    if (!entry || !snapshot || snapshot.state !== "running" || expectedStartedAt === null || snapshot.startedAt !== expectedStartedAt) {
      throw new Error("原任务已停止或发生变化，修改未发送。");
    }
    if (!text.trim() || text.length > 2000) throw new Error("这段修改没有听清或过长，请简短重说。");
    const receipt = await this.dispatchTaskAction({requestId:route?.requestId ?? randomUUID(),conversationId:id,source:'voice',action:'steer',expectedRunId:route ? route.runId : snapshot.runId ?? null,text},stillCurrent);
    if (receipt.status !== 'accepted') throw new TaskReceiptError(receipt);
    return receipt;
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
      if (request.action === 'status')return {status:'applied',runId:snapshot.runId??null,message:progressSpeech(snapshot)};
      if (request.action === 'start') {
        if(snapshot.state==='running'||entry.runtime.session.isStreaming())throw new TaskActionRejected('当前任务还在执行。要另开会话处理这个新任务吗？');
        if(snapshot.state==='paused'||entry.runtime.session.isHeld())throw new TaskActionRejected('页面现在归你。请继续原任务，或另开会话。');
        if(!entry.runtime.session.available)throw new TaskActionRejected('当前执行模型不可用，任务未启动。');
        entry.runtime.fleet.reset();
        this.progress.get(request.conversationId)!.request(request.text??'');
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
        entry.runtime.session.queueSteerForResume(request.text??'',request.context,request.attachments);
        return {status:'accepted',runId:snapshot.runId??null,message:`修改已保存，继续后生效：${request.text??'所选资料'}`};
      }
      if (!request.expectedRunId || snapshot.runId !== request.expectedRunId || snapshot.state !== 'running' || !entry.runtime.session.isStreaming()) {
        throw new TaskActionRejected('原任务已停止或发生变化，修改未发送。');
      }
      if (entry.runtime.session.isHeld()) throw new TaskActionRejected('页面现在归你，请先交还。');
      await entry.runtime.session.steerCurrentTask(request.text!,request.context,request.attachments);
      return {status:'accepted',runId:snapshot.runId,message:`${request.source==='voice'?'语音修改':'修改'}已送达当前任务：${request.text}`};
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
      progress.observe(message);
      summary.runId = progress.snapshot().runId;
      const live=this.entries.get(id)?.runtime;
      const carriesIdentity=['tool_call','control_result','team_status','status'].includes(message.type)||(message.type==='agent_event'&&message.event.kind==='agent_start');
      const scoped:ServerMessage = { ...message, conversationId: id, ...(live&&carriesIdentity?{epochs:this.epochs(live)}:{}) };
      if(carriesIdentity&&scoped.type!=='task_control')scoped.runId=progress.snapshot().runId;
      this.emit(scoped);
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
      else this.emit({type:'agent_event',conversationId:id,event:{kind:'notice',message:'未找到这条请求的回执，请不要自动重发。'}});
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
