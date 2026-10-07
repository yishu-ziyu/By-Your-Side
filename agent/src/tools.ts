import { runPageTranslation, type TranslateBatch } from "./page-translation.js";
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
import { redactCredentialText, wrapPageContent } from "../../shared/untrusted.js";
import { isLeadSession, type TabInfo, type ToolContract, type ToolName } from "../../shared/protocol.js";
import { FOREIGN_TAB_ERROR, WRITE_TOOLS } from "../../shared/control.js";
import { plainDownloadError } from "../../shared/user-facing.js";
import { requiresControlGate } from "../../shared/effect-policy.js";
import { RepeatRefusedError } from "../../shared/task-next-step.js";
import type { ToolRpc } from "./rpc.js";
import { runBrowserProgram, availableProgramHelpers, availableRpcAliases, type ProgramStep } from "./browser-program.js";
import { assertArtifactFilename, saveFileFromProgram, type ArtifactStore } from "./artifacts-tool.js";

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

/**
 * 页面下载的回执：只有 chrome.downloads 报 complete 才写「已保存」。
 * 中断直接报错，让这一步如实显示失败；还在下载就说还没下完。
 */
function downloadReceipt(download: Omit<NonNullable<ToolContract["wait_event"]["data"]["download"]>, "path"> & { path?: string | null }): string {
  const name = download.suggestedFilename || download.url;

  if (download.completed && download.path) {
    return `Download complete, confirmed by Chrome's downloads API: "${name}" saved to ${download.path}${download.bytes !== undefined ? ` (${download.bytes} B)` : ""}.`;
  }

  if (download.failure) {
    // Chrome 的错误码留在回执数据里供排查；给模型的是人话原因，它照着对用户说时不会念出错误码。
    throw new Error(`Download failed for "${name}": ${plainDownloadError(download.failure)}. No complete file was saved.`);
  }

  if (download.danger) {
    return `Download of "${name}" is on hold: Chrome flagged it as ${download.danger} and it stays unsaved until the user chooses Keep in Chrome's downloads. Not saved yet.`;
  }

  return `Download of "${name}" started but Chrome has not reported it finished yet (downloadId ${download.downloadId}). It is not saved yet.`;
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
  // disarm_event 只在 browser_run 里组合使用，没有单独的模型工具；它和 arm_event 同属事件订阅，随 arm_event 启停。
  // 缺这条映射时它永远算「未启用」，通用页面 JS 在所有模式下都被拒（docs/evals/20260925-sitegeist-parity.md）。
  disarm_event: "arm_event",
  // worker_tabs 是扩展侧 RPC 名；模型可见的入口是常驻的 take_tab。
  worker_tabs: "take_tab",
};

export const modelToolOf = (rpcName: string): string => MODEL_TOOL_OF[rpcName] ?? rpcName;

/** 一次工具执行的身份：call 据此绑定轮次闸门、SDK 调用 ID 和停止信号。 */
interface ExecutionScope { epoch: number; toolCallId: string; signal?: AbortSignal }

/** 用户插话后，旧计划里还没执行的一步被作废时的工具结果。宿主据此知道这一步没碰页面。 */
export const STALE_STEP_MESSAGE = "用户已补充或改变要求，旧步骤未执行。请读取最新用户输入并重新核对目标后继续；原任务尚未交付的结果仍需完成。";

