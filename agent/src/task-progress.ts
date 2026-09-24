import { goalsSatisfied } from '../../shared/task-goals.js';
import { TaskGoalBook } from './task-goals.js';
import type { ServerMessage, PageContext, Attachment } from "../../shared/protocol.js";
import type { TaskProgressSnapshot, UserDelivery, UserDeliveryRemainingItem, UserDeliverySourceRef, VoiceConversationContext } from "../../shared/voice.js";
import { USER_DELIVERY_FACT_DESCRIPTION_MAX, USER_DELIVERY_FACT_ITEM_MAX, USER_DELIVERY_SOURCE_MAX } from "../../shared/voice.js";
import { deriveResultDescription, extractResultTarget, isPageIdentityTool, isSupersededUnknown, resultToolHasWriteEffect, RESULT_VERIFY_READ_TOOLS, type TaskResultRegistration } from "../../shared/task-results.js";
import { UserDeliveryLedger } from "./user-delivery-ledger.js";
import { TaskResultBook } from "./task-results.js";
import { sanitizeTrace } from "../../shared/trace-sanitize.js";
import { createHash, randomUUID } from "node:crypto";
import {isWriteTool} from '../../shared/control.js';
import {classifyToolEffect} from '../../shared/effect-policy.js';
import {isResultMetaTool} from '../../shared/task-results.js';
import {decideTaskNextStep} from '../../shared/task-next-step.js';
import {TaskReadback} from './task-readback.js';
import {RECOVERY_INPUT_MAX,type TaskRecoveryInput} from '../../shared/task-recovery.js';
import {pageRecoveryKey,attachmentRecoveryKey,mergeTaskMaterials} from './task-recovery.js';
import type { DeliveryFactInput } from './user-delivery.js';

const labels: Record<string, string> = { judge_browser_action: "判断页面操作", capture_page_material: "保存页面原文", task_goals: "核对用户目标", record_task_results: "整理剩余步骤", snapshot: "读取页面", screenshot: "查看页面截图", read_element: "读取页面内容", browser_run: "执行网页步骤", click: "点击页面", fill: "填写表单", type_text: "输入文字", navigate: "打开页面", open_tab: "打开标签页", list_tabs: "查看标签页", get_active_tab: "确认当前页面", scroll: "滚动页面", mark: "标注页面", spawn: "分配协作任务", wait: "等待协作者", js: "检查页面" };

const label = (name: string) => labels[name] ?? name.slice(0, 100);

/** Runtime receipts drive progress; bounded target bindings are retained, page contents are excluded. */
export class TaskProgress {
  private goal: string | null = null;
  private startedAt: number | null = null;
  private runId: string | null = null;
  private aborted = false;
  /** A restored active run is a checkpoint, never a still-running task. */
  private interrupted = false;
  /** Persists through the resumed original run so pre-restart writes cannot be replayed. */
  private restartRecovery = false;
  private interruptionReason:TaskProgressSnapshot['interruptionReason'];
  private lifecycleFrozen=false;
  private recoveryInput:TaskRecoveryInput|undefined;
  private unresolvedEffect=false;
  private executionAuditComplete=false;
  private lastAction: TaskProgressSnapshot["lastAction"] = null;
  private lastReadAt: number | null = null;
  /** Lead-only conversation evidence: bounded turns, the current turn's streamed text, the run's final report. */
  private readonly turns: VoiceConversationContext["recentTurns"] = [];
  private readonly voicedRequests = new Set<string>();
  private turnText = "";
  private latestResult: NonNullable<VoiceConversationContext["latestResult"]> | null = null;
  private readonly ledger: UserDeliveryLedger;
  private readonly members = new Map<string, "running" | "paused" | "idle" | "error">();
  private readonly tools = new Map<string, { member: string; name: string; action: string; since: number; target: string | null; tabId:number|null; readVersion:number; write:boolean; durableEffect:boolean; tabAction?:string; valueHash?:string }>();
  private readonly readback=new TaskReadback();
  private readonly completedReads=new Map<string,{name:string;readVersion:number}>();
  private failureLimit=false;
  private lastBrowserFailed=false;
  private readonly results: TaskResultBook;
  readonly goals = new TaskGoalBook();
  /** T06：本 run 真实打开或读到的页面（去重、有界）。只在内存；恢复后不猜测补齐，交付时按实际有的说。 */
  private runSources: UserDeliverySourceRef[] = [];
  private readonly pendingNavUrls = new Map<string, string>();
  constructor(private readonly conversationId: string, private readonly clock = Date.now) {
    this.ledger = new UserDeliveryLedger(conversationId);
    this.results = new TaskResultBook(clock);
  }

