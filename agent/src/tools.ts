import { runPageTranslation, type TranslateBatch } from "./page-translation.js";
import {runBrowserDecisionLoop} from './browser-decision-loop.js';
import type {BrowserMaterial, BrowserControl} from '../../shared/browser-decision.js';
import type {BrowserMaterialResult} from './browser-material.js';
import {generalBrowserLoopEnabled} from './config.js';
import type { TranslationReceipt, TranslationRequest } from "../../shared/page-translation.js";
/**
 * 浏览器工具的 defineTool 封装。
 * 每个 execute 只做一件事：rpc.call 转发给扩展，再把结果转成模型友好的 content。
 * 工具名严格对齐 shared/protocol.ts 的 TOOL_NAMES / ToolContract。
 * 教学模式不裁剪工具能力（教学倾向由 prompt 层表达），全部工具始终可用。
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "./define-tool.js";
import { Type } from "typebox";
import { ELEMENT_PROPERTIES } from "../../shared/element-state.js";
import { formatEffectReport } from "../../shared/effect.js";
import { formatFetchReply, type FetchReply } from "./fetch-result.js";
import { fetchPages } from "./fetch-batch.js";
import { redactCredentialText, wrapPageContent } from "../../shared/untrusted.js";
import { isLeadSession, type TabInfo, type ToolContract, type ToolName } from "../../shared/protocol.js";
import { FOREIGN_TAB_ERROR, WRITE_TOOLS } from "../../shared/control.js";
import { needsConsentTicket, requiresControlGate } from "../../shared/effect-policy.js";
import { CONSENT_REQUIRED_ERROR } from "./consent-ticket.js";
import type { ConsentOutcome } from "./fetch-consent.js";
import type { ToolRpc } from "./rpc.js";
import { runBrowserProgram, BROWSER_PROGRAM_HELPERS, RPC_ALIASES, type ProgramStep } from "./browser-program.js";
import { authorizeUploadPaths, type TaskUploadLedger } from "./upload-paths.js";
import { createDownloadArmDir, hostDownloadDeleteTemp, hostDownloadSaveAs, type DownloadStatLike } from "./download-artifacts.js";
import type { SkillEvidence } from "./skill-learning.js";
import { POINT_SELECTION_TIMEOUT_MS } from "../../shared/point-selection.js";

const MAX_JS_RESULT_CHARS = 20_000;

/**
 * 视口坐标 [x, y]。不用 Type.Tuple：它生成的元组 schema（items 是数组）会让 MiMo V2.6 Flash 的网关
 * 把整条请求拒成 400「Invalid request parameters」，工具列表里只要有一个，所有浏览器任务都发不出去。
 */
function viewportPoint(options: { description?: string } = {}) {
  return Type.Unsafe<[number, number]>({ type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, ...options });
}