export function createBrowserTools(rpc: ToolRpc, sessionId?: string, takeTab?: (tabId?: number) => Promise<unknown>, canExecute?: (name: ToolName) => boolean, execution?: { epoch: () => number; canWrite: (toolCallId?: string) => boolean; /** 占着这页的旧会话已空闲时接手它；返回是否已接手。 */ releaseIdleTab?: (tabId?: number) => Promise<boolean>; assertCall?: (name: string, params: Record<string, unknown>, toolCallId?: string) => void; onStep?: (step: ProgramStep) => void;  /** 本会话文件区（与 artifacts 同一份），给 browser.saveFile；不传则程序里没有 saveFile，调用时返回 undefined 表示这个会话没有文件区。 */ files?: () => ArtifactStore | undefined }, translateBatch?: TranslateBatch): ToolDefinition[] {
  const sid = sessionId && !isLeadSession(sessionId) ? sessionId : undefined;
  const files = execution?.files;
  const programHelpers = availableProgramHelpers({ saveFile: !!files });

  /** screenshot forUser：把这张图存进本会话文件区，侧栏显示成回答里的图片卡片；做不到时如实告诉模型用户没看到。 */
  const deliverScreenshot = async (base64: string): Promise<string> => {
    const store = files?.();

    if (!store) return " NOT shown to the user: this conversation cannot show images in the side panel. Tell the user you could not send the picture.";

    try {
      const { filename } = store.saveImage(base64);
      await store.flush?.();

      return ` Shown to the user in the side panel as image ${filename} (they can enlarge and download it).`;
    } catch (error) {
      return ` NOT shown to the user: ${error instanceof Error ? error.message : String(error)}`;
    }
  };

  // 通用 page JS 能绕过任何单个写工具的禁用，因此在写能力不完整时整体拒绝。
  // 依赖集合复用 WRITE_TOOLS（按模型可见名去重）；每次问真实 canExecute，不看 JS 内容或提示词。
  const unavailableWriteTools = (): ToolName[] =>
    canExecute ? [...new Set(WRITE_TOOLS.map((name) => modelToolOf(name)))].filter((name) =>
      !canExecute(name as ToolName)) as ToolName[] : [];

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
    // 进入这一步时的执行闸门状态。
    const staleStep = () => gated && (!execution!.canWrite(scope?.toolCallId) || epoch !== execution!.epoch());

    if (staleStep()) {
      rejectCall();
      throw new Error(STALE_STEP_MESSAGE);
    }

    const callParams = rpc.resolvePageParams?.(name, params, sid) ?? params;

    const assertCall = (target: Record<string, unknown>) => {
      try {
        execution?.assertCall?.(name, target, sdkId);
      } catch (error) {
        if (error instanceof RepeatRefusedError && sdkId) rpc.markCallRepeatRefused?.(sdkId);
        else rejectCall();
        throw error;
      }
    };

    assertCall(callParams);

    if (name === "js") {
      try { assertGenericJsAllowed(); }
      catch (error) { if (sdkId) rpc.markCallRejected?.(sdkId); throw error; }
    }

    // dialog_info 没有模型可见工具，只由 browser_run 的 pageInfo 组合调用；它只读，不受工具开关限制。
    if (canExecute && name !== "dialog_info" && !canExecute(modelToolOf(name) as ToolName)) {
      if (sdkId) rpc.markCallRejected?.(sdkId);
      throw new Error(`工具 ${modelToolOf(name)} 当前未启用，操作未执行`);
    }

    if (!sid && takeTab && (name === "switch_tab" || name === "close_tab")) {
      await takeTab(typeof callParams.tabId === "number" ? callParams.tabId : undefined);
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

    return invokeReleasingIdleOwner(gated ? epoch : undefined);
  };

  return call;
  };

  const call = makeCall(undefined);
  /** 导航后的只读补读：不带调用身份，避免与导航本身的执行事实混在一起。 */
  const readAfterNavigate = call;

  const makeDefinitions = (call: ReturnType<typeof makeCall>, _scope: ExecutionScope | undefined) => [
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
        // 时限按进度判断（runPageTranslation 内的看门狗），不再固定 240 s 一刀切。
        const result = await runPageTranslation(params as TranslationRequest,
          async command => await call('page_translation', {...command}) as TranslationReceipt,
          translateBatch ?? (async () => { throw new Error('当前会话的翻译模型不可用。'); }), signal ?? new AbortController().signal,
          // Only removes our own placeholders: outside the step gate and the task ledger, so it still runs after a stop.
          {settle: async command => { await rpc.call('page_translation', {...command}, 5_000, sid); }});

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
        const stateOnly = params.properties?.some(property=>property==='textContent')&&data.editableText!==undefined ? { tabId: data.tabId, target: data.target, tagName: data.tagName, properties: data.properties, check: data.check, editableText: data.editableText } : { tabId: data.tabId, target: data.target, tagName: data.tagName, properties: data.properties, check: data.check };
        // A value check on a range input keeps the allowed range and the browser's verdict beside it.
        const projected = params.properties?.length || params.expect ? (data.inputRange ? { ...stateOnly, inputRange: data.inputRange } : stateOnly) : data;

        return textResult(wrapPageContent(redactCredentialText(JSON.stringify(projected)), { tabId: data.tabId }), data);
      },
    }),
    defineTool({
      name: "read_elements",
      label: "Read matching elements",
      description: "Host-only, bounded readback of EVERY current element matching a native CSS selector, without changing the page: text, visibility, position and computed style for each match, plus total/truncated counts. Each match carries target, a locator for that one element: pass it to click/mark/read_element instead of the shared selector, which matches them all. Use to verify page-wide annotation/highlight/marking state that a single read_element cannot cover; the host reads this directly, it is never a model claim.",
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
      description: 'Run an async JavaScript program that drives the browser tools through the browser object; it has no page globals (no window, document, fetch, Blob, setTimeout, Node or require), so page code goes inside browser.js({code:"..."}). Its methods use the SAME object parameters and return raw data from the regular tools: snapshot()->{text}, js({code})->{value}, hover/click({target or point}), fill({target,value}), and the other browser tools; browser.doubleClick({target|point}) is also available. Composed helpers: ' + programHelpers.map(h => h.name).join(", ") + ' (host-implemented, no new RPC).' + (files ? ' browser.saveFile({filename, content}) saves text the program already holds as a file in this conversation (same file list and side-panel card as the artifacts tool; same filename rule, 256000-character limit; saving the same name overwrites it) and returns only {filename, chars, lines, overwritten}. For large data you obtained with tools (page or API extraction longer than a few thousand characters), build the CSV/JSON/text inside the program and save it with browser.saveFile instead of returning it and retyping it through artifacts; return just the receipt and a short summary such as the row count.' : '') + ' camelCase aliases: ' + availableRpcAliases().join(", ") + '. browser.waitFor({selector,timeoutMs:5000}) waits for one visible enabled target (@ref / CSS / xpath= / text=); browser.sleep({ms}) waits up to 10000ms. Use await for every operation and return JSON-serializable evidence. For one known action on a page you have not read yet, fold the observation into this same program (snapshot → pick the target → click → read back) instead of spending a separate round on snapshot. Prefer this for a known sequence with conditions/waits; observe first when targets are unknown. Page JavaScript belongs inside browser.js({code:"..."}). A takeover or cancellation stops the entire program even if caught. Do not bypass user control with page JS.',
      parameters: Type.Object({
        code: Type.String({ description: 'Async function body; await browser methods and return concise evidence. Example: await browser.hover({target:"#card"}); await browser.waitFor({selector:"#edit"}); await browser.click({target:"#edit"}); return (await browser.snapshot()).text;' }),
        label: Type.Optional(Type.String({ description: "Short user-facing goal for this sequence" })),
      }),
      execute: async (id, params, signal, onUpdate) => {
        // 组合调用一旦开始，整体结果就不再是“确定未执行”。
        rpc.noteToolFact?.(id, "unknown");

        const result = await runBrowserProgram({ code: params.code,
          call: (name, args, stepId, origin) => call(name, args, id, stepId, origin), signal, id,
          saveFile: files ? async (args) => {
            const store = files();

            if (!store) throw new Error("这个会话没有文件区，saveFile 不可用，未保存。");

            const receipt = saveFileFromProgram(store, args);
            await store.flush?.();

            return receipt;
          } : undefined,
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
      description: "Navigate the working tab to a URL and wait for the new document to be interactive. When the document is ready, the result already contains a fresh full-page snapshot of the new page (same format and refs as snapshot), so act on it directly instead of taking another snapshot. Readiness timeout is not confirmed navigation success; then verify the URL and take a snapshot before acting.",
      parameters: Type.Object({
        url: Type.String({ description: "Absolute URL" }),
        timeout: Type.Optional(Type.Number({ description: "Load timeout in seconds" })),
      }),
      execute: async (_id, params) => {
        const data = (await call("navigate", params)) as ToolContract["navigate"]["data"];
        const head = `Navigation result: ${data.url} — ${data.title}; document: ${data.readiness ?? "not checked"}`;

        if (data.readiness === "timeout") return textResult(head, data);

        // 新页面就绪后顺手读一次，省掉模型专门再花一轮调 snapshot。读页不挂在本次导航的调用身份下（同预观察），失败只退回原结果。
        try {
          const page = (await readAfterNavigate("snapshot", {})) as ToolContract["snapshot"]["data"];

          return textResult(`${head}\n\nFresh snapshot of the new page (no separate snapshot needed):\n${wrapPageContent(redactCredentialText(page.text), { tabId: page.tabId })}`, { ...data, page });
        } catch {
          return textResult(head, data);
        }
      },
    }),

    defineTool({
      name: "snapshot",
      label: "Snapshot",
      description:
        "Read a tab as indented text. Main can pass any tabId without taking control; omit tabId for the working tab. Workers can read only assigned tabs. scope=full_page (default): the real CDP accessibility tree (covers shadow DOM and virtualized content); rendered content (including headings, text, images and controls) carries [ref=N] when backed by a DOM node (= backendDOMNodeId, CDP path). scope=viewport: a viewport-only simplified DOM snapshot (downgrade, not the full AX tree); its refs are DOM snapshot numbers valid only via the DOM path — do not mix them with older AX refs. This is your primary way to observe the page.",
      promptGuidelines: [
        "Take a snapshot after actions that change the page; navigate already returns a fresh snapshot of the new page.",
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

        const dialog = "dialog" in data ? data.dialog : undefined;

        // 点击弹出了原生对话框：点击已送达，页面在等对话框（读页会卡住），先接受或取消它。
        if (dialog) {
          return textResult(`Clicked ${what}. The page opened a native ${dialog.type} dialog; its text: ${wrapPageContent(dialog.message.slice(0, 500))}\nThe page is blocked until it is handled; use accept_dialog (promptText for a prompt) or dismiss_dialog as the user asked, then observe the page.`, data);
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
      description: 'Double-click an element in the working tab using REAL browser input (CDP clickCount 1→2), never synthetic DOM events. Provide target ("@N" ref, "loc=css:...", raw CSS, xpath=..., text=...) or point [x,y]. The result reports effect evidence when measurable and explicitly says when only input dispatch is confirmed.',
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

        if ("dialog" in data && data.dialog) return textResult(`${data.doubleClicked ? "Native double-click input dispatched" : "Double-click interrupted before its full input sequence"}; the page opened a native ${data.dialog.type}: ${data.dialog.message}. The dialog type and message are given here; use accept_dialog or dismiss_dialog as the user asked (browser.pageInfo() in browser_run also reports a pending dialog).`, data);

        const effectText = formatEffectReport("effect" in data ? data.effect : undefined);
        const opened = "newTab" in data ? data.newTab : undefined;
        const newTabText = opened ? ` A new tab opened (tab ${opened.tabId}${opened.url ? `, ${opened.url}` : ""}) and it is now your working tab; observe it before continuing.` : "";

        if (effectText) return textResult(`Double-clicked ${what}.${effectText}${newTabText}`, data);

        return textResult(`Double-clicked ${what}. This confirms native input dispatch only; observe the page to verify the intended change before reporting success.${newTabText}`, data);
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
      name: "arm_event",
      label: "Arm page event",
      description: 'Arm popup/download/filechooser BEFORE the triggering action. Returns a host-issued token (never invent tokens). Pattern: arm_event → click/action → wait_event(token). Required for ephemeral popups, page downloads, and dynamic file inputs. To download a file the page offers: arm_event(download) → click the download link or button on the page → wait_event; Chrome saves it into the download folder of the user. Do not use fetch to fake a page download. Prefer browser_run helpers armEvent/waitEvent when composing multi-step scripts.',
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
      description: "Consume a previously armed host token. Fails on forged/expired tokens. One-shot. For a download it then waits (up to 60 s, or timeoutMs if longer) until Chrome's downloads API reports the file complete or interrupted; only a completed receipt means the file was saved.",
      parameters: Type.Object({
        token: Type.String({ minLength: 8, maxLength: 120 }),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 120000 })),
      }),
      execute: async (_id, params) => {
        const data = (await call("wait_event", params)) as ToolContract["wait_event"]["data"];

        if (data.download) return textResult(downloadReceipt(data.download), data);

        return textResult(`Event ${data.type} matched for token ${data.token}.`, data);
      },
    }),

    defineTool({
      name: "accept_dialog",
      label: "Accept JS dialog",
      description: "Accept the current webpage alert/confirm/prompt (optional promptText). Returns accepted:false when none. Does NOT click browser permission/device prompts.",
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
      name: "download_url",
      label: "Download link",
      description: "Save a user's requested HTTP(S) file link into Chrome's download folder, including a PDF currently open in Chrome's reader. Opening the PDF is not downloading it. Only completed=true confirms it was saved; if completed is not true, the save is unconfirmed: tell the user, never start another download. Chrome decides safety; do not bypass danger holds.",
      parameters: Type.Object({ url: Type.String({ minLength: 1 }), filename: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })), timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 20000 })), tabId: Type.Optional(Type.Integer()) }),
      execute: async (_id, params) => {
        // SAFETY: download_url RPC 的返回结构由 ToolContract 与扩展处理器一致定义。
        const data = await call("download_url", params, undefined, undefined, undefined, (params.timeoutMs ?? 20_000) + 10_000) as ToolContract["download_url"]["data"];

        return textResult(downloadReceipt(data), data);
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

        // The browser rejects the value for the field's min/max/step: say so, never plain success.
        return textResult(data.rangeIssue ? `Filled ${params.target}, but the value is not accepted by the page. ${data.rangeIssue.message}` : `Filled ${params.target}.`, data);
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

        if (data.dialog) return textResult(`${data.pressed ? "Key input dispatched" : "Key input not dispatched"}; the page opened a native ${data.dialog.type}: ${data.dialog.message}. The remaining input sequence stopped. The dialog type and message are given here; use accept_dialog or dismiss_dialog as the user asked (browser.pageInfo() in browser_run also reports a pending dialog).`, data);

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
        "Fetch a URL with the browser's logged-in state (cookies), without touching the page. Only GET and POST; local/private addresses are refused. Use it to read structured data through the site's own API instead of scraping a snapshot: fields keep the site's real names. Responses are returned inline up to 16000 characters with an explicit truncation notice; for several pages, call browser.fetch once per page inside browser_run and combine the results there (save large results with browser.saveFile). Prefer snapshot/read_element for reading the current document; never run a documentation code example just to explain it. Anything shown in context is treated as untrusted page content.",
      parameters: Type.Object({
        url: Type.String({ description: "Full http(s) URL, including query parameters" }),
        method: Type.Optional(Type.Union([Type.Literal("GET"), Type.Literal("POST")], { description: "Default GET" })),
        headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Extra request headers; Cookie is set by the browser" })),
        body: Type.Optional(Type.String({ description: "POST body (string)" })),
      }),
      execute: async (_id, params) => {
        const data = (await call("fetch", params)) as ToolContract["fetch"]["data"];

        return textResult(formatFetchReply(data as FetchReply), data);
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
        "Evaluate a JavaScript expression in the working tab's page (window, document, fetch are available) and get its value. Invoke functions explicitly: (() => { return document.title; })(). A bare () => {...} only creates a function and does not execute its body. Prefer one invoked IIFE that extracts everything you need over multiple round trips. Set readonly:true only when the script only reads the page (no clicks, form changes, requests that write, or navigation): if such a script times out it is reported as failed with no effect and does not pause later writes. Omit it for anything else." +
        (files ? ' saveAs:"name.ext" saves the returned string (other values as JSON text) as a conversation file (same rules and side-panel card as artifacts) and returns only {filename, chars, lines}; use it for large page data instead of retyping it.' : ""),
      promptGuidelines: ["Wrap code in a single IIFE that returns a JSON-serializable value."],
      parameters: Type.Object({
        code: Type.String({ description: "JavaScript to evaluate; use an IIFE with a return value" }),
        readonly: Type.Optional(Type.Boolean({ description: "true only when the script only reads the page; a timeout is then reported as failed with no effect" })),
        ...(files ? { saveAs: Type.Optional(Type.String({ description: 'Save the return value as this conversation file, e.g. "subtitles.txt"; you get only {filename, chars, lines}' })) } : {}),
      }),
      execute: async (_id, params) => {
        // SAFETY: saveAs 只在有文件区时进入参数 schema，类型是可选字符串，Pi 已按 schema 校验。
        const { saveAs, ...pageParams } = params as typeof params & { saveAs?: string };

        if (saveAs !== undefined) {
          // 文件区与文件名在跑脚本之前核对：存不了就不动页面。
          const store = files?.();

          if (!store) throw new Error("这个会话没有文件区，saveAs 不可用，脚本未运行。");
          assertArtifactFilename(saveAs.trim());
          const data = (await call("js", pageParams)) as ToolContract["js"]["data"];

          if (data.value === undefined || data.value === null || data.value === "") throw new Error(`脚本已运行但没有返回值，${saveAs.trim()} 没有保存。请让 IIFE 显式 return 要保存的数据。`);
          const content = typeof data.value === "string" ? data.value : JSON.stringify(data.value);
          const { filename, chars, lines } = saveFileFromProgram(store, { filename: saveAs, content });
          await store.flush?.();
          const receipt = { filename, chars, lines };

          return textResult(JSON.stringify(receipt), receipt);
        }

        const data = (await call("js", pageParams)) as ToolContract["js"]["data"];

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
        "Draw or clear annotations on the working tab. Draw: a persistent hand-drawn outline + optional label on target (\"look here\", highlights). One thing gets one mark; overlapping marks look like a scribble. When the user names a field that shows a value beside it (存储空间 → 3.2 GB), they want to see the value: pass the name ref as target and the value ref as through so one frame holds both. The same applies to any run of adjacent refs on one line. Never draw a second mark on the adjacent part. Use refs already in the snapshot; do not search for a wrapping container. For irreversible confirmation, pass actions: the cursor flies over and grabs the element, and the user clicks 删除/取消 on the cursor's name pill instead of only typing in the sidebar. The mark is anchored to the document, so it stays on its target when the user scrolls. target accepts the same locator forms as click. Marks persist until cleared or page navigation (clear:true removes all marks). Prefer the specific content ref from the latest snapshot (text refs mark the text bounds). Do not infer CSS sibling positions from snapshot order. Never use body/html as a placeholder for an object.",
      parameters: Type.Object({
        target: Type.Optional(Type.String({ description: '"@N" ref, "loc=css:..." locator, or raw CSS selector; required unless clear is true' })),
        through: Type.Optional(Type.String({ description: '"@N" ref ending a group on the same line as target (both must be snapshot refs); one frame covers target through this ref' })),
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
        const data = (await call("mark", { target: params.target, through: params.through, label: params.label, actions: params.actions })) as ToolContract["mark"]["data"];

        return textResult(`Marked ${params.target}.`, data);
      },
    }),
    defineTool({
      name: "screenshot",
      label: "Screenshot",
      description:
        "Capture a real screenshot of the working tab. clip uses DOCUMENT CSS coordinates; click point uses VIEWPORT CSS coordinates. Convert image pixels using coordinates: point = imagePixel / pixelsPerCssPixel + origin - scroll. Reobserve if document, viewport or scrolling changed; never click from an image with unknown coordinates. fullPage captures the document; scale:css outputs CSS pixels and scale:raw device pixels. An explicit clip.scale overrides the scale mode. A visible-tab fallback is honestly labeled raw, never a fabricated image. Prefer snapshot when it provides the needed information." +
        (files ? " Screenshots are for your own eyes by default: the user does not see them. Set forUser:true only when the user wants the picture itself (e.g. asks you to take or send a screenshot of the page): the image is then shown in your answer in the side panel, where the user can enlarge and download it; just refer to it, do not paste or describe the image data." : ""),
      parameters: Type.Object({
        ...(files ? { forUser: Type.Optional(Type.Boolean({ description: "true = also show this screenshot to the user as an image in the side panel (only when the user asked for the screenshot/picture)" })) } : {}),
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
      execute: async (_id, input) => {
        // forUser 是宿主自己的交付开关，不传给扩展的截图 RPC。
        const { forUser, ...params } = input as typeof input & { forUser?: boolean };
        const data = (await call("screenshot", params)) as ToolContract["screenshot"]["data"];

        const geometry =
          data.cssWidth > 0
            ? ` Image pixels ${data.pixelWidth}x${data.pixelHeight}; capture CSS ${data.cssWidth}x${data.cssHeight}; actual scale=${data.scale ?? "custom"}. Coordinate mapping: ${JSON.stringify(data.coordinates ?? null)}. Convert image pixel to viewport point using density + origin - scroll; do not confuse clip/document coordinates with viewport coordinates.`
            : ` Image pixels ${data.pixelWidth}x${data.pixelHeight} (CSS size unknown; do not convert coordinates from this image).`;

        return {
          content: [
            {
              type: "text" as const,
              text: `Screenshot of working tab ${data.tabId} (${data.title || "(untitled)"} — ${data.url}) via ${data.source}.${geometry}${forUser === true ? await deliverScreenshot(data.imageBase64) : ""}`,
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