  registerResults(intents: readonly TaskResultRegistration[]): void { this.results.register(intents); }
  reviseResults(): void { this.results.revise();this.failureLimit=false; }
  stopAfterFailures():void { this.failureLimit=true; }
  /** 交付事实链：已满足项、仍未完成项、本 run 真实读到的页面。未完成项名称不升级状态、不删证据。 */
  deliveryFacts(): DeliveryFactInput {
    // 描述超界时加省略号：事实链可以被界面折叠展示，但不能静默截断得看不出来。
    const shorten = (description: string): string => description.length > USER_DELIVERY_FACT_DESCRIPTION_MAX
      ? `${description.slice(0, USER_DELIVERY_FACT_DESCRIPTION_MAX - 1)}…`
      : description;

    const executionItems = this.results.list();
    const plan = this.goals.snapshot();
    // Unknown effects remain visible even when they are not user outcomes.
    const items = plan ? [...plan.goals, ...executionItems.filter(item => item.status === 'unknown' && !isSupersededUnknown(item, executionItems))] : executionItems;
    const allDelivered = items.filter((item) => item.status === "satisfied").map((item) => shorten(item.description));
    const delivered: string[] = [];

    for (const description of allDelivered) {
      if (!delivered.includes(description)) delivered.push(description);

      if (delivered.length >= USER_DELIVERY_FACT_ITEM_MAX) break;
    }

    const allRemaining = items.filter((item) => ["pending", "blocked", "unknown"].includes(item.status) && !('tool' in item && isSupersededUnknown(item, executionItems)));
    const remaining: UserDeliveryRemainingItem[] = [];

    for (const item of allRemaining) {
      remaining.push({ id: item.id, description: shorten(item.description), status: item.status as UserDeliveryRemainingItem["status"] });

      if (remaining.length >= USER_DELIVERY_FACT_ITEM_MAX) break;
    }

    const omittedDelivered = allDelivered.length - delivered.length;
    const omittedRemaining = allRemaining.length - remaining.length;
    const pendingAnswers=plan?.goals.filter(g=>g.kind==='answer'&&g.status==='pending').map(g=>({id:g.id,description:shorten(g.description)}));

    const facts: DeliveryFactInput = { delivered, remaining, sources: this.runSources.map((source) => ({ ...source })) };

    if (pendingAnswers?.length) facts.pendingAnswers = pendingAnswers;

    if (omittedDelivered) facts.omittedDelivered = omittedDelivered;

    if (omittedRemaining) facts.omittedRemaining = omittedRemaining;

    return facts;
  }
  private noteRunSource(url: string): void {
    if (!/^https?:\/\//.test(url) || this.runSources.some((source) => source.url === url) || this.runSources.length >= USER_DELIVERY_SOURCE_MAX) return;
    this.runSources.push({ url });
  }
  /** Stop the live run without discarding obligations or guessing external effects. */
  interrupt(reason:NonNullable<TaskProgressSnapshot['interruptionReason']>):boolean {
    if(!this.runId||!this.goal||this.aborted)return false;
    const snapshot=this.snapshot();
    this.restoreResults({...snapshot,state:'running',interruptionReason:reason});
    this.lifecycleFrozen=true;

    return true;
  }
  prepareResume():void {
    this.lifecycleFrozen=false;this.failureLimit=false;

    // Upgrade only on explicit continuation, using complete task inputs, not a historical summary.
    if(!this.goals.snapshot()&&this.recoveryInput?.requirements.length)this.goals.require(this.recoveryInput.requirements);
  }
  /** Conversational turns are not new task requirements. Call only for actual task input. */
  recordRequirement(text:string,context?:PageContext,attachments?:Attachment[]):()=>void {
    const prior=this.recoveryInput??{requirements:this.goal?[this.goal]:[],attachmentKeys:[]};
    const clean=String(sanitizeTrace(text)).trim();
    const requirements=clean&&prior.requirements.at(-1)!==clean?[...prior.requirements,clean]:[...prior.requirements];
    const attachmentKeys=[...new Set([...prior.attachmentKeys,...(attachments??[]).map(attachmentRecoveryKey)])];

    if(requirements.length>64||requirements.some(t=>t.length>12000)||requirements.reduce((n,t)=>n+t.length,0)>RECOVERY_INPUT_MAX||attachmentKeys.length>16)throw new Error('原任务补充内容已达到保留上限，这条修改未接收；请先交付已有结果或另开任务。');
    const page=context?pageRecoveryKey(context.tabId,context.url):prior.page;
    const materials=mergeTaskMaterials(prior.materials??[],context,attachments);
    const recorded:TaskRecoveryInput={requirements,attachmentKeys,materials};

    if(page)recorded.page=page;
    const runId=this.runId;
    const priorGoals = this.goals.snapshot();
    this.recoveryInput=recorded;
    this.goals.require(requirements);

    // Only the caller that just registered this input can revoke it before acceptance.
    // Preserve a fresh page observation, and never roll back a later requirement or another run.
    return ()=>{
      if(this.runId!==runId||this.recoveryInput!==recorded)return;
      this.recoveryInput={...recorded,requirements:prior.requirements,attachmentKeys:prior.attachmentKeys,materials:prior.materials};
      this.goals.restore(priorGoals, false);
    };
  }
  invalidatePage(tabId?:number,url?:string):void {
    this.goals.invalidatePage(tabId ?? null);
    this.readback.restore(this.snapshot());this.results.notePageChange();this.completedReads.clear();this.lastReadAt=null;
    const page=tabId!==undefined&&url?pageRecoveryKey(tabId,url):undefined;

    if(page&&this.recoveryInput)this.recoveryInput.page=page;
  }
  restoreResults(snapshot: TaskProgressSnapshot): void {
    if (snapshot.conversationId !== this.conversationId) return;
    this.goal = snapshot.goal;
    this.startedAt = snapshot.startedAt;
    this.runId = snapshot.runId ?? null;
    this.aborted = snapshot.state === "aborted";
    this.interrupted = !!this.runId && !!this.goal && ["none", "running", "paused", "interrupted"].includes(snapshot.state);
    this.restartRecovery = snapshot.restartRecovery === true || this.interrupted;
    this.interruptionReason=this.interrupted?(snapshot.interruptionReason??'host_restart'):undefined;
    this.lifecycleFrozen=false;
    this.recoveryInput=snapshot.recoveryInput?structuredClone(snapshot.recoveryInput):undefined;
    this.unresolvedEffect=snapshot.unresolvedEffect===true||snapshot.untrackedWritePending===true;
    this.executionAuditComplete=snapshot.executionAuditComplete===true&&!snapshot.untrackedWritePending;
    this.members.clear();
    this.tools.clear();
    this.lastAction = snapshot.lastAction ? { ...snapshot.lastAction } : null;
    this.turnText = "";
    // A pre-restart read does not prove the state of the page after reconnecting.
    this.lastReadAt = this.restartRecovery ? null : snapshot.lastReadAt ?? null;
    this.results.restore(snapshot);
    this.goals.restore(snapshot.goalPlan,this.interrupted);

    if(snapshot.state==='idle'&&snapshot.goalPlan&&goalsSatisfied(snapshot.goalPlan)&&snapshot.nextStep?.delivery==='report')this.readback.reset();
    else this.readback.restore(snapshot);
    this.completedReads.clear();
    this.failureLimit=snapshot.nextStep?.reason==='failure_limit';
    this.lastBrowserFailed=snapshot.nextStep?.reason==='tool_failed';
    this.turns.length = 0;

    for (const turn of snapshot.conversationContext?.recentTurns ?? []) this.pushTurn(turn.role, turn.text);
    this.latestResult = snapshot.conversationContext?.latestResult?.runId === this.runId ? { ...snapshot.conversationContext.latestResult } : null;
    this.ledger.beginRun(this.runId);
    const delivery = snapshot.conversationContext?.latestDelivery;

    if (delivery) this.ledger.record(delivery);
  }

  private pushTurn(role: "user" | "assistant", text: string): void {
    const clean = String(sanitizeTrace(text)).trim();

    if (!clean) return;
    const last = this.turns.at(-1);

    if (last && last.role === role && last.text === clean.slice(0, 2000)) return;
    this.turns.push({ role, text: clean.slice(0, 2000) });

    if (this.turns.length > 12) this.turns.splice(0, this.turns.length - 12);
  }

  /** 记录被处理过的语音原话（含 chat/steer），按请求编号去重；仅作后续分类的数据，不产生新授权。 */
  recordUserTurn(text: string, requestId?: string): void {
    if (requestId) {
      if (this.voicedRequests.has(requestId)) return;

      if (this.voicedRequests.size >= 50) this.voicedRequests.delete(this.voicedRequests.values().next().value!);
      this.voicedRequests.add(requestId);
    }

    this.pushTurn("user", text);
  }

  request(text: string,context?:PageContext,attachments?:Attachment[]): void {
    this.pushTurn("user", text);
    const state = this.snapshot().state;

    if (state === "running" || state === "paused") {this.recordRequirement(text,context,attachments);

return;}

    this.goal = String(sanitizeTrace(text.slice(0, 600)));
    this.startedAt = null;
    this.runId = randomUUID();
    this.aborted = false;
    this.interrupted = false;
    this.restartRecovery = false;
    this.interruptionReason=undefined;
    this.lifecycleFrozen=false;
    this.recoveryInput={requirements:[],attachmentKeys:[]};
    this.goals.clear();
    this.unresolvedEffect=false;
    this.executionAuditComplete=true;
    this.recordRequirement(text,context,attachments);
    this.members.clear();
    this.tools.clear();
    this.lastAction = null;
    this.lastReadAt = null;
    this.turnText = "";
    this.latestResult = null;
    this.results.clear();
    this.readback.reset();
    this.completedReads.clear();
    this.failureLimit=false;
    this.lastBrowserFailed=false;
    this.runSources = [];
    this.ledger.beginRun(this.runId);
  }
  abort(): void { this.aborted = true; this.interrupted = false; this.restartRecovery = false;

 for (const member of new Set([...this.tools.values()].map(t=>t.member))) this.results.abandonMember(member); this.tools.clear(); this.members.clear(); this.turnText = ""; }
  hasFinding(): boolean { return this.ledger.hasFinding(); }
  markPlayback(id: string, status: "speaking" | "played"): UserDelivery | null { return this.ledger.markPlayback(id, status); }
  observe(message: ServerMessage): void {
    const member = "sessionId" in message ? message.sessionId ?? "main" : "main";
    // 显式旧 run 的状态/工具/结束事件不属于当前 run，不得改写当前进度。
    const staleRun = "runId" in message && typeof message.runId === "string" && this.runId !== null && message.runId !== this.runId;

    if (staleRun) return;

    if(this.lifecycleFrozen&&(message.type==='status'||message.type==='agent_event'&&message.event.kind!=='tool_late_result'))return;
    const lead = member === "main";

    const end = (state: "idle" | "paused" | "error") => {
      this.members.set(member, state);
      this.results.abandonMember(member);

      for (const [id, tool] of this.tools) if (tool.member === member) this.tools.delete(id);
    };

    if (message.type === "status") {
      if (message.state === "running") {
        // Direct tools have no Pi agent_start/agent_end lifecycle.
        if (this.runId) this.startedAt ??= this.clock();

        if(this.interrupted&&lead){this.ledger.beginRun(this.runId);this.latestResult=null;}

        this.interrupted = false; this.members.set(member, "running");
      }
      else if (message.state === "user") end("paused");
      else if (this.members.get(member) !== "error") end("idle");
    }

    if (message.type !== "agent_event") return;
    const e = message.event;

    if (e.kind === "agent_start") {
      if(this.interrupted&&lead){this.ledger.beginRun(this.runId);this.failureLimit=false;}

      this.interrupted = false;
      this.startedAt ??= this.clock();
      this.runId ??= randomUUID();
      this.members.set(member, "running");

      // A (re)start means any earlier capture of this run was not final.
      if (lead) {
        this.turnText = "";
        this.latestResult = null;
      }
    } else if (e.kind === "user_delivery") {
      if (lead && this.ledger.record(e.delivery)) {
        this.pushTurn("assistant", e.delivery.text);

        if(!this.aborted&&e.delivery.runId===this.runId&&e.delivery.kind==='finding'&&e.delivery.facts?.outcome==='complete')this.goals.recordAnswerDelivery(e.delivery.id,e.delivery.composedAt);
      }
    } else if (e.kind === "agent_end") {
      if (this.members.get(member) !== "paused" && this.members.get(member) !== "error") end("idle");

      if (lead) {
        const text = this.turnText.trim();

        if (!this.aborted && this.startedAt !== null && this.members.get("main") === "idle" && text && this.runId) {
          this.latestResult = { runId: this.runId, text: text.slice(0, 6000), observedAt: this.clock(), source: "assistant_output" };
        }

        this.turnText = "";
      }
    } else if (e.kind === "error") {
      // A resume request that fails before a new agent run starts leaves the durable
      // checkpoint intact so the user can retry; once agent_start arrived, errors are real run errors.
      if (this.interrupted) { this.turnText = "";

 if (lead) this.latestResult = null;

 return; }

      end("error");

      // 生产中最终错误可在 agent_end 之后报告；同 runId 的已采结果作废。
      if (lead) { this.turnText = "";

 if (this.latestResult?.runId === this.runId) this.latestResult = null; }
    } else if (e.kind === "turn_start") {
      if (lead) this.turnText = "";
    } else if (e.kind === "text_delta") {
      if (lead && this.turnText.length < 20000) this.turnText += e.delta;
    } else if (e.kind === "tool_start") {
      const target = extractResultTarget(e.params, e.name);

      // T06：导航意图先暂存，成功 tool_end 才记为来源；正文里的链接不算。
      if ((e.name === "navigate" || e.name === "open_tab") && typeof e.params?.url === "string") this.pendingNavUrls.set(`${member}:${e.toolCallId}`, e.params.url);
      let tabAction: string | undefined;

      if (e.name === 'tabs') {
        tabAction = String(e.params.action);
      } else if (e.name === 'open_tab') {
        tabAction = 'open';
      } else if (e.name === 'close_tab') {
        tabAction = 'close';
      } else if (e.name === 'switch_tab') {
        tabAction = 'switch';
      }

      const browserControl=e.name==='tabs'&&['open','switch','close'].includes(tabAction??'');
      const write=isWriteTool(e.name)||(e.name==='fetch'&&classifyToolEffect(e.name,e.params).class==='write')||browserControl;
      // A tabs/switch call changes which page is controlled, not remote/page
      // business state. An uncertain switch must be re-observed, but it must not
      // permanently lock unrelated form writes like an uncertain fill/click does.
      const durableEffect=resultToolHasWriteEffect(e.name)||(browserControl&&tabAction!=='switch')||(e.name==='fetch'&&classifyToolEffect(e.name,e.params).class==='write');
      // The host hashes private skill inputs before redacting public tool parameters.
      let valueHash: string | undefined;

      if (e.name === 'fill') {
        if (typeof e.valueHash === 'string' && /^[a-f0-9]{64}$/.test(e.valueHash)) {
          valueHash = e.valueHash;
        } else if (typeof e.params.value === 'string') {
          valueHash = createHash('sha256').update(e.params.value).digest('hex');
        }
      }

      if(!this.aborted&&this.tools.size>=100&&(durableEffect||e.name==='fetch'))this.executionAuditComplete=false;

      if(!this.aborted&&write)this.readback.beginWrite();

      if (!this.aborted && this.tools.size < 100) {
        const entry: Parameters<typeof this.tools.set>[1] = { member, name: e.name, action: label(e.name), since: this.clock(), target,
        tabId:this.readback.pageFor(member,typeof e.params.tabId==='number'?e.params.tabId:undefined),readVersion:this.readback.version(),write,durableEffect,tabAction };

        if (valueHash) entry.valueHash = valueHash;
        this.tools.set(`${member}:${e.toolCallId}`, entry);
      }

      if (!this.aborted) {
        this.results.noteStart({ toolCallId: e.toolCallId, name: e.name, target, member, runId: this.runId, description: deriveResultDescription(e.name, e.params, target),effectful:durableEffect,recordResult:browserControl,valueHash });

        // 页面/文档可能改变：旧读数不能再当作后续写入的前后对比基线。
        if (isPageIdentityTool(e.name)) this.results.notePageChange();
      }
    } else if (e.kind === "tool_observation") {
      if (!this.aborted && this.runId) {
        // T06：只记真实读到的页面地址；模型正文里的链接不算来源。
        if (typeof e.url === "string") this.noteRunSource(e.url);

        if((RESULT_VERIFY_READ_TOOLS as readonly string[]).includes(e.name))this.results.noteObservation({ toolCallId: e.toolCallId, tool: e.name, target: e.target, tabId: e.tabId, workingTab: e.workingTab, text: e.text, truncated: e.truncated, member, runId: this.runId });
        const key=`${member}:${e.toolCallId}`,read=this.completedReads.get(key);

        if(read?.name===e.name){
          if(lead&&e.workingTab&&typeof e.url==='string'&&e.tabId!==null&&this.recoveryInput){
            const page=pageRecoveryKey(e.tabId,e.url);

if(page)this.recoveryInput.page=page;
          }

          if(e.tabIds&&!e.truncated)this.readback.observedTabs(member,e.tabIds,read.readVersion);
          else this.readback.observed(member,e,read.readVersion);
          this.completedReads.delete(key);
        }
      }
    } else if (e.kind === "tool_end") {
      const key = `${member}:${e.toolCallId}`;
      const started = this.tools.get(key);

      if (!started || started.name !== e.name) return;
      this.tools.delete(key);
      const pendingNav = this.pendingNavUrls.get(key);

      if (pendingNav) {
        this.pendingNavUrls.delete(key);

        if (!e.isError && e.executionFact === "executed") this.noteRunSource(pendingNav);
      }

      if (!this.aborted) {
        this.lastAction = { action: started.action, failed: e.isError, at: this.clock() };

        if(!isResultMetaTool(e.name))this.lastBrowserFailed=e.isError;

        if (started.durableEffect && e.executionFact !== 'not_executed') this.goals.invalidatePage(started.tabId);

        if(started.write&&e.executionFact!=='not_executed'){
          if(started.tabAction==='close')this.readback.closedTab(member,started.tabId);
          else {
            if(started.tabAction==='open')this.readback.forgetPage(member);
            this.readback.written(member,started.tabAction==='open'?null:started.tabId);
          }
        }

        if(!e.isError&&((RESULT_VERIFY_READ_TOOLS as readonly string[]).includes(e.name)||e.name==='list_tabs'||started.tabAction==='list')&&e.executionFact!=='not_executed'){
          if(this.completedReads.size>=100)this.completedReads.delete(this.completedReads.keys().next().value!);
          this.completedReads.set(key,{name:e.name,readVersion:started.readVersion});
        }

        if (!e.isError && (RESULT_VERIFY_READ_TOOLS as readonly string[]).includes(e.name)) this.lastReadAt = this.lastAction.at;
        // 执行事实只来自执行器/RPC 的结构化回传；不从错误文案猜测副作用状态。
        this.results.noteEnd({ toolCallId: e.toolCallId, name: e.name, target: started.target, member, runId: this.runId, failed: e.isError, executionFact: e.executionFact,
          effectful:started.durableEffect||(e.name==='fetch'&&e.isError&&e.executionFact!=='not_executed'),valueHash:started.valueHash });

        if((started.durableEffect||e.name==='fetch')&&e.executionFact!=='not_executed'&&!this.results.list().some(item=>item.evidence?.toolCallId===e.toolCallId&&item.evidence.member===member))this.executionAuditComplete=false;

        if(started.durableEffect&&e.isError&&e.executionFact!=='not_executed'&&!this.results.list().some(item=>item.evidence?.toolCallId===e.toolCallId&&item.evidence.member===member))this.unresolvedEffect=true;
      }
    } else if (e.kind === "tool_late_result") {
      // 晚到/重复回执只按原 SDK 调用身份关联当前 run 的未决结果。
      if (!this.aborted) this.results.resolveLateResult({ toolCallId: e.toolCallId, runId: this.runId ?? "", ok: e.ok, executionFact:e.executionFact });
    }
  }
  handleLateResult(toolCallId: string, ok: boolean, data?: unknown): boolean {
    return this.results.resolveLateResult({ toolCallId, runId: this.runId ?? "", ok, data });
  }
  verifyUnknownResult(input: { id: string; expect: string; observation: { toolCallId: string; tool: string; text: string; at: number; target: string | null; tabId: number | null } }): { ok: boolean; reason?: string } {
    const member=this.results.list().find(item=>item.id===input.id)?.evidence?.member;
    const outcome=this.results.resolveVerifiedResult({ id: input.id, runId: this.runId ?? "", observation: input.observation, expect: input.expect });

    if(outcome.ok&&member&&input.observation.tabId!==null)this.readback.verified(member,input.observation.tabId);

    return outcome;
  }
  /** 用户确认后的受支持恢复：旧未知保留，新建（或复用）一条独立结果项并标记取代。 */
  recordConfirmedRecovery(input: import('./task-results.js').ConfirmedRecoveryRecord) { return this.results.recordConfirmedRecovery(input); }
  snapshot(): TaskProgressSnapshot {
    const phases = [...this.members.values()];
    let state: TaskProgressSnapshot['state'];

    if (this.aborted) {
      state = "aborted";
    } else if (phases.includes("running")) {
      state = "running";
    } else if (phases.includes("paused")) {
      state = "paused";
    } else if (phases.includes("error")) {
      state = "error";
    } else if (this.interrupted) {
      state = "interrupted";
    } else if (this.startedAt !== null) {
      state = "idle";
    } else {
      state = "none";
    }

    const conversationContext: VoiceConversationContext = {
      recentTurns: this.turns.map(t => ({ ...t })),
      latestResult: this.latestResult && this.latestResult.runId === this.runId ? { ...this.latestResult } : null,
      latestDelivery: this.ledger.latest(),
    };

    const snapshot:TaskProgressSnapshot = { goalPlan: this.goals.snapshot(), conversationId: this.conversationId, observedAt: this.clock(), state, goal: this.goal, startedAt: this.startedAt, runId: this.runId,
      active: [...this.tools.values()].slice(-12).map(({ member, action, since }) => ({ member, action, since })), lastAction: this.lastAction ? { ...this.lastAction } : null, lastReadAt: this.lastReadAt ?? undefined, successVerified: false, conversationContext,
      results: this.results.list(), executionState: this.results.state(), resultState: this.results.state() };

    if (this.restartRecovery) snapshot.restartRecovery = true;

    if (this.interrupted) snapshot.interruptionReason = this.interruptionReason;

    if (this.recoveryInput) snapshot.recoveryInput = structuredClone(this.recoveryInput);

    if (snapshot.goalPlan) {
      snapshot.resultState = snapshot.results?.some(item => item.status === 'unknown' && !isSupersededUnknown(item, snapshot.results!)) ? 'unknown' : goalsSatisfied(snapshot.goalPlan) ? 'satisfied' : 'pending';
    }

    snapshot.executionAuditComplete=this.executionAuditComplete;

    if(this.unresolvedEffect)snapshot.unresolvedEffect=true;

    if([...this.tools].some(([key,tool])=>tool.durableEffect&&!snapshot.results!.some(item=>`${item.evidence?.member}:${item.evidence?.toolCallId}`===key)))snapshot.untrackedWritePending=true;
    snapshot.nextStep=decideTaskNextStep(snapshot,{inFlight:[...this.tools.values()].some(tool=>!isResultMetaTool(tool.name)),
      readbackRequired:this.readback.needsReadback(),verifiableUnknownIds:this.results.verifiableUnknownIds(),failureLimit:this.failureLimit,toolFailed:this.lastBrowserFailed});

    return snapshot;
  }
}