function textResult(text: string, details: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [truncated]` : text;
}

function formatTabs(tabs: TabInfo[]): string {
  if (tabs.length === 0) return "No open tabs.";

  return tabs
    .map((t) => {
      const marks = [t.active ? "active" : "", t.working ? "working" : ""].filter(Boolean).join(", ");

      return `[${t.id}] ${t.title || "(untitled)"} — ${t.url}${marks ? ` (${marks})` : ""}`;
    })
    .join("\n");
}

/**
 * 工作目标与可见结果分开表达：`Working tab is now N` 只是执行事实（工作目标已指向 N）；
 * 用户此刻是否看得到，只按执行后读回的核验事实说。未核验/核验不通过时明确说未确认或
 * 不在前台，不让模型把工作目标转述成「用户已经看到目标页」，也不声称页面已加载完成。
 */
function switchResultText(data: ToolContract["switch_tab"]["data"]): string {
  const base = `Working tab is now ${data.tabId}.`;
  const verification = data.verification;

  if (!verification) return `${base} Whether the user can see it was not verified.`;

  if (verification.verified === true && verification.activeTabId === data.tabId && verification.windowFocused === true) {
    return `${base} Read-back right after: it was the active tab of its focused window at that moment, so the user was on this page.`;
  }

  if (typeof verification.activeTabId === "number" && verification.activeTabId !== data.tabId) {
    return `${base} Read-back right after: it was NOT the active tab (the active tab is ${verification.activeTabId}); the user may still be on another page.`;
  }

  if (verification.activeTabId === data.tabId && verification.windowFocused !== true) {
    return `${base} Read-back right after: its window was not focused, so the user may not be looking at it.`;
  }

  return `${base} The current active tab could not be read back; visibility is unconfirmed.`;
}

/**
 * 合并工具：一个模型可见工具代理多个扩展 RPC 名。
 * 能力开关（canExecute / isToolActive）按模型可见名判定，执行事实与账本仍按 RPC 名。
 */
const MODEL_TOOL_OF: Record<string, string> = {
  list_tabs: "tabs",
  get_active_tab: "tabs",
  open_tab: "tabs",
  switch_tab: "tabs",
  close_tab: "tabs",
  clear_marks: "mark",
  // worker_tabs 是扩展侧 RPC 名；模型可见的入口是常驻的 take_tab。
  worker_tabs: "take_tab",
};

export const modelToolOf = (rpcName: string): string => MODEL_TOOL_OF[rpcName] ?? rpcName;

/**
 * 需要用户确认的工具（今天只有会改服务端状态的 fetch）走这个回调：
 * 未接线 = 没有侧栏入口，直接拒绝；接线了就在等用户选择前不发任何 RPC。
 */
export type ConsumeConsent = (
  name: string,
  params: Record<string, unknown>,
  opts: { signal?: AbortSignal },
) => ConsentOutcome | boolean | Promise<ConsentOutcome | boolean>;

function consentOutcome(result: ConsentOutcome | boolean): ConsentOutcome {
  return typeof result === "boolean" ? { allowed: result } : result;
}

/** 一次工具执行的身份：call 据此绑定轮次闸门、SDK 调用 ID 和停止信号。 */
interface ExecutionScope { epoch: number; toolCallId: string; signal?: AbortSignal }

export function createBrowserTools(rpc: ToolRpc, sessionId?: string, takeTab?: (tabId?: number) => Promise<unknown>, canExecute?: (name: ToolName) => boolean, execution?: { observedMaterials?:()=>BrowserMaterial[]; goal?:()=>string; userText?:()=>string; reserveDecision?:()=>void; getMaterial?:(goal:string,control:BrowserControl,signal:AbortSignal)=>Promise<BrowserMaterialResult>; epoch: () => number; canWrite: (toolCallId?: string) => boolean; /** 占着这页的旧会话已空闲时接手它；返回是否已接手。 */ releaseIdleTab?: (tabId?: number) => Promise<boolean>; assertCall?: (name: string, params: Record<string, unknown>, toolCallId?: string) => void; onStep?: (step: ProgramStep) => void; consumeConsent?: ConsumeConsent; isToolHiddenByMode?: (name: string) => boolean; learning?: { active(): boolean; observe(event: SkillEvidence): ToolContract["read_element"]["params"] | void }; /** 本任务上传文件授权账本；所有上传入口共用。 */ uploadLedger?: TaskUploadLedger }, translateBatch?: TranslateBatch): ToolDefinition[] {
  const sid = sessionId && !isLeadSession(sessionId) ? sessionId : undefined;

  // 通用 page JS 能绕过任何单个写工具的禁用，因此在写能力不完整时整体拒绝。
  // 依赖集合复用 WRITE_TOOLS（按模型可见名去重）；每次问真实 canExecute，不看 JS 内容或提示词。
  const unavailableWriteTools = (): ToolName[] =>
    canExecute ? [...new Set(WRITE_TOOLS.map((name) => modelToolOf(name)))].filter((name) =>
      !canExecute(name as ToolName) && !execution?.isToolHiddenByMode?.(name)) as ToolName[] : [];

  const assertGenericJsAllowed = () => {
    const missing = unavailableWriteTools();

    if (missing.length === 0) return;
    throw new Error(
      `通用页面 JS 不可用：工具 ${missing.join("、")} 当前未启用，操作未执行。请改用 snapshot 或 read_element 观察页面。`,
    );
  };

  // 每次工具执行的身份（轮次、调用 ID、停止信号）显式绑定到一个 call 上，不靠 AsyncLocalStorage：
  // 浏览器里没有它，而工具可能并行执行，全局变量会串号。
  const makeCall = (scope: ExecutionScope | undefined) => {
  const call = async (name: ToolName, params: Record<string, unknown>, programId?: string, stepId?: string, origin?: "readonly-poll", rpcTimeoutMs?: number): Promise<unknown> => {
    const epoch = scope?.epoch;
    const signal = scope?.signal;
    // SDK 调用身份（含 browser_run 子步骤）随 RPC 登记，执行事实才能沿真实事件回到任务账本。
    const sdkId = execution ? (stepId ?? scope?.toolCallId) : undefined;

    if (sdkId) rpc.ensureToolCall?.(sdkId, name, sid);
    const recoveryRead = name === 'read_element' ? (params as {readback?:{documentId:string;deadline:number}}).readback : undefined;
    const gated = !!(execution && (requiresControlGate(name, params) || recoveryRead));
    const rejectCall = () => { if (sdkId) rpc.markCallRejected?.(sdkId); };

    const assertNotAborted = () => {
      if (!signal?.aborted) return;
      rejectCall();
      throw new Error("本次调用已取消，操作未执行。");
    };

    assertNotAborted();
    // 进入这一步时的执行闸门状态；等用户确认之后再复核一次，避免 TOCTOU。
    const staleStep = () => gated && (!execution!.canWrite(scope?.toolCallId) || epoch !== execution!.epoch());

    if (staleStep()) {
      rejectCall();
      throw new Error("用户已补充或改变要求，旧步骤未执行。请读取最新用户输入并重新核对目标后继续；原任务尚未交付的结果仍需完成。");
    }

    // 需要确认的请求：先等用户选择，获准后才发 RPC。参数用获准的副本，不再读外部对象。
    let callParams = rpc.resolvePageParams?.(name, params, sid) ?? params;

    const assertCall = (target: Record<string, unknown>) => {
      try {
        execution?.assertCall?.(name, target, sdkId);
      } catch (error) {
        rejectCall();
        throw error;
      }
    };

    if (needsConsentTicket(name, params)) {
      const consumeConsent = execution?.consumeConsent;

      if (!consumeConsent) {
        rejectCall();
        throw new Error(CONSENT_REQUIRED_ERROR);
      }

      // 明知会被执行闸门拒绝的请求，不拿去占用户的确认。
      assertCall(callParams);
      const outcome = consentOutcome(await consumeConsent(name, params, { signal }));

      if (!outcome.allowed) {
        rejectCall();
        throw new Error(outcome.reason ?? CONSENT_REQUIRED_ERROR);
      }

      if (outcome.params) callParams = outcome.params;

      if (staleStep()) {
        rejectCall();
        throw new Error("用户已补充或改变要求，旧步骤未执行。请读取最新用户输入并重新核对目标后继续；原任务尚未交付的结果仍需完成。");
      }

      // 等用户点完可能已经有新的执行事实到达，再核一次。
      assertCall(callParams);
    } else {
      assertCall(callParams);
    }

    if (name === "js") {
      try { assertGenericJsAllowed(); }
      catch (error) { if (sdkId) rpc.markCallRejected?.(sdkId); throw error; }
    }

    if (canExecute && !canExecute(modelToolOf(name) as ToolName)) {
      if (sdkId) rpc.markCallRejected?.(sdkId);
      throw new Error(`工具 ${modelToolOf(name)} 当前未启用，操作未执行`);
    }

    // 上传来源校验在共同调用边界：独立工具、browser.upload_file/uploadFile、Playwright setInputFiles 都经此关。
    // 失败记 not_executed（外层 markCallRejected），禁止先派发再补审。
    if (name === "upload_file" || name === "file_chooser_set_files") {
      try {
        const refs = Array.isArray(callParams.paths) ? (callParams.paths as unknown[]).map(String) : [];
        callParams = { ...callParams, paths: authorizeUploadPaths(refs, { ledger: execution?.uploadLedger }) };
      } catch (error) {
        rejectCall();
        throw error;
      }
    }

    if (name === "arm_event" && callParams.type === "download" && typeof callParams.downloadPath !== "string") {
      callParams = { ...callParams, downloadPath: createDownloadArmDir("tool") };
    }

    if (!sid && takeTab && (name === "switch_tab" || name === "close_tab")) {
      await takeTab(typeof callParams.tabId === "number" ? callParams.tabId : undefined);
    }

    let target: ToolContract["read_element"]["data"] | undefined;
    const learning = execution?.learning;

    if (learning?.active() && (name === "fill" || name === "click") && typeof callParams.target === "string") {
      // Observe the actual target, not a model-authored description. This is optional
      // learning evidence; failure disables learning without inventing an anchor.
      try {
        if (canExecute && !canExecute("read_element")) throw new Error("目标观察不可用");
        const readParams = typeof callParams.tabId === "number" ? { target: callParams.target, tabId: callParams.tabId } : { target: callParams.target };
        target = await call("read_element", readParams, programId, `${sdkId ?? "skill-observation"}/anchor`) as ToolContract["read_element"]["data"];
      } catch {
        learning.observe({ toolCallId: sdkId ?? "", name, params: {}, error: "未取得稳定目标证据，不生成技能" });
      }

      // The read above is an await boundary: recheck control and task state before writing.
      assertNotAborted();

      if (staleStep()) { rejectCall(); throw new Error("用户已修改要求，旧步骤未执行。"); }

      assertCall(callParams);
    }

    // 获准或页面移交的 await 返回后，取消信号仍可能先于 RPC 到达。
    assertNotAborted();

    const invoke = (executionEpoch?: number) => {
      if(recoveryRead) {
        const remaining=recoveryRead.deadline-Date.now();

        if(remaining<=0)throw new Error('Readback deadline elapsed');

        return rpc.call(name,callParams,remaining,sid,programId,executionEpoch,sdkId,signal);
      }

      // 未接线 SDK 身份时保持原有调用形状（兼容纯函数测试与外部调用）。
      if (sdkId === undefined) {
        if (executionEpoch !== undefined) return rpc.call(name, callParams, rpcTimeoutMs, sid, programId, executionEpoch);

        return programId ? rpc.call(name, callParams, rpcTimeoutMs, sid, programId) : rpc.call(name, callParams, rpcTimeoutMs, sid);
      }

      return rpc.call(name, callParams, rpcTimeoutMs, sid, programId, executionEpoch, sdkId);
    };

    // 页被另一会话占着且那边已空闲：直接接手并重试这一次，不让模型绕 take_tab。
    // 只对执行前就被拦下的调用这样做；那边还在执行时照旧拦住，由用户决定。
    const invokeReleasingIdleOwner = async (executionEpoch?: number) => {
      try {
        return await invoke(executionEpoch);
      } catch (error) {
        const blockedByIdleOwner = !sid && error instanceof Error && error.message.includes(FOREIGN_TAB_ERROR)
          && "executionFact" in error && error.executionFact === "not_executed";

        if (!blockedByIdleOwner || !execution?.releaseIdleTab) throw error;

        if (!await execution.releaseIdleTab(Number.isSafeInteger(callParams.tabId) ? Number(callParams.tabId) : undefined)) throw error;
        assertNotAborted();

        return invoke(executionEpoch);
      }
    };

    try {
      const result = await invokeReleasingIdleOwner(gated ? epoch : undefined);
      const verify = origin !== "readonly-poll" ? learning?.observe({ toolCallId: sdkId ?? "", name, params: callParams, result, target }) : undefined;

      if (name === "snapshot" && verify) {
        // One bounded, read-only observation using the same tool/control chain.
        // An absent/stale result node disables learning, never fails the user's snapshot.
        try { await call("read_element", { ...verify }, programId, `${sdkId ?? "skill"}/proof`, undefined, 1500); }
        catch { /* failed read already cleared the learning proof */ }
      }

      return result;
    } catch (error) {
      learning?.observe({ toolCallId: sdkId ?? "", name, params: {}, origin, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };

  return call;
  };

  const call = makeCall(undefined);

  const makeDefinitions = (call: ReturnType<typeof makeCall>, scope: ExecutionScope | undefined) => [
    defineTool({
      name: "ask_user_to_point",
      label: "请你指出元素",
      description: "Ask the USER to point to one element on the working page when their reference is ambiguous or they explicitly offer to point. Shows a hover outline and waits up to 90 seconds for their physical click; the selection does NOT activate the page control. Call this tool instead of merely writing a request to point. Pass a short instruction in the user's language. A selected receipt provides the exact target for the user's already-requested next step (e.g. mark); pointing does NOT grant permission to click, submit or save. On cancelled or timed_out, report that fact and STOP this attempted selection: never guess the target, reuse a previous choice, or automatically reopen the picker. Main-document DOM only; frames and custom shadow controls are not supported in this version. Do not call from a background worker or when the user has taken control.",
      parameters: Type.Object({ tabId: Type.Optional(Type.Number()), message: Type.Optional(Type.String({ maxLength: 300 })) }),
      execute: async (_id, params) => {
        // SAFETY: call 原样回传扩展对 ask_user_to_point 的响应体，其形状由 ToolContract 与扩展执行器共同约定。
        const result = await call("ask_user_to_point", params, undefined, undefined, undefined, POINT_SELECTION_TIMEOUT_MS + 10_000) as ToolContract["ask_user_to_point"]["data"];

        const explanation = result.status === "selected"
          ? "The user selected this element; no page control was activated. Use only for the requested operation."
          : result.status === "timed_out" ? "No selection: waiting timed out. Do not guess or reopen automatically."
            : result.reason === "user" ? "The user cancelled selection with Escape. Do not mark or guess a target."
              : "Selection was cancelled because the task or page changed. Do not continue the old operation.";

        return textResult(`${explanation}\n${wrapPageContent(redactCredentialText(JSON.stringify(result)), {})}`, result);
      },
    }),
    ...((generalBrowserLoopEnabled()&&execution?.goal&&execution.reserveDecision)?[defineTool({
      name:'browser_loop',label:'通用网页操作',
      description:'Delegate a bounded browser interaction to a general observation/action loop. It dynamically selects observed controls, never site scripts. Prefer it for navigating controls, filling supplied values, changing filters/settings and other sequences supported by the current page. Supply the complete local goal and ALL constraints; the host also supplies original task context. When exact values are already prepared, pass them in materials (id, value, source, purpose). An empty array is allowed: the loop can request text after selecting a field, without restarting the task. Material values must come from the user, be explicitly generated to meet their request, or use source:"observed" with an exact id/value saved by capture_page_material. The host also supplies these saved materials when the array is empty; never guess personal information. If materials are not prepared, the loop can select a real field and ask the bounded text helper for that field only; missing facts hand back to you. Missing values/unsupported controls/uncertainty/failures hand control back to you. It can return needs_verification, never task success: independently inspect fresh state and verify ALL requirements before task_results or send_user_message completion. Do not repeatedly call the same failed loop; handle its specific reason using other permitted tools. Existing dangerous-action confirmation, user takeover, cancellation and task version apply to every step.',
      parameters:Type.Object({goal:Type.String({minLength:1,maxLength:12000}),materials:Type.Array(Type.Object({id:Type.String({minLength:1}),value:Type.String({maxLength:8000}),source:Type.Union([Type.Literal('user'),Type.Literal('generated'),Type.Literal('observed')]),purpose:Type.String()}),{maxItems:12})}),
      execute:async(id,params,signal)=>{
        if(params.materials.some(m=>m.source==='user'&&(!execution?.userText||!execution.userText().includes(m.value))))throw new Error('用户材料没有匹配到本轮原文，未执行；不得把生成内容标成用户提供。');
        const observed=execution?.observedMaterials?.()??[];

        if(params.materials.some(m=>m.source==='observed'&&!observed.some(saved=>saved.id===m.id&&saved.value===m.value)))throw new Error('原文材料没有匹配宿主保存的来源');
        const materials=[...params.materials,...observed.filter(m=>!params.materials.some(p=>p.id===m.id))].slice(0,12);
        const stop=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(90000)]);
        const original=scope;
        rpc.noteToolFact?.(id,'unknown');

        const run=(call:ReturnType<typeof makeCall>)=>runBrowserDecisionLoop({parentCallId:id,goal:JSON.stringify({userTask:execution?.goal?.()??null,localGoal:params.goal}),materials,signal:stop,getMaterial:execution?.getMaterial,reserveDecision:()=>{if(!execution?.reserveDecision)throw new Error('没有任务决策预算，未调用模型');execution.reserveDecision();},
          canExecute:canExecute?(name)=>canExecute(name as ToolName):undefined,
          call:async(name,args,childId)=>{
            const started=Date.now();
            execution?.onStep?.({parentId:id,id:childId,name,phase:'start',params:args});

            try{const result=await call(name,args,id,childId);execution?.onStep?.({parentId:id,id:childId,name,phase:'end',params:args,result,elapsedMs:Date.now()-started});

return result;}
            catch(e){execution?.onStep?.({parentId:id,id:childId,name,phase:'end',params:args,error:e instanceof Error?e.message:String(e),elapsedMs:Date.now()-started});throw e;}
          }});

        const result=original?await run(makeCall({...original,signal:stop})):await run(call);
        rpc.noteToolFact?.(id,result.receipts.some(r=>r.executionFact==='unknown')?'unknown':'executed');

        return textResult(wrapPageContent(redactCredentialText(JSON.stringify(result)),{}),result);
      },
    })]:[]),
    defineTool({
      name: "page_translation",
      label: "翻译网页",
      description: 'Translate the current webpage IN PLACE, progressively, using the current model. action:"translate" translates all currently loaded readable text (also resumes partial translation), default target 简体中文 and default bilingual; pass mode:"translated" when the user only wants translation. action:"display" switches existing results without translating again: mode bilingual/translated, optional fontSize in px (10–48), fontFamily:"songti" for 宋体 or "original" to restore the site font. In display, submit ONLY the fields this request changes; omitted fields keep the current page state (a font-only request must not carry mode or fontSize), and never add display attributes the user did not ask to change. For a font or display-only request, call display ONLY. Its remaining count does not authorize resuming translation; do not call translate unless the user asks to translate or continue. Never use handwritten JS to change translation fonts. action:"restore" restores original text. Keeps links and original nodes. Does not translate editable fields, code, images, PDF or frames. Receipt has translated/remaining/unsupported paragraph counts: report partial work honestly. If incompleteReason is present, keep completed text and report the changing content or limit; do not automatically restart translation. Use this tool, never handwritten JS or a sidebar-only translation. Do not delegate page translation to workers.',
      parameters: Type.Object({
        action: Type.Union([Type.Literal('translate'), Type.Literal('display'), Type.Literal('restore')]),
        tabId: Type.Optional(Type.Number()), language: Type.Optional(Type.String()),
        mode: Type.Optional(Type.Union([Type.Literal('bilingual'), Type.Literal('translated')])),
        fontSize: Type.Optional(Type.Number({minimum: 10, maximum: 48})),
        fontFamily: Type.Optional(Type.Union([Type.Literal('original'), Type.Literal('songti')])),
        document: Type.Optional(Type.String({description:'Observed translation instance; reject if the page changed.'})),
      }),
      execute: async (_id, params, signal) => {
        const stop = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(240_000)]);

        const result = await runPageTranslation(params as TranslationRequest,
          async command => await call('page_translation', {...command}) as TranslationReceipt,
          translateBatch ?? (async () => { throw new Error('当前会话的翻译模型不可用。'); }), stop);

        return textResult(JSON.stringify(result), result);
      },
    }),
    defineTool({
      name: "page_operation",
      label: "Write and verify field",
      description: "Safely edit a field on a shared page with collaborators. If you are the only agent on this page, use fill, not this tool — it will refuse and waste retries. The executor serializes the complete re-locate, expected-value check, focus, fill and readback. Use a stable CSS target from a fresh snapshot, never old coordinates. Read expectedValue first. Failure reports any mutation; never assume rollback. Do not hold the page while thinking or waiting for messages.",
      parameters: Type.Object({
        tabId: Type.Optional(Type.Number()), target: Type.String(), expectedValue: Type.String(), value: Type.String(),
      }),
      execute: async (_id, params) => {
        const result = await call("page_operation", params);

        return textResult(JSON.stringify(result), result);
      },
    }),
    defineTool({
      name: "read_element",
      label: "Read complete element",
      description: "Read a unique current element without changing the page. By default return complete textContent and field value. Rich editors also return editableText with paragraph and hard-break newlines; raw textContent omits these breaks, so use editableText for copied rich-text content. Use target:'body' for full source text. For controls/media use properties (paused, currentTime, checked, enabled, visible, expanded, pressed, value), not handwritten JS probes. Native select has two different states: value is the option's internal value/id (for example 'c'), while displayValue is the visible label the user sees (for example '远山'). When the requested state is expressed as a human-visible option label, verify with displayValue, never compare that label to value or selected. To verify or wait, use expect:{property:'paused',equals:true}, expect:{property:'displayValue',equals:'远山'} for a select label, or expect:{property:'textContent',contains:'Saved'}, with timeoutMs up to 5000. Returns check.matched only when that exact condition holds; timeout is a failure, never success. Use a current snapshot @ref or unique observed native CSS; ambiguity/stale refs fail without switching targets. Works inside browser_run with the same parameters. Main may read any tab; workers only assigned tabs.",
      parameters: Type.Object({
        tabId: Type.Optional(Type.Number({ description: "Owned tab id; omit to use this member's working tab" })),
        target: Type.String({ description: 'Current "@N" snapshot ref, "loc=css:...", or unique native CSS selector' }),
        properties: Type.Optional(Type.Array(Type.Union(ELEMENT_PROPERTIES.map(p => Type.Literal(p))), { maxItems: ELEMENT_PROPERTIES.length, description: 'Read these state properties; omit for complete text/value. Unsupported properties fail explicitly.' })),
        expect: Type.Optional(Type.Union([
          Type.Object({ property: Type.Union(['visible','enabled','checked','selected','paused','ended'].map(p => Type.Literal(p))), equals: Type.Boolean({description:'Boolean true/false, never a quoted string.'}) }),
          Type.Object({ property: Type.Union([Type.Literal('expanded'),Type.Literal('pressed')]), equals: Type.Union([Type.Boolean(),Type.Literal('mixed')]) }),
          Type.Object({ property: Type.Union([Type.Literal('currentTime'),Type.Literal('duration')]), equals: Type.Number() }),
          Type.Object({ property: Type.Union([Type.Literal('textContent'),Type.Literal('value'),Type.Literal('displayValue')]), equals: Type.String() }),
          Type.Object({ property: Type.Union([Type.Literal('textContent'), Type.Literal('value'), Type.Literal('displayValue')]), contains: Type.String({ minLength: 1 }) }),
        ])),
        timeoutMs: Type.Optional(Type.Number({ minimum: 0, maximum: 5000, description: 'Optional bounded wait for expect; default 0 checks once. No model round trips while waiting.' })),
      }),
      execute: async (_id, params) => {
        const data = (await call("read_element", params)) as ToolContract["read_element"]["data"];
        // A state query does not need the element's entire descendant text in the model context.
        const projected = params.properties?.length || params.expect ? (params.properties?.some(property=>property==='textContent')&&data.editableText!==undefined ? { tabId: data.tabId, target: data.target, tagName: data.tagName, properties: data.properties, check: data.check, editableText: data.editableText } : { tabId: data.tabId, target: data.target, tagName: data.tagName, properties: data.properties, check: data.check }) : data;

        return textResult(wrapPageContent(redactCredentialText(JSON.stringify(projected)), { tabId: data.tabId }), data);
      },
    }),
    defineTool({
      name: "read_elements",
      label: "Read matching elements",
      description: "Host-only, bounded readback of EVERY current element matching a native CSS selector, without changing the page: text, visibility, position and computed style for each match, plus total/truncated counts. Use to verify page-wide annotation/highlight/marking state that a single read_element cannot cover; the host reads this directly, it is never a model claim.",
      parameters: Type.Object({
        tabId: Type.Optional(Type.Number({ description: "Owned tab id; omit to use this member's working tab" })),
        selector: Type.String({ minLength: 1, description: "Native CSS selector; every current match is read, up to limit." }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Maximum elements to read (1-200, matching the executor bound); excess are reported as truncated, not silently dropped." })),
      }),
      execute: async (_id, params) => {
        const data = (await call("read_elements", params)) as ToolContract["read_elements"]["data"];

        return textResult(wrapPageContent(redactCredentialText(JSON.stringify(data)), { tabId: data.tabId }), data);
      },
    }),
    defineTool({
      name: "browser_run",
      label: "Browser program",
      description: 'Run an async JavaScript browser program. Only the browser object is available (no Node, process, require, fetch or document). Its methods use the SAME object parameters and return raw data from the regular tools: snapshot()->{text}, js({code})->{value}, hover/click({target or point}), fill({target,value}), and the other browser tools. Real-input actions are also available as browser.doubleClick({target|point}), browser.drag({from,to}), browser.wheel/mouseDown/mouseUp/keyDown/keyUp/releaseHeldInputs/paste/html5Drag, and browser.uploadFile({target,paths}); browser.cdp({method,params?}) is the gated raw-CDP escape hatch. Composed helpers: ' + BROWSER_PROGRAM_HELPERS.map(h => h.name).join(", ") + ' (host-implemented, no new RPC). camelCase aliases: ' + Object.keys(RPC_ALIASES).join(", ") + '. browser.waitFor({selector,timeoutMs:5000}) waits for one visible enabled target (@ref / CSS / xpath= / text=); browser.sleep({ms}) waits up to 10000ms. Use await for every operation and return JSON-serializable evidence. For one known action on a page you have not read yet, fold the observation into this same program (snapshot → pick the target → click → read back) instead of spending a separate round on snapshot. Prefer this for a known sequence with conditions/waits; observe first when targets are unknown. Page JavaScript belongs inside browser.js({code:"..."}). A held click, takeover or cancellation stops the entire program even if caught. Do not bypass confirmation or user control with page JS. Set api:"playwright" when you already know the field the way a human labels it (e.g. a form label or a button name) and want one familiar locator chain instead of a snapshot round: it reuses the official Stagehand Playwright compatibility layer inside this same sandbox and gives the program extra page/context objects (page.getByLabel/getByRole/getByText/getByPlaceholder/page.locator(...).fill/click/press/readback, page.evaluate, page.waitForTimeout). It is that compatibility layer only — not the Stagehand SDK, not browser-side batching. Every locator action still goes through the same tools, permissions, task page and stop rules, and it writes only through the real fill/click/press RPCs. Unsupported Playwright methods fail loudly; screenshots and snapshots stay with browser.screenshot()/browser.snapshot().',
      parameters: Type.Object({
        code: Type.String({ description: 'Async function body; await browser methods and return concise evidence. Example: await browser.hover({target:"#card"}); await browser.waitFor({selector:"#edit"}); await browser.click({target:"#edit"}); return (await browser.snapshot()).text;' }),
        label: Type.Optional(Type.String({ description: "Short user-facing goal for this sequence" })),
        api: Type.Optional(Type.Union([Type.Literal("ego"), Type.Literal("playwright")], { description: 'Default "ego" (browser.* tools only). "playwright" adds the official compatibility layer\'s page/context objects; existing programs keep working unchanged.' })),
      }),
      execute: async (id, params, signal, onUpdate) => {
        // 组合调用一旦开始，整体结果就不再是“确定未执行”。
        rpc.noteToolFact?.(id, "unknown");
        const api = params.api === "playwright" ? "playwright" : "ego";
        // playwright 模式在发起这一刻锁定任务缺省页；程序第一步还会用 list_tabs 读一次绑定页。
        const pageTabId = api === "playwright" ? rpc.getPageTarget?.(sid) ?? null : null;

        const result = await runBrowserProgram({ code: params.code, api, pageTabId,
          call: (name, args, stepId, origin) => call(name, args, id, stepId, origin), signal, id,
          authorizeUpload: (refs) => authorizeUploadPaths(refs, { ledger: execution?.uploadLedger }),
          // Preflight needs the substep binding now, not after Pi's async progress queue drains.
          onStep: programStep => execution?.onStep ? execution.onStep(programStep) : onUpdate?.({ content: [], details: { programStep } }),
        });

        rpc.noteToolFact?.(id, "executed");

        return { content: [{ type: "text" as const, text: truncate(JSON.stringify({ value: result.value, steps: result.steps }), MAX_JS_RESULT_CHARS) }, ...result.images], details: { value: result.value, steps: result.steps } };
      },
    }),

    defineTool({
      name: "tabs",
      label: "Tabs",
      description:
        sid
          ? 'One tool for browser tabs. action:"list" lists the tabs assigned to you; other members\' and user tabs are not available to workers.'
          : 'One tool for browser tabs, in one call: action:"list" lists ALL tabs (id, title, URL) including user-opened and other conversations\' — reading does not claim them; action:"active" returns the tab the user is looking at right now (use it for "this page" when the message carries no page context, then action:"switch"); action:"open" opens url (omit for blank) and claims it as the working tab; action:"switch" makes tabId the working tab; action:"close" closes tabId or the working tab. Open returns when the document is interactive, not when all resources finish; a readiness timeout is not confirmed success — check the URL and snapshot before acting.',
      parameters: Type.Object({
        action: Type.Union([Type.Literal("list"), Type.Literal("active"), Type.Literal("open"), Type.Literal("switch"), Type.Literal("close")], {
          description: "list | active | open | switch | close",
        }),
        tabId: Type.Optional(Type.Number({ description: 'Tab id (required for "switch"; optional for "close", which defaults to the working tab)' })),
        url: Type.Optional(Type.String({ description: 'URL to open for "open"; omit for a blank tab' })),
        decisionGuard: Type.Optional(Type.Object({
          observationId: Type.String(),
          operation: Type.Literal('switch_tab'),
          sourceTabId: Type.Number(),
        }, { description: 'Host-issued guard for a switch selected from a current browser observation.' })),
      }),
      execute: async (_id, params) => {
        if (params.action === "list") {
          const data = (await call("list_tabs", {})) as ToolContract["list_tabs"]["data"];

          return textResult(formatTabs(data.tabs), data);
        }

        if (params.action === "active") {
          const data = (await call("get_active_tab", {})) as ToolContract["get_active_tab"]["data"];

          if (!data.tab) return textResult("No active tab found.", data);

          return textResult(formatTabs([data.tab]), data);
        }

        if (params.action === "open") {
          const data = (await call("open_tab", params.url ? { url: params.url } : {})) as ToolContract["open_tab"]["data"];

          return textResult(`Created tab ${data.tabId}: ${data.title || "(loading)"} — ${data.url}; document: ${data.readiness ?? "not checked"}`, data);
        }

        if (params.action === "switch") {
          if (typeof params.tabId !== "number") throw new Error('tabs action:"switch" 需要 tabId。');

          const switchParams = params.decisionGuard ? { tabId: params.tabId, decisionGuard: params.decisionGuard } : { tabId: params.tabId };
          const data = (await call("switch_tab", switchParams)) as ToolContract["switch_tab"]["data"];

          return textResult(switchResultText(data), data);
        }

        const data = (await call("close_tab", typeof params.tabId === "number" ? { tabId: params.tabId } : {})) as ToolContract["close_tab"]["data"];

        return textResult("Tab closed.", data);
      },
    }),

    defineTool({
      name: "navigate",
      label: "Navigate",
      description: "Navigate the working tab to a URL and wait for the new document to be interactive. Readiness timeout is not confirmed navigation success; verify the URL and take a snapshot before acting.",
      parameters: Type.Object({
        url: Type.String({ description: "Absolute URL" }),
        timeout: Type.Optional(Type.Number({ description: "Load timeout in seconds" })),
      }),
      execute: async (_id, params) => {
        const data = (await call("navigate", params)) as ToolContract["navigate"]["data"];

        return textResult(`Navigation result: ${data.url} — ${data.title}; document: ${data.readiness ?? "not checked"}`, data);
      },
    }),

    defineTool({
      name: "snapshot",
      label: "Snapshot",
      description:
        "Read a tab as indented text. Main can pass any tabId without taking control; omit tabId for the working tab. Workers can read only assigned tabs. scope=full_page (default): the real CDP accessibility tree (covers shadow DOM and virtualized content); rendered content (including headings, text, images and controls) carries [ref=N] when backed by a DOM node (= backendDOMNodeId, CDP path). scope=viewport: a viewport-only simplified DOM snapshot (downgrade, not the full AX tree); its refs are DOM snapshot numbers valid only via the DOM path — do not mix them with older AX refs. This is your primary way to observe the page.",
      promptGuidelines: [
        "Take a snapshot after every navigation and after actions that change the page.",
        "Ref numbers are stable for persistent nodes, but @N must appear in the latest snapshot. A new snapshot replaces the available ref set; navigation or node replacement invalidates old refs.",
        "Viewport snapshots return a different (DOM) ref space; never reuse full_page AX refs after a viewport snapshot.",
      ],
      parameters: Type.Object({
        tabId: Type.Optional(Type.Number({ description: "Tab to read without claiming or switching it" })),
        scope: Type.Optional(
          Type.Union([Type.Literal("full_page"), Type.Literal("viewport")], {
            description: "full_page (default) or viewport only",
          }),
        ),
      }),
      execute: async (_id, params) => {
        const data = (await call("snapshot", params)) as ToolContract["snapshot"]["data"];

        return textResult(wrapPageContent(redactCredentialText(data.text), { tabId: data.tabId }), data);
      },
    }),

    defineTool({
      name: "hover",
      label: "Hover",
      description:
        'Move the real browser mouse over an element to reveal hover-only controls, menus or tooltips. Provide target ("@N" from the latest snapshot, "loc=css:...", or native CSS) or viewport point [x,y]. Then observe which controls appeared before clicking. JavaScript-dispatched mouse events do not activate CSS :hover.',
      parameters: Type.Object({
        target: Type.Optional(Type.String({ description: '"@N" from the latest snapshot, "loc=css:...", or native CSS; no :has-text()' })),
        point: Type.Optional(viewportPoint({ description: "Viewport [x, y] coordinates" })),
        label: Type.Optional(Type.String({ description: "Short description of the hover target" })),
      }),
      execute: async (_id, params) => {
        const data = await call("hover", params);
        const what = params.label ?? params.target ?? (params.point ? `(${params.point[0]}, ${params.point[1]})` : "element");

        return textResult(`Mouse moved over ${what}. Observe the page to check whether the intended control appeared.`, data);
      },
    }),

    defineTool({
      name: "click",
      label: "Click",
      description:
        'Click an element in the working tab. Provide target ("@N" ref, "loc=css:..." locator, or a raw CSS selector) or point [x, y] viewport coordinates. Native <select> dropdowns: use fill with the visible option text (for example 杭州); do not click — headless has no OS picker. The result reports whether the page reacted (target state, target region, new notices) and says explicitly when nothing is attributable to the click.',
      parameters: Type.Object({
        target: Type.Optional(
          Type.String({ description: '"@N" ref, "loc=css:..." locator, or raw CSS selector' }),
        ),
        point: Type.Optional(
          viewportPoint({ description: "Viewport [x, y] coordinates" }),
        ),
        position: Type.Optional(
          Type.Object(
            { x: Type.Number({ description: "CSS px from target top-left" }), y: Type.Number() },
            { description: "Offset inside target; ignored when point is set" },
          ),
        ),
        button: Type.Optional(
          Type.Union([Type.Literal("left"), Type.Literal("middle"), Type.Literal("right")], {
            description: 'Mouse button (default "left")',
          }),
        ),
        clickCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "CDP clickCount (default 1)" })),
        force: Type.Optional(Type.Boolean({ description: "Skip hit-target confirmation and still dispatch" })),
        label: Type.Optional(Type.String({ description: "Short human-readable description of what you click" })),
      }),
      execute: async (_id, params) => {
        const data = (await call("click", params)) as ToolContract["click"]["data"];
        const what = params.label ?? params.target ?? (params.point ? `(${params.point[0]}, ${params.point[1]})` : "element");

        if ("held" in data && data.held) {
          return textResult(
            `Held click on ${what}. The cursor is holding the target with confirm/cancel buttons on its name pill. Wait for the user. Do not click the site's own delete control again, and do not claim you already marked it.`,
            data,
          );
        }

        const effectText = formatEffectReport("effect" in data ? data.effect : undefined);
        const opened = "newTab" in data ? data.newTab : undefined;
        const newTabText = opened ? ` A new tab opened (tab ${opened.tabId}${opened.url ? `, ${opened.url}` : ""}) and it is now your working tab; observe it before continuing.` : "";

        if (effectText) {
          return textResult(`Clicked ${what}. Event dispatch confirmed.${effectText}${newTabText}`, data);
        }

        return textResult(`Clicked ${what}. This confirms event dispatch only; observe the page to verify the intended change before continuing or reporting success.${newTabText}`, data);
      },
    }),

    defineTool({
      name: "double_click",
      label: "Double click",
      description: 'Double-click an element in the working tab using REAL browser input (CDP clickCount 1→2), never synthetic DOM events. Provide target ("@N" ref, "loc=css:...", raw CSS, xpath=..., text=...) or point [x,y]. Destructive targets require user confirmation first, exactly like click. The result reports effect evidence when measurable and explicitly says when only input dispatch is confirmed.',
      parameters: Type.Object({
        target: Type.Optional(Type.String({ description: '"@N" ref, "loc=css:...", raw CSS, xpath=..., or text=...' })),
        point: Type.Optional(viewportPoint({ description: "Viewport [x, y] coordinates" })),
        position: Type.Optional(
          Type.Object(
            { x: Type.Number({ description: "CSS px from target top-left" }), y: Type.Number() },
            { description: "Offset inside target; ignored when point is set" },
          ),
        ),
        button: Type.Optional(
          Type.Union([Type.Literal("left"), Type.Literal("middle"), Type.Literal("right")], {
            description: 'Mouse button (default "left")',
          }),
        ),
        clickCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "CDP clickCount (double-click path still uses 1→2 when omitted)" })),
        force: Type.Optional(Type.Boolean({ description: "Skip hit-target confirmation and still dispatch" })),
        label: Type.Optional(Type.String({ description: "Short human-readable description of what you double-click" })),
      }),
      execute: async (_id, params) => {
        const data = (await call("double_click", params)) as ToolContract["double_click"]["data"];
        const what = params.label ?? params.target ?? (params.point ? `(${params.point[0]}, ${params.point[1]})` : "element");

        if ("held" in data && data.held) {
          return textResult(
            `Held double-click on ${what}. The cursor is holding the target with confirm/cancel buttons on its name pill. Wait for the user.`,
            data,
          );
        }

        const effectText = formatEffectReport("effect" in data ? data.effect : undefined);
        const opened = "newTab" in data ? data.newTab : undefined;
        const newTabText = opened ? ` A new tab opened (tab ${opened.tabId}${opened.url ? `, ${opened.url}` : ""}) and it is now your working tab; observe it before continuing.` : "";

        if (effectText) return textResult(`Double-clicked ${what}.${effectText}${newTabText}`, data);

        return textResult(`Double-clicked ${what}. This confirms native input dispatch only; observe the page to verify the intended change before reporting success.${newTabText}`, data);
      },
    }),

    defineTool({
      name: "drag",
      label: "Drag",
      description: 'Drag with the real browser pointer: press at from, move along a bounded path, release at to. from/to each take target ("@N", "loc=css:...", raw CSS, xpath=..., text=...) or viewport point [x,y]. Works for sortable lists, sliders, cards and pointer-driven canvases; never dispatches synthetic DOM drag events. Destructive source targets require user confirmation first. Effect evidence is measured at the drop point.',
      parameters: Type.Object({
        from: Type.Object({
          target: Type.Optional(Type.String({ description: 'Source locator (@N / loc=css: / CSS / xpath= / text=)' })),
          point: Type.Optional(viewportPoint({ description: "Viewport [x, y] coordinates" })),
        }, { description: "Drag source: exactly one of target/point" }),
        to: Type.Object({
          target: Type.Optional(Type.String({ description: 'Drop locator (@N / loc=css: / CSS / xpath= / text=)' })),
          point: Type.Optional(viewportPoint({ description: "Viewport [x, y] coordinates" })),
        }, { description: "Drop destination: exactly one of target/point" }),
        label: Type.Optional(Type.String({ description: "Short human-readable description of the drag" })),
      }),
      execute: async (_id, params) => {
        const data = (await call("drag", params)) as ToolContract["drag"]["data"];

        if ("held" in data && data.held) {
          return textResult("Held drag. The cursor is holding the source with confirm/cancel buttons on its name pill. Wait for the user.", data);
        }

        const effectText = formatEffectReport("effect" in data ? data.effect : undefined);
        const from = params.from.target ?? (params.from.point ? `(${params.from.point[0]}, ${params.from.point[1]})` : "?");
        const to = params.to.target ?? (params.to.point ? `(${params.to.point[0]}, ${params.to.point[1]})` : "?");

        if (effectText) return textResult(`Dragged ${from} → ${to}.${effectText}`, data);

        return textResult(`Dragged ${from} → ${to}. Input sequence dispatched; observe the page to verify the intended state change.`, data);
      },
    }),

    defineTool({
      name: "wheel",
      label: "Mouse wheel",
      description:
        "Dispatch a real CDP mouseWheel at point, target(+optional position), or the session pointer. deltaX/deltaY are CSS-pixel scroll deltas. Does not set scrollTop= by script.",
      parameters: Type.Object({
        deltaX: Type.Optional(Type.Number()),
        deltaY: Type.Optional(Type.Number()),
        point: Type.Optional(viewportPoint()),
        target: Type.Optional(Type.String()),
        position: Type.Optional(Type.Object({ x: Type.Number(), y: Type.Number() })),
        label: Type.Optional(Type.String()),
      }),
      execute: async (_id, params) => {
        const data = (await call("wheel", params)) as ToolContract["wheel"]["data"];
        const ack = data.ackMs != null ? `；手势 ACK ${data.ackMs}ms` : "";
        const tries = data.attempts > 1 ? `；重试 ${data.attempts} 次后确认` : "";

        return textResult(`Wheeled at (${data.point[0]}, ${data.point[1]})${ack}${tries}。`, data);
      },
    }),

    defineTool({
      name: "mouse_down",
      label: "Mouse down",
      description: "Press and hold a mouse button at point/target. Pair with mouse_up or release_held_inputs. Held across calls until released.",
      parameters: Type.Object({
        button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("middle"), Type.Literal("right")])),
        clickCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
        point: Type.Optional(viewportPoint()),
        target: Type.Optional(Type.String()),
        position: Type.Optional(Type.Object({ x: Type.Number(), y: Type.Number() })),
      }),
      execute: async (_id, params) => {
        const data = (await call("mouse_down", params)) as ToolContract["mouse_down"]["data"];

        return textResult(`Mouse ${data.button} down at (${data.point[0]}, ${data.point[1]}).`, data);
      },
    }),

    defineTool({
      name: "mouse_up",
      label: "Mouse up",
      description: "Release a mouse button at point or the session pointer.",
      parameters: Type.Object({
        button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("middle"), Type.Literal("right")])),
        clickCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
        point: Type.Optional(viewportPoint()),
      }),
      execute: async (_id, params) => {
        const data = (await call("mouse_up", params)) as ToolContract["mouse_up"]["data"];

        return textResult(`Mouse ${data.button} up at (${data.point[0]}, ${data.point[1]}).`, data);
      },
    }),

    defineTool({
      name: "key_down",
      label: "Key down",
      description: 'Press and hold a key (e.g. "Shift", "ControlOrMeta", "a"). Pair with key_up or release_held_inputs. Prefer press_key for ordinary typing chords.',
      parameters: Type.Object({
        key: Type.String({ minLength: 1, maxLength: 64 }),
      }),
      execute: async (_id, params) => {
        const data = (await call("key_down", params)) as ToolContract["key_down"]["data"];

        return textResult(`Key down: ${data.key}.`, data);
      },
    }),

    defineTool({
      name: "key_up",
      label: "Key up",
      description: "Release a previously held key.",
      parameters: Type.Object({
        key: Type.String({ minLength: 1, maxLength: 64 }),
      }),
      execute: async (_id, params) => {
        const data = (await call("key_up", params)) as ToolContract["key_up"]["data"];

        return textResult(`Key up: ${data.key}.`, data);
      },
    }),

    defineTool({
      name: "release_held_inputs",
      label: "Release held inputs",
      description: "Release all keys and mouse buttons still held for this session (safe after cancel/error).",
      parameters: Type.Object({}),
      execute: async (_id) => {
        const data = (await call("release_held_inputs", {})) as ToolContract["release_held_inputs"]["data"];

        return textResult(
          `Released keys [${data.releasedKeys.join(", ") || "none"}], buttons [${data.releasedButtons.join(", ") || "none"}].`,
          data,
        );
      },
    }),

    defineTool({
      name: "paste",
      label: "Paste",
      description:
        "Native paste of text and optional html via the host clipboard bridge, then ControlOrMeta+V. Without a clipboard bridge this fails as BLOCKED — do not invent success via innerHTML or synthetic paste events. Does not read the user's real clipboard.",
      parameters: Type.Object({
        content: Type.Union([
          Type.String({ minLength: 0, maxLength: 100_000 }),
          Type.Object({
            text: Type.String({ minLength: 0, maxLength: 100_000 }),
            html: Type.Optional(Type.String({ maxLength: 200_000 })),
          }),
        ]),
      }),
      execute: async (_id, params) => {
        const data = (await call("paste", params)) as ToolContract["paste"]["data"];

        return textResult(`Pasted (clipboard ${data.clipboard}).`, data);
      },
    }),

    defineTool({
      name: "html5_drag",
      label: "HTML5 drag and drop",
      description:
        "HTML5 DataTransfer drag (intercept + dispatchDragEvent). Pointer-only drag is a different tool. If no intercept payload is available the receipt reports gap and must not be treated as success.",
      parameters: Type.Object({
        from: Type.Object({
          target: Type.Optional(Type.String()),
          point: Type.Optional(viewportPoint()),
          position: Type.Optional(Type.Object({ x: Type.Number(), y: Type.Number() })),
        }),
        to: Type.Object({
          target: Type.Optional(Type.String()),
          point: Type.Optional(viewportPoint()),
          position: Type.Optional(Type.Object({ x: Type.Number(), y: Type.Number() })),
        }),
        label: Type.Optional(Type.String()),
      }),
      execute: async (_id, params) => {
        const data = (await call("html5_drag", params)) as ToolContract["html5_drag"]["data"];

        if ("gap" in data && data.dragged === false) {
          return textResult(`HTML5 drag gap (${data.gap}): ${data.detail}. Do not report success.`, data);
        }

        return textResult(`HTML5 drag completed via ${(data as { path: string }).path}.`, data);
      },
    }),

    defineTool({
      name: "select_option",
      label: "Select option",
      description:
        "Select options on a native <select> by value, visible label, or 0-based index. Pass an array for multiple selects; null or [] clears the selection. Receipt returns the final selected value set and labels — do not treat single-value fill as a full selectOption.",
      parameters: Type.Object({
        target: Type.String({
          description: 'Select locator ("@N", "loc=css:...", "loc=role:...", "loc=href:...", xpath=, text=, raw CSS)',
        }),
        values: Type.Union([
          Type.Null(),
          Type.String(),
          Type.Object({
            value: Type.Optional(Type.String()),
            label: Type.Optional(Type.String()),
            index: Type.Optional(Type.Integer({ minimum: 0 })),
          }),
          Type.Array(
            Type.Union([
              Type.String(),
              Type.Object({
                value: Type.Optional(Type.String()),
                label: Type.Optional(Type.String()),
                index: Type.Optional(Type.Integer({ minimum: 0 })),
              }),
            ]),
            { maxItems: 64 },
          ),
        ]),
      }),
      execute: async (_id, params) => {
        const data = (await call("select_option", params)) as ToolContract["select_option"]["data"];

        return textResult(
          `Selected [${data.selected.map((v, i) => `${v} (${data.labels[i] ?? ""})`).join(", ") || "(cleared)"}].`,
          data,
        );
      },
    }),

    defineTool({
      name: "upload_file",
      label: "Upload file",
      description: 'Set files on exactly one <input type=file> WITHOUT opening the OS file picker. Prefer task fileIds from the current task grant; absolute paths are accepted only when they resolve to the same grant record (user-provided or this-task artifacts under ~/.sideagent/uploads/ or ~/.sideagent/downloads/). Historical files in those directories are not authorized. Empty paths clears the input. target takes the same locator forms as click and must resolve to exactly one file input. The receipt lists the files actually applied, read back from the page after the upload — that list, not the command return, is the evidence. 上传文件必须走 upload_file；raw CDP 不能调用 DOM.setFileInputFiles，也不能读取任意磁盘文件。',
      parameters: Type.Object({
        target: Type.String({ description: 'File input locator ("@N", "loc=css:...", raw CSS, xpath=..., text=...)' }),
        paths: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { minItems: 0, maxItems: 8, description: "Task fileIds and/or absolute paths that resolve to this task's upload grant; empty clears the input" }),
      }),
      execute: async (_id, params) => {
        // 授权在共同 call 边界完成；此处只负责派发与读回文案。
        const data = (await call("upload_file", { target: params.target, paths: params.paths })) as ToolContract["upload_file"]["data"];

        if (data.files.length === 0) return textResult("Cleared the file input (0 files read back).", data);
        const list = data.files.map(f => `${f.name} (${f.size} B)`).join(", ");

        return textResult(`Uploaded ${data.files.length} file(s) and read them back from the input: ${list}.`, data);
      },
    }),

    defineTool({
      name: "cdp",
      label: "Raw CDP",
      description: 'Raw CDP allows only a fixed read-only observation subset on the CURRENT working tab: Page.getLayoutMetrics, Page.getFrameTree, DOM.getDocument, DOM.describeNode, DOM.getAttributes, DOM.getBoxModel, DOM.getContentQuads, DOM.getNodeForLocation, DOM.querySelector, DOM.querySelectorAll. 上传文件必须走 upload_file；raw CDP 不能调用 DOM.setFileInputFiles，也不能读取任意磁盘文件。DOM.setFileInputFiles, Runtime.*, Input.*, Emulation.*, file read/write, and any other unlisted method are unsupported and refused before touching the browser. Other tabId/sessionId/targetId values are refused. Prefer dedicated tools; verify page state afterwards. Results are bounded (truncated flag when cut).',
      parameters: Type.Object({
        method: Type.String({ minLength: 3, maxLength: 120, description: 'CDP method, e.g. "Page.getLayoutMetrics" or "DOM.getDocument"' }),
        params: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "CDP params object (no sessionId/targetId — the working tab session is implied)" })),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 30000, description: "Default 10000" })),
      }),
      execute: async (_id, params) => {
        const data = (await call("cdp", params)) as ToolContract["cdp"]["data"];
        const raw = typeof data.result === "string" ? data.result : JSON.stringify(data.result, null, 2);
        const rendered = truncate(raw ?? "null", MAX_JS_RESULT_CHARS);

        return textResult(data.truncated ? `${rendered}\n(CDP result was truncated by the size bound)` : rendered, data);
      },
    }),

    defineTool({
      name: "arm_event",
      label: "Arm page event",
      description: 'Arm popup/download/filechooser BEFORE the triggering action. Returns a host-issued token (never invent tokens). Pattern: arm_event → click/action → wait_event(token). Required for ephemeral popups, blob downloads, and dynamic file inputs. For download, the host creates a task temp directory (no global Chromium download dir). Prefer browser_run helpers armEvent/waitEvent when composing multi-step scripts.',
      parameters: Type.Object({
        type: Type.Union([Type.Literal("popup"), Type.Literal("download"), Type.Literal("filechooser")]),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 120000 })),
      }),
      execute: async (_id, params) => {
        const data = (await call("arm_event", params)) as ToolContract["arm_event"]["data"];

        return textResult(`Armed ${data.type}; token=${data.token}. Trigger the action, then wait_event.`, data);
      },
    }),

    defineTool({
      name: "wait_event",
      label: "Wait page event",
      description: "Consume a previously armed host token. Fails on forged/expired tokens. One-shot.",
      parameters: Type.Object({
        token: Type.String({ minLength: 8, maxLength: 120 }),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 120000 })),
      }),
      execute: async (_id, params) => {
        const data = (await call("wait_event", params)) as ToolContract["wait_event"]["data"];

        return textResult(`Event ${data.type} matched for token ${data.token}.`, data);
      },
    }),

    defineTool({
      name: "accept_dialog",
      label: "Accept JS dialog",
      description: "Accept the current webpage alert/confirm/prompt (optional promptText). Returns accepted:false when none. Does NOT click browser permission/device prompts. Confirm/prompt is not business authorization for dangerous ops.",
      parameters: Type.Object({
        promptText: Type.Optional(Type.String({ maxLength: 4000 })),
      }),
      execute: async (_id, params) => {
        const data = (await call("accept_dialog", params)) as ToolContract["accept_dialog"]["data"];

        return textResult(data.accepted ? `Accepted ${data.dialog?.type ?? "dialog"}.` : "No JS dialog to accept.", data);
      },
    }),

    defineTool({
      name: "dismiss_dialog",
      label: "Dismiss JS dialog",
      description: "Dismiss/cancel the current webpage JS dialog. Returns dismissed:false when none. Not for OS permission prompts.",
      parameters: Type.Object({}),
      execute: async (_id) => {
        const data = (await call("dismiss_dialog", {})) as ToolContract["dismiss_dialog"]["data"];

        return textResult(data.dismissed ? `Dismissed ${data.dialog?.type ?? "dialog"}.` : "No JS dialog to dismiss.", data);
      },
    }),

    defineTool({
      name: "file_chooser_set_files",
      label: "Set file chooser files",
      description: "After arm_event(filechooser)+click+wait_event, set authorized files on the intercepted chooser. Paths must be this-task grants (same ledger as upload_file). Receipt may include an immediate JS dialog.",
      parameters: Type.Object({
        chooserId: Type.String({ minLength: 3, maxLength: 80 }),
        paths: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { minItems: 0, maxItems: 8 }),
      }),
      execute: async (_id, params) => {
        const data = (await call("file_chooser_set_files", params)) as ToolContract["file_chooser_set_files"]["data"];
        const list = data.files.map(f => `${f.name} (${f.size} B)`).join(", ") || "(cleared)";
        const dialog = data.dialog ? ` Dialog opened: ${data.dialog.type} — ${data.dialog.message}` : "";

        return textResult(`Chooser set files: ${list}.${dialog}`, data);
      },
    }),

    defineTool({
      name: "download_save_as",
      label: "Save download",
      description: "After wait_event(download), wait for the page-generated download to finish and copy it to an absolute path (creates parents). Not fetch(GET). Requires the downloadId from wait_event.",
      parameters: Type.Object({
        downloadId: Type.String({ minLength: 3, maxLength: 80 }),
        path: Type.String({ minLength: 2, maxLength: 1024, description: "Absolute destination path" }),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 120000 })),
      }),
      execute: async (_id, params) => {
        const data = await hostDownloadSaveAs({
          downloadId: params.downloadId,
          path: params.path,
          timeoutMs: params.timeoutMs,
          stat: async () => call("download_stat", { downloadId: params.downloadId }) as Promise<DownloadStatLike>,
        });

        return textResult(`Saved download to ${data.path} (${data.bytes} B).`, data);
      },
    }),

    defineTool({
      name: "download_cancel",
      label: "Cancel download",
      description: "Cancel an in-progress page download by downloadId from wait_event.",
      parameters: Type.Object({
        downloadId: Type.String({ minLength: 3, maxLength: 80 }),
      }),
      execute: async (_id, params) => {
        const data = (await call("download_cancel", params)) as ToolContract["download_cancel"]["data"];

        return textResult(`Cancelled download ${data.downloadId}.`, data);
      },
    }),

    defineTool({
      name: "download_delete",
      label: "Delete download artifact",
      description: "Delete the round-local temp download directory after saveAs (or to discard).",
      parameters: Type.Object({
        downloadId: Type.String({ minLength: 3, maxLength: 80 }),
      }),
      execute: async (_id, params) => {
        const before = (await call("download_stat", params).catch(() => null)) as DownloadStatLike | null;
        const data = (await call("download_delete", params)) as ToolContract["download_delete"]["data"];

        if (before?.downloadPath) hostDownloadDeleteTemp(before.downloadPath);

        return textResult(`Deleted download artifact ${data.downloadId}.`, data);
      },
    }),

    defineTool({
      name: "fill",
      label: "Fill",
      description:
        "Replace the entire value of an input, textarea, contenteditable rich-text editor, or native select in the working tab (works with controlled components). For a copied field, use the complete fieldValues value returned by task_goals/capture_page_material in ONE fill call, including any requested newline and source URL. No prior focus click is needed. For a dropdown, pass the visible option label (for example 杭州), not a click. Do not open the system picker. target accepts the same locator forms as click.",
      parameters: Type.Object({
        target: Type.String({ description: '"@N" ref, "loc=css:..." locator, or raw CSS selector' }),
        value: Type.String({ description: "Value to set" }),
      }),
      execute: async (_id, params) => {
        const data = (await call("fill", params)) as ToolContract["fill"]["data"];

        return textResult(`Filled ${params.target}.`, data);
      },
    }),

    defineTool({
      name: "type_text",
      label: "Type text",
      description: "Type text as real keyboard input into the currently focused element of the working tab.",
      parameters: Type.Object({
        text: Type.String({ description: "Text to type" }),
      }),
      execute: async (_id, params) => {
        const data = (await call("type_text", params)) as ToolContract["type_text"]["data"];

        return textResult(`Typed ${params.text.length} character(s).`, data);
      },
    }),

    defineTool({
      name: "press_key",
      label: "Press key",
      description: "Press a key in the working tab, e.g. Enter, Tab, Escape, ArrowDown, or combos like Control+A.",
      parameters: Type.Object({
        key: Type.String({ description: 'Key name or combo, e.g. "Enter", "Tab", "Control+A"' }),
      }),
      execute: async (_id, params) => {
        const data = (await call("press_key", params)) as ToolContract["press_key"]["data"];

        return textResult(`Pressed ${params.key}.`, data);
      },
    }),

    defineTool({
      name: "scroll",
      label: "Scroll",
      description:
        "Scroll the working tab by dy pixels (positive = down) or jump to the bottom. Re-snapshot afterwards to see new content.",
      parameters: Type.Object({
        dy: Type.Optional(Type.Number({ description: "Pixels to scroll, positive down" })),
        toBottom: Type.Optional(Type.Boolean({ description: "Scroll to the very bottom" })),
      }),
      execute: async (_id, params) => {
        const data = (await call("scroll", params)) as ToolContract["scroll"]["data"];

        return textResult(data.atBottom ? "Scrolled; reached the bottom." : "Scrolled.", data);
      },
    }),

    defineTool({
      name: "fetch",
      label: "Fetch URL with the browser's login state",
      description:
        "Fetch a URL with the browser's logged-in state (cookies), without touching the page. Only GET and POST; local/private addresses are refused. Use it to read structured data through the site's own API instead of scraping a snapshot: fields keep the site's real names. Large responses (>4000 chars) are saved under ~/.sideagent/downloads/ and only a status line plus a short preview enters the context; pass savePath to choose the file name. For a numeric page range use pages:{from,to,step?} with a {page} placeholder in the url (or POST body): one call fetches the pages in order, saves one file per page, and returns a compact receipt with only the first page's preview. pages is a companion-process feature of this tool only; inside browser_run, call browser.fetch once per page and combine the results in the program. The saved file is the user's own data and is not redacted; anything shown in context is treated as untrusted page content.",
      parameters: Type.Object({
        url: Type.String({ description: "Full http(s) URL, including query parameters; use {page} as the page placeholder" }),
        method: Type.Optional(Type.Union([Type.Literal("GET"), Type.Literal("POST")], { description: "Default GET" })),
        headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Extra request headers; Cookie is set by the browser" })),
        body: Type.Optional(Type.String({ description: "POST body (string); {page} is substituted here too" })),
        savePath: Type.Optional(Type.String({ description: "File name under ~/.sideagent/downloads/ (no directories); with pages it is the base name and -p<page> is inserted before the extension" })),
        pages: Type.Optional(Type.Object({
          from: Type.Integer({ description: "First page number" }),
          to: Type.Integer({ description: "Last page number (inclusive)" }),
          step: Type.Optional(Type.Integer({ description: "Page step, default 1; at most 20 pages per call" })),
        }, { description: "Fetch a numeric page range in one call; requires {page} in url or body" })),
      }),
      execute: async (_id, params) => {
        const grantArtifact = (path: string) => {
          execution?.uploadLedger?.grant({ path, source: "task_artifact" });
        };

        if (params.pages) {
          const batch = await fetchPages(
            { url: params.url, method: params.method, headers: params.headers, body: params.body, savePath: params.savePath, pages: params.pages },
            (request) => call("fetch", request) as Promise<FetchReply>,
          );

          for (const path of batch.data.saved) grantArtifact(path);

          return textResult(wrapPageContent(batch.text, { url: params.url }), batch.data);
        }

        const data = (await call("fetch", params)) as ToolContract["fetch"]["data"];

        return textResult(formatFetchReply(data as FetchReply, params.savePath, undefined, true, grantArtifact), data);
      },
    }),

    defineTool({
      name: "network",
      label: "Observed network requests",
      description:
        "List the recent network requests the working tab actually made (passive CDP recording while the extension observes the tab): method, URL, status, resource type, size and duration. Use it to find the site's own JSON API before scraping the DOM, then call fetch on that URL with the browser's login state. Defaults to API-like requests (xhr/fetch); pass types:\"all\" for documents, scripts, images and the rest. Recorded per tab, survives navigation and keeps going while the debugger is attached; the buffer is memory-only and empty after the extension restarts. No bodies, headers or cookies are recorded. Use clear:true before triggering the action you want to observe, then read again.",
      parameters: Type.Object({
        urlContains: Type.Optional(Type.String({ description: "Only show URLs containing this text (case-insensitive)" })),
        types: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Literal("all")], { description: "Resource types to show; default xhr/fetch, 'all' for everything" })),
        limit: Type.Optional(Type.Number({ description: "Show at most the last N matches (default 40, max 200)" })),
        tabId: Type.Optional(Type.Number({ description: "Tab to read without claiming or switching it" })),
        clear: Type.Optional(Type.Boolean({ description: "Empty this tab's buffer first, then report the clear" })),
      }),
      execute: async (_id, params) => {
        const data = (await call("network", params)) as ToolContract["network"]["data"];

        return textResult(wrapPageContent(redactCredentialText(data.text), { tabId: data.tabId }), data);
      },
    }),

    defineTool({
      name: "js",
      label: "Run JavaScript",
      description:
        "Evaluate a JavaScript expression in the working tab and get its value. Invoke functions explicitly: (() => { return document.title; })(). A bare () => {...} only creates a function and does not execute its body. Prefer one invoked IIFE that extracts everything you need over multiple round trips.",
      promptGuidelines: ["Wrap code in a single IIFE that returns a JSON-serializable value."],
      parameters: Type.Object({
        code: Type.String({ description: "JavaScript to evaluate; use an IIFE with a return value" }),
      }),
      execute: async (_id, params) => {
        const data = (await call("js", params)) as ToolContract["js"]["data"];

        const rendered = data.value === undefined
          ? "JavaScript returned undefined. No observable value was returned; this does not confirm a page change. For extraction, use one IIFE with an explicit return of JSON-serializable findings. For hover-only controls, use hover, then observe the page."
          : wrapPageContent(redactCredentialText(truncate(typeof data.value === "string" ? data.value : JSON.stringify(data.value, null, 2), MAX_JS_RESULT_CHARS)));

        return textResult(rendered, data);
      },
    }),

    defineTool({
      name: "mark",
      label: "Mark elements",
      description:
        "Draw or clear annotations on the working tab. Draw: a persistent hand-drawn outline + optional label on target (\"look here\", highlights). One thing gets one mark: pick the single ref that best identifies it (for a name/value pair such as 五小时用量 32%, the value) and do not add a second mark on its adjacent label; overlapping marks look like a scribble. Use refs already in the snapshot; do not search for a wrapping container. For irreversible confirmation, pass actions: the cursor flies over and grabs the element, and the user clicks 删除/取消 on the cursor's name pill instead of only typing in the sidebar. The mark is anchored to the document, so it stays on its target when the user scrolls. target accepts the same locator forms as click. Marks persist until cleared or page navigation (clear:true removes all marks). Prefer the specific content ref from the latest snapshot (text refs mark the text bounds). Do not infer CSS sibling positions from snapshot order. Never use body/html as a placeholder for an object.",
      parameters: Type.Object({
        target: Type.Optional(Type.String({ description: '"@N" ref, "loc=css:..." locator, or raw CSS selector; required unless clear is true' })),
        label: Type.Optional(Type.String({ description: "Short label shown next to the mark, e.g. 待删除" })),
        actions: Type.Optional(
          Type.Array(
            Type.Object({
              id: Type.Union([Type.Literal("confirm"), Type.Literal("cancel")]),
              label: Type.String({ description: "Button text, e.g. 删除 / 取消" }),
            }),
            { maxItems: 2, description: "Confirm/cancel buttons shown on the cursor's name pill while it holds the marked element (draw only)" },
          ),
        ),
        clear: Type.Optional(Type.Boolean({ description: "true clears every mark on the page instead of drawing; no target needed" })),
      }),
      execute: async (_id, params) => {
        if (params.clear === true) {
          const data = (await call("clear_marks", {})) as ToolContract["clear_marks"]["data"];

          return textResult("All marks cleared.", data);
        }

        if (typeof params.target !== "string" || !params.target.trim()) throw new Error("mark 需要 target；只想清除标注时传 clear:true。");
        const data = (await call("mark", { target: params.target, label: params.label, actions: params.actions })) as ToolContract["mark"]["data"];

        return textResult(`Marked ${params.target}.`, data);
      },
    }),

    defineTool({
      name: "screenshot",
      label: "Screenshot",
      description:
        "Capture a real screenshot of the working tab. clip uses DOCUMENT CSS coordinates; click point uses VIEWPORT CSS coordinates. Convert image pixels using coordinates: point = imagePixel / pixelsPerCssPixel + origin - scroll. Reobserve if document, viewport or scrolling changed; never click from an image with unknown coordinates. fullPage captures the document; scale:css outputs CSS pixels and scale:raw device pixels. An explicit clip.scale overrides the scale mode. A visible-tab fallback is honestly labeled raw, never a fabricated image. Prefer snapshot when it provides the needed information.",
      parameters: Type.Object({
        fullPage: Type.Optional(Type.Boolean()),
        clip: Type.Optional(
          Type.Object({
            x: Type.Number(),
            y: Type.Number(),
            width: Type.Number({ exclusiveMinimum: 0 }),
            height: Type.Number({ exclusiveMinimum: 0 }),
            scale: Type.Optional(Type.Number()),
          }),
        ),
        scale: Type.Optional(Type.Union([Type.Literal("css"), Type.Literal("raw")])),
      }),
      execute: async (_id, params) => {
        const data = (await call("screenshot", params)) as ToolContract["screenshot"]["data"];

        const geometry =
          data.cssWidth > 0
            ? ` Image pixels ${data.pixelWidth}x${data.pixelHeight}; capture CSS ${data.cssWidth}x${data.cssHeight}; actual scale=${data.scale ?? "custom"}. Coordinate mapping: ${JSON.stringify(data.coordinates ?? null)}. Convert image pixel to viewport point using density + origin - scroll; do not confuse clip/document coordinates with viewport coordinates.`
            : ` Image pixels ${data.pixelWidth}x${data.pixelHeight} (CSS size unknown; do not convert coordinates from this image).`;

        return {
          content: [
            {
              type: "text" as const,
              text: `Screenshot of working tab ${data.tabId} (${data.title || "(untitled)"} — ${data.url}) via ${data.source}.${geometry}`,
            },
            { type: "image" as const, data: data.imageBase64, mimeType: data.mediaType },
          ],
          details: data,
        };
      },
    }),
  ];

  const definitions = makeDefinitions(call, undefined);

  return execution ? definitions.map(tool => ({ ...tool, execute: async (...args: Parameters<ToolDefinition["execute"]>) => {
    rpc.ensureToolCall?.(args[0], tool.name as ToolName, sid);
    // 本次执行用绑定了自己身份的一份工具定义；定义内部没有跨调用的状态（2026-09-24 核对）。
    const scope: ExecutionScope = {epoch: execution.epoch(), toolCallId: args[0], signal: args[2]};
    const scoped = makeDefinitions(makeCall(scope), scope).find(candidate => candidate.name === tool.name) ?? tool;

    try {
      return await (scoped as ToolDefinition).execute(...args);
    } catch (error) {
      const fact = error && typeof error === "object" && "executionFact" in error
        ? (error as { executionFact?: import("../../shared/protocol.js").ToolExecutionFact }).executionFact
        : undefined;

      if (fact) rpc.noteToolFact?.(args[0], fact);
      else rpc.markCallRejected?.(args[0]);
      throw error;
    }
  } })) : definitions;
}
