import { getQuickJS, type QuickJSDeferredPromise, type QuickJSHandle } from "quickjs-emscripten";
import { TOOL_NAMES, type ToolName } from "../../shared/protocol.js";
import { HOST_PAGE_PROBES } from "../../shared/effect-policy.js";
import { isSaveFileParams, rejectSaveFileParams, type SaveFileParams, type SavedFileReceipt } from "./artifacts-tool.js";

export interface ProgramStep {
  parentId: string;
  id: string;
  name: string;
  phase: "start" | "end";
  params: Record<string, unknown>;
  result?: unknown;
  error?: string;
  elapsedMs?: number;
}

/**
 * browser.assert 不成立时整个程序停在那一步。宿主拿到的是结构化结果（停在第几步、名字、原因、已完成几步），
 * 不只是一行错误文字；`steps` 是到停下为止已结束的步骤（含 assert 这一步）。
 */
export class ProgramAssertError extends Error {
  constructor(
    readonly assert: { failedAt: number; name: string; reason: string; completed: number },
    readonly steps: ProgramStep[],
  ) {
    super(`程序在第 ${assert.failedAt} 步「${assert.name}」停下${assert.reason ? `：${assert.reason}` : ""}（已完成 ${assert.completed} 步）`);
  }
}

interface ProgramOptions {
  code: string;
  call(name: ToolName, params: Record<string, unknown>, stepId?: string, origin?: "readonly-poll"): Promise<unknown>;
  signal?: AbortSignal;
  id?: string;
  timeoutMs?: number;
  onStep?(step: ProgramStep): void;
  /**
   * `browser.saveFile({filename, content})` 的宿主实现（写进本会话文件区，返回只含长度的回执）。
   * 不传 = 这个会话没有文件区，程序里没有 saveFile。
   */
  saveFile?(params: SaveFileParams): SavedFileReceipt | Promise<SavedFileReceipt>;
}

/** browser.* 的 camelCase 别名：程序里用 EGO 风格名字，账本仍记规范 RPC 名。 */
export const RPC_ALIASES: Record<string, string> = {
  doubleClick: "double_click",
  armEvent: "arm_event",
  waitEvent: "wait_event",
  disarmEvent: "disarm_event",
  consumeEvents: "consume_events",
  acceptDialog: "accept_dialog",
  dismissDialog: "dismiss_dialog",
  dialogInfo: "dialog_info",
  selectOption: "select_option",
};

/**
 * browser_run 组合 helper 的能力事实源：METHODS 白名单与 browser_run 描述文本都从这里取，
 * 防止文档与代码漂移（Issue §十）。它们在宿主内组合现有 RPC 完成，不新增 extension RPC。
 */
export const BROWSER_PROGRAM_HELPERS = [
  { name: "waitFor", summary: "等待唯一目标：state=visible|visible+enabled|attached|detached|hidden（统一 target：@ref / CSS / loc=role / loc=href / xpath= / text=）", composed: "read_element expect 轮询（只读）" },
  { name: "waitForElement", summary: "waitFor 的语义别名", composed: "waitFor" },
  { name: "check", summary: "check({text|selector,state=appears|disappears,timeoutMs=3000}) 等文字或目标出现/消失，不叫模型；返回 {ok,waitedMs,polls}，超时返回 ok:false 不抛错", composed: "read_element expect 轮询（只读）" },
  { name: "assert", summary: "assert({ok,name,reason}) 条件不成立就停下整个程序，后面的动作一个都不执行；结果带停在第几步、名字、原因、已完成几步", composed: "宿主停止路径" },
  { name: "sleep", summary: "有界等待毫秒（纯宿主，不伪造浏览器动作）", composed: "host timer" },
  { name: "pageInfo", summary: "url/title/readyState/视口/滚动/工作页/未处理 JS dialog（身份一致才返回）", composed: "list_tabs + js + dialog_info" },
  { name: "waitForLoad", summary: "等当前文档的 domcontentloaded / load 就绪", composed: "js(document.readyState+timeOrigin)" },
  { name: "waitForNetworkIdle", summary: "纳入范围的在途请求为 0 且持续静默；捕获不完整不冒充空闲（≠业务完成）", composed: "network 在途集合轮询" },
  { name: "scrollToBottomUntil", summary: "滚动直到条件成立或到底", composed: "scroll + read_element / js 条件" },
  { name: "armEvent", summary: "触发前订阅 popup/download/filechooser；返回宿主 token（串行队列不阻塞）", composed: "arm_event" },
  { name: "waitEvent", summary: "消费已 arm 的 token；须先 arm 再动作再 wait", composed: "wait_event" },
  { name: "disarmEvent", summary: "取消尚未消费的 arm", composed: "disarm_event" },
  { name: "consumeEvents", summary: "读清本页缓冲事件", composed: "consume_events" },
  { name: "saveFile", summary: "saveFile({filename,content,deliver?}) 把程序手上的文本存成本会话文件（与 artifacts 同一文件区；deliver 为真才有侧栏卡片），返回 {filename,chars,lines,overwritten,shown}，内容不回到上下文", composed: "宿主会话文件区" },
] as const;

/** saveFile 只在宿主接了本会话文件区时列；描述与白名单都从这里取。 */
export function availableProgramHelpers(offer: { saveFile: boolean }) {
  return BROWSER_PROGRAM_HELPERS.filter(h => h.name !== "saveFile" || offer.saveFile);
}

/** 程序里可用的 camelCase 别名。 */
export function availableRpcAliases(): string[] {
  return Object.keys(RPC_ALIASES);
}

function programMethods(offer: { saveFile: boolean }): string[] {
  return [
    ...TOOL_NAMES.filter(name => name !== "worker_tabs"),
    ...availableRpcAliases(),
    ...availableProgramHelpers(offer).map(h => h.name),
  ];
}

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Page/web globals models reach for inside the sandbox; QuickJS has none of them. */
const PAGE_GLOBALS = new Set(["window", "document", "Blob", "File", "FileReader", "fetch", "XMLHttpRequest", "location", "history", "localStorage", "sessionStorage", "navigator", "setTimeout", "setInterval", "console", "alert", "URL", "atob", "btoa", "DOMParser", "TextEncoder", "TextDecoder", "performance"]);

/**
 * Turn the sandbox's bare errors into the next step the model can take: a page global names browser.js/saveFile/sleep,
 * an unknown browser.x names the real methods. Anything else (including the model's own typos) passes through unchanged.
 */
function explainProgramError(text: string, code: string, methods: readonly string[]): string {
  const missing = /^'(\w+)' is not defined$/.exec(text)?.[1];

  if (missing && PAGE_GLOBALS.has(missing)) {
    const save = methods.includes("saveFile") ? ", save text with await browser.saveFile({filename, content})," : ",";

    return `browser_run has no page globals such as ${missing}: run page code with await browser.js({code: "..."})${save} and wait with await browser.sleep({ms}).`;
  }

  if (text === "not a function") {
    const unknown = [...code.matchAll(/\bbrowser\.(\w+)\s*\(/g)].map(m => m[1]!).find(name => !methods.includes(name));

    if (unknown) {
      const canonical = methods.filter(name => !(name in RPC_ALIASES));

      return `browser.${unknown} is not a browser method. Available: ${[...new Set(canonical)].join(", ")}.`;
    }
  }

  return text;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** 用户程序体。 */
function programSource(options: ProgramOptions): string {
  return `(async()=>{const value=await(async()=>{\n${options.code}\n})();return JSON.stringify(value===undefined?null:value);})()`;
}

/** Isolated JS heap. The only host capability is the existing, serialized browser RPC. */
export async function runBrowserProgram(options: ProgramOptions): Promise<{
  value: unknown;
  steps: number;
  images: Array<{ type: "image"; data: string; mimeType: string }>;
}> {
  if (options.code.length > 64_000) throw new Error("Browser program exceeds 64000 characters");
  const METHODS = programMethods({ saveFile: !!options.saveFile });
  const engine = await getQuickJS();
  const vm = engine.newContext();
  vm.runtime.setMemoryLimit(16 * 1024 * 1024);
  vm.runtime.setMaxStackSize(256 * 1024);
  const deadline = Date.now() + Math.min(Math.max(options.timeoutMs ?? 60_000, 1), 120_000);
  let cpuDeadline = Date.now() + 100;
  let stopped = "";
  let closed = false;
  let steps = 0;
  let chain = Promise.resolve();
  let program: QuickJSHandle | undefined;
  const pending = new Set<QuickJSDeferredPromise>();
  const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
  /** 已结束的步骤，按顺序；assert 停下时随结构化错误交给宿主。 */
  const trail: ProgramStep[] = [];
  /** 停下时如果是带结构的错误（assert），所有停止路径都抛它本身，不压成一行文字。 */
  let stoppedBy: Error | undefined;

  const stop = (reason: string | Error) => {
    if (!stopped) {
      stopped = message(reason);

      if (reason instanceof Error) stoppedBy = reason;
    }

    return stoppedBy ?? new Error(stopped);
  };

  const guard = () => {
    if (options.signal?.aborted) throw stop("Browser program aborted; no further actions dispatched");

    if (Date.now() >= deadline) throw stop("Browser program timed out; no further actions dispatched");

    if (stopped || closed) throw stop(stopped || "Browser program already ended");
  };

  vm.runtime.setInterruptHandler(() => {
    if (Date.now() >= cpuDeadline) stop("Browser program CPU budget exceeded");

    if (options.signal?.aborted) stop("Browser program aborted");

    if (Date.now() >= deadline) stop("Browser program timed out");

    return Boolean(stopped || closed);
  });
  const emit = (step: ProgramStep) => {
    if (step.phase === "end") trail.push(step);

    try { options.onStep?.(step); } catch { /* observation is not control */ }
  };

  async function sleep(ms: number) {
    if (!Number.isFinite(ms) || ms < 0 || ms > 10_000) throw new Error("INVALID_ARGUMENT: sleep.ms must be between 0 and 10000");
    const until = Date.now() + ms;

    while (Date.now() < until) { guard(); await pause(Math.min(50, until - Date.now())); }

    guard();

    return { waitedMs: ms };
  }

  /** 子调用身份：同一父 step 下可区分，避免多次副作用共用一个登记 ID。 */
  const nextSubId = (parentStepId: string) => {
    let n = 0;

    return () => `${parentStepId}/n${++n}`;
  };

  const errorCode = (text: string) => {
    const match = /^(NOT_FOUND|NOT_READY|AMBIGUOUS|PERMISSION_DENIED|IDENTITY_CHANGED|INVALID_ARGUMENT|TRANSPORT_ERROR|CANCELLED|CAPTURE_INCOMPLETE|UNSUPPORTED_WAIT_STATE):/.exec(text);

    return match?.[1] ?? null;
  };

  const isRetryableWait = (text: string) => {
    const code = errorCode(text);

    return code === "NOT_FOUND" || code === "NOT_READY";
  };

  /** 统一 target 等待。state：visible+enabled（默认）/ visible / attached / detached / hidden。 */
  async function waitFor(params: Record<string, unknown>, stepId: string) {
    const target = params.selector;

    if (typeof target !== "string" || !target) {
      throw new Error("INVALID_ARGUMENT: wait_for 需要 selector（@N / loc=css: / loc=role: / loc=href: / 原生 CSS / xpath= / text=）");
    }

    const stateRaw = params.state === undefined ? "visible+enabled" : String(params.state);
    const allowed = new Set(["visible", "visible+enabled", "attached", "detached", "hidden"]);

    if (!allowed.has(stateRaw)) {
      throw new Error(`UNSUPPORTED_WAIT_STATE: waitFor 不支持 ${stateRaw}；可用 visible|visible+enabled|attached|detached|hidden`);
    }

    const state = stateRaw as "visible" | "visible+enabled" | "attached" | "detached" | "hidden";
    const timeout = Number(params.timeoutMs ?? 5000);

    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 30_000) throw new Error("INVALID_ARGUMENT: wait_for.timeoutMs must be between 1 and 30000");
    const until = Math.min(deadline, Date.now() + timeout);
    let polls = 0;
    const sub = nextSubId(stepId);

    const probeVisible = async (): Promise<"yes" | "no" | "missing" | "pending"> => {
      try {
        const data = (await options.call(
          "read_element",
          { target, properties: ["visible"] },
          sub(),
          "readonly-poll",
        )) as { check?: { matched?: boolean }; properties?: { visible?: boolean } };

        if (data.properties?.visible === true || data.check?.matched === true) return "yes";

        if (data.properties?.visible === false) return "no";
        throw new Error("READ_RESULT_INVALID: visible state was not returned; absence of evidence is not hidden");
      } catch (error) {
        guard();
        const text = message(error);

        if (errorCode(text) === "NOT_FOUND") return "missing";

        if (errorCode(text) === "NOT_READY") return "pending";
        throw error;
      }
    };

    const probeEnabled = async (): Promise<boolean> => {
      try {
        const data = (await options.call(
          "read_element",
          { target, properties: ["enabled"] },
          sub(),
          "readonly-poll",
        )) as { check?: { matched?: boolean }; properties?: { enabled?: boolean } };

        return data.properties?.enabled === true || data.check?.matched === true;
      } catch (error) {
        const text = message(error);

        if (isRetryableWait(text)) return false;
        throw error;
      }
    };

    const probeAttached = async (): Promise<boolean | null> => {
      try {
        await options.call("read_element", { target, properties: ["visible"] }, sub(), "readonly-poll");

        return true;
      } catch (error) {
        guard();
        const text = message(error);

        if (errorCode(text) === "NOT_FOUND") return false;

        if (errorCode(text) === "NOT_READY") return null;
        throw error;
      }
    };

    do {
      guard();
      polls++;

      if (state === "attached") {
        if (await probeAttached()) return { ready: true, polls, target, state };
      } else if (state === "detached") {
        if ((await probeAttached()) === false) return { ready: true, polls, target, state };
      } else if (state === "hidden") {
        const v = await probeVisible();

        if (v === "no" || v === "missing") return { ready: true, polls, target, state };
      } else if (state === "visible") {
        if ((await probeVisible()) === "yes") return { ready: true, polls, target, state };
      } else {
        // visible+enabled
        let ready = (await probeVisible()) === "yes";

        if (ready) ready = await probeEnabled();

        if (ready) ready = (await probeVisible()) === "yes";

        if (ready) return { ready: true, polls, target, state: "visible+enabled" };
      }

      guard();

      if (Date.now() >= until) break;
      await sleep(Math.max(0, Math.min(150, until - Date.now())));
    } while (Date.now() <= until);

    throw new Error(`wait_for ${target} state=${state} timed out after ${timeout}ms (${polls} polls)`);
  }

  /**
   * check：动作后不叫模型就核对结果——等一段文字或一个目标出现/消失，到时返回 ok:false 而不是抛错。
   * 文字默认在 body 上找；探测走 read_element expect（只读），与 waitFor 同一条控制闸门。
   * 中止、接管、断连仍从 guard() 抛出，照旧停下程序。
   */
  async function check(params: Record<string, unknown>, stepId: string) {
    const text = typeof params.text === "string" && params.text ? params.text : null;
    const selector = typeof params.selector === "string" && params.selector ? params.selector : null;

    if (!text && !selector) throw new Error("INVALID_ARGUMENT: check 需要 text（页面上应出现的文字）或 selector（统一 target）");
    const state = params.state === undefined ? "appears" : String(params.state);

    if (state !== "appears" && state !== "disappears") throw new Error(`INVALID_ARGUMENT: check.state 只支持 appears 或 disappears，收到 ${state}`);
    const timeout = Number(params.timeoutMs ?? 3000);

    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 30_000) throw new Error("INVALID_ARGUMENT: check.timeoutMs must be between 1 and 30000");
    const until = Math.min(deadline, Date.now() + timeout);
    const started = Date.now();
    let polls = 0;
    const sub = nextSubId(stepId);
    const target = selector ?? "body";
    // expect 只比较 properties 里读到的值，所以要一起要那个属性。
    const readParams = text
      ? { target, properties: ["visibleText"], expect: { property: "visibleText", contains: text } }
      : { target, properties: ["visible"], expect: { property: "visible", equals: true } };

    /** 条件此刻成立吗：目标不在（NOT_FOUND）或条件未满足（NOT_READY）都算不成立；其他错误照抛。 */
    const holds = async (): Promise<boolean> => {
      try {
        const data = await options.call("read_element", readParams, sub(), "readonly-poll") as { check?: { matched?: boolean } };

        return data.check?.matched === true;
      } catch (error) {
        guard();

        if (isRetryableWait(message(error))) return false;
        throw error;
      }
    };

    do {
      guard();
      polls++;

      if ((await holds()) === (state === "appears")) return { ok: true, waitedMs: Date.now() - started, polls };
      guard();

      if (Date.now() >= until) break;
      await sleep(Math.max(0, Math.min(150, until - Date.now())));
    } while (Date.now() <= until);

    return { ok: false, waitedMs: Date.now() - started, polls };
  }

  /** assert：程序自己算好条件传进来；不成立就以结构化错误停下整个程序（走 stop，catch 救不回）。 */
  function assert(params: Record<string, unknown>, failedAt: number) {
    if (typeof params.ok !== "boolean") throw new Error("INVALID_ARGUMENT: assert.ok must be a boolean");

    if (typeof params.name !== "string" || !params.name.trim()) throw new Error("INVALID_ARGUMENT: assert.name must be a non-empty string");

    if (params.ok) return { ok: true };
    const reason = typeof params.reason === "string" ? params.reason : "";
    const completed = trail.filter(step => !step.error).length;

    // trail 按引用交出：这一步的 end 随后也会记进去，宿主看到的步骤列表含 assert 本身。
    throw new ProgramAssertError({ failedAt, name: params.name.trim(), reason, completed }, trail);
  }

  /** pageInfo：list_tabs 与 js 之间工作页必须稳定，禁止 A 身份 + B 内容；附带未处理 JS dialog。 */
  async function pageInfo(_params: Record<string, unknown>, stepId: string): Promise<unknown> {
    guard();
    const sub = nextSubId(stepId);
    const tabs = await options.call("list_tabs", {}, sub(), "readonly-poll") as { tabs?: Array<{ id: number; title?: string; url?: string; working?: boolean }> };
    const working = tabs.tabs?.find(t => t.working === true) ?? null;

    if (working?.id == null) throw new Error("IDENTITY_CHANGED: pageInfo 没有工作标签页");

    const info = await options.call("js", {
      tabId: working.id,
      code: HOST_PAGE_PROBES.pageInfo,
    }, sub(), "readonly-poll") as { value?: unknown };

    const dialogData = await options.call("dialog_info", { tabId: working.id }, sub(), "readonly-poll") as { dialog?: unknown };
    const tabsAfter = await options.call("list_tabs", {}, sub(), "readonly-poll") as { tabs?: Array<{ id: number; title?: string; url?: string; working?: boolean }> };
    const after = tabsAfter.tabs?.find(t => t.working === true) ?? null;

    if (after?.id !== working.id) throw new Error("IDENTITY_CHANGED: working tab changed during pageInfo");

    return {
      tabId: working.id,
      tabTitle: working.title ?? null,
      tabUrl: working.url ?? null,
      page: info.value ?? null,
      dialog: dialogData.dialog ?? null,
    };
  }

  /**
   * armEvent：立即返回宿主 token，不阻塞串行队列。
   * download 由 Chrome 存进用户的下载文件夹，完成与否由扩展按 chrome.downloads 判定。
   */
  async function armEvent(params: Record<string, unknown>, stepId: string): Promise<unknown> {
    guard();
    const type = params.type;

    if (type !== "popup" && type !== "download" && type !== "filechooser") {
      throw new Error("INVALID_ARGUMENT: armEvent.type must be popup|download|filechooser");
    }

    const callParams: Record<string, unknown> = { type };

    if (typeof params.tabId === "number") callParams.tabId = params.tabId;

    if (typeof params.timeoutMs === "number") callParams.timeoutMs = params.timeoutMs;

    return options.call("arm_event", callParams, stepId);
  }

  /** waitForLoad：等当前这次文档到达 domcontentloaded/load；旧文档 complete 不能在文档替换后冒充就绪。 */
  async function waitForLoad(params: Record<string, unknown>, stepId: string): Promise<unknown> {
    const state = params.state === undefined || params.state === "load" ? "load"
      : params.state === "domcontentloaded" ? "domcontentloaded"
      : null;

    if (!state) throw new Error("INVALID_ARGUMENT: waitForLoad.state 只支持 domcontentloaded 或 load；network-idle 请用 waitForNetworkIdle");
    const timeout = Number(params.timeoutMs ?? 15_000);

    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 30_000) throw new Error("INVALID_ARGUMENT: waitForLoad.timeoutMs must be between 1 and 30000");
    const until = Math.min(deadline, Date.now() + timeout);
    const started = Date.now();
    let polls = 0;
    const sub = nextSubId(stepId);

    const readDoc = async () => {
      const jsParams = typeof params.tabId === "number" ? { code: HOST_PAGE_PROBES.documentState, tabId: params.tabId } : { code: HOST_PAGE_PROBES.documentState };
      const data = await options.call("js", jsParams, sub(), "readonly-poll") as { value?: { readyState?: string; href?: string; timeOrigin?: number } | string };

      const value = data.value;

      if (typeof value === "string") return { readyState: value, href: "", timeOrigin: 0 };

      return {
        readyState: String(value?.readyState ?? ""),
        href: String(value?.href ?? ""),
        timeOrigin: typeof value?.timeOrigin === "number" ? value.timeOrigin : 0,
      };
    };

    let sawLoading = false;
    let committedOrigin: number | null = null;
    let stableReady = 0;
    let last = { readyState: "", href: "", timeOrigin: 0 };

    while (Date.now() <= until) {
      guard();
      last = await readDoc();
      polls++;

      if (committedOrigin === null) committedOrigin = last.timeOrigin;

      if (last.readyState === "loading") {
        sawLoading = true;
        committedOrigin = last.timeOrigin;
        stableReady = 0;
      } else if (last.timeOrigin !== committedOrigin) {
        sawLoading = true;
        committedOrigin = last.timeOrigin;
        stableReady = 0;
      }

      const reached = state === "load"
        ? last.readyState === "complete"
        : last.readyState === "interactive" || last.readyState === "complete";

      if (reached && last.timeOrigin === committedOrigin) {
        stableReady += 1;
        // 见过 loading/文档替换：一次到达即可。若首屏已是 complete，需连续两次同 timeOrigin，避免旧文档瞬时 complete 后导航替换。
        const needStable = sawLoading ? 1 : 2;

        if (stableReady >= needStable) {
          return { readyState: last.readyState, state, polls, waitedMs: Date.now() - started, timeOrigin: last.timeOrigin, href: last.href };
        }
      } else {
        stableReady = 0;
      }

      if (Date.now() >= until) break;
      await sleep(Math.max(0, Math.min(150, until - Date.now())));
    }

    throw new Error(`waitForLoad ${state} timed out after ${timeout}ms (${polls} polls; last=${JSON.stringify(last)})`);
  }

  /**
   * waitForNetworkIdle：纳入范围的在途为 0 且持续 idleMs 静默，且捕获完整。
   * 不等于页面业务完成。捕获 late/detach/gap/restart 返回 CAPTURE_INCOMPLETE，不冒充空闲。
   */
  async function waitForNetworkIdle(params: Record<string, unknown>, stepId: string): Promise<unknown> {
    const idleMs = Number(params.idleMs ?? 500);

    if (!Number.isFinite(idleMs) || idleMs < 100 || idleMs > 5_000) throw new Error("INVALID_ARGUMENT: waitForNetworkIdle.idleMs must be between 100 and 5000");
    const timeout = Number(params.timeoutMs ?? 10_000);

    if (!Number.isFinite(timeout) || timeout < 1_000 || timeout > 30_000) throw new Error("INVALID_ARGUMENT: waitForNetworkIdle.timeoutMs must be between 1000 and 30000");
    const until = Math.min(deadline, Date.now() + timeout);
    const started = Date.now();
    let samples = 0;
    const sub = nextSubId(stepId);
    let lastGeneration: number | null = null;

    do {
      guard();

      const data = await options.call("network", { types: "all", limit: 1 }, sub(), "readonly-poll") as {
        total?: number;
        dropped?: number;
        inFlight?: number;
        excludedInFlight?: number;
        lastActivityAt?: number;
        generation?: number;
        integrity?: string;
        attached?: boolean;
      };

      samples++;
      const integrity = data.integrity ?? "none";
      const inFlight = Number(data.inFlight ?? NaN);
      const lastActivityAt = Number(data.lastActivityAt ?? 0);
      const generation = Number(data.generation ?? 0);

      if (lastGeneration !== null && generation !== lastGeneration) {
        throw new Error(`CAPTURE_INCOMPLETE: network capture generation changed during wait (${lastGeneration}→${generation})`);
      }

      lastGeneration = generation;

      if (integrity !== "ok" || data.attached === false) {
        if (Date.now() >= until) {
          throw new Error(`CAPTURE_INCOMPLETE: waitForNetworkIdle cannot claim idle under integrity=${integrity} (samples=${samples})`);
        }
      } else if (Number.isFinite(inFlight) && inFlight === 0 && Date.now() - lastActivityAt >= idleMs) {
        return {
          idle: true,
          idleMs: Date.now() - lastActivityAt,
          samples,
          waitedMs: Date.now() - started,
          inFlight: 0,
          excludedInFlight: Number(data.excludedInFlight ?? 0),
          generation,
          integrity,
          note: "network-idle means scoped in-flight is quiet; not page business completion",
        };
      }

      if (Date.now() >= until) break;
      await sleep(Math.max(0, Math.min(100, until - Date.now())));
    } while (Date.now() <= until);

    throw new Error(`waitForNetworkIdle timed out after ${timeout}ms (${samples} samples; no ${idleMs}ms idle with complete capture)`);
  }

  /** scrollToBottomUntil：滚动直到条件成立或页面到底；到底未命中如实返回 matched:false。 */
  async function scrollToBottomUntil(params: Record<string, unknown>, stepId: string): Promise<unknown> {
    const selector = typeof params.selector === "string" && params.selector ? params.selector : null;
    const condition = typeof params.condition === "string" && params.condition ? params.condition : null;

    if (!selector && !condition) throw new Error("INVALID_ARGUMENT: scrollToBottomUntil 需要 selector 或 condition（滚动直到条件成立或到底）");
    const maxSteps = Number(params.maxSteps ?? 12);

    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 30) throw new Error("INVALID_ARGUMENT: scrollToBottomUntil.maxSteps must be between 1 and 30");
    const timeout = Number(params.timeoutMs ?? 15_000);

    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 30_000) throw new Error("INVALID_ARGUMENT: scrollToBottomUntil.timeoutMs must be between 1 and 30000");
    const until = Math.min(deadline, Date.now() + timeout);
    const sub = nextSubId(stepId);

    const check = async (): Promise<boolean> => {
      if (selector) {
        try {
          const data = await options.call("read_element", { target: selector, properties: ["visible"], expect: { property: "visible", equals: true } }, sub(), "readonly-poll") as { check?: { matched?: boolean } };

          return data.check?.matched === true;
        } catch (error) {
          const text = message(error);

          if (isRetryableWait(text)) return false;
          throw error;
        }
      }

      const data = await options.call("js", { code: `(() => { try { return !!(${condition}) } catch (e) { return false } })()` }, sub(), "readonly-poll") as { value?: unknown };

      return data.value === true;
    };

    let stepsTaken = 0;
    let atBottom = false;
    let matched = await check();

    while (!matched && !atBottom && stepsTaken < maxSteps && Date.now() < until) {
      guard();
      const scroll = await options.call("scroll", {}, sub()) as { atBottom?: boolean };
      stepsTaken++;
      atBottom = scroll.atBottom === true;
      matched = await check();
    }

    if (matched || atBottom) return { matched, steps: stepsTaken, atBottom };

    if (stepsTaken >= maxSteps) return { matched: false, steps: stepsTaken, atBottom: false, stopped: "maxSteps" };
    throw new Error(`scrollToBottomUntil timed out after ${timeout}ms (${stepsTaken} steps)`);
  }

  const bridge = vm.newFunction("browserCall", (nameHandle, paramsHandle) => {
    guard();

    if (pending.size >= 32) throw stop("Too many pending browser calls; await each operation");
    const name = vm.getString(nameHandle);

    if (!METHODS.includes(name)) throw new Error(`Unknown browser method: ${name}`);
    let params: Record<string, unknown>;

    try {
      params = JSON.parse(vm.getString(paramsHandle)) as Record<string, unknown>;
    } catch (error) {
      // 宿主回调里的 JSON.parse 只接受门面传来的 JSON 对象；坏输入变成明确的步骤错误，
      // 不让异常形态穿透 QuickJS 回调边界。
      throw new Error(`Browser call parameters must be JSON: ${message(error)}`);
    }

    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new Error(`browser.${name} takes one object of named fields, e.g. browser.${name}({...}); got ${Array.isArray(params) ? "array" : typeof params}`);
    }

    const deferred = vm.newPromise();
    pending.add(deferred);
    chain = chain.then(async () => {
      if (closed || stopped || options.signal?.aborted) return;
      const id = `${options.id ?? "program"}/${++steps}`;
      const stepName = RPC_ALIASES[name] ?? (name === "waitFor" || name === "waitForElement" ? "wait_for" : name);
      // saveFile 的内容不进步骤记录（侧栏步骤、诊断记录都从这里取），只记文件名与长度。
      const stepParams = name === "saveFile" ? { filename: params.filename, chars: typeof params.content === "string" ? params.content.length : null } : params;
      const step = { parentId: options.id ?? "program", id, name: stepName, params: stepParams };
      const started = Date.now();
      let actualResult: unknown;
      emit({ ...step, phase: "start" });

      try {
        guard();
        const canonical = RPC_ALIASES[name] ?? name;

        const result = actualResult = name === "sleep" ? await sleep(Number(params.ms ?? 0))
          : name === "waitFor" || name === "waitForElement" ? await waitFor(params, id)
          : name === "check" ? await check(params, id)
          : name === "assert" ? assert(params, steps)
          : name === "pageInfo" ? await pageInfo(params, id)
          : name === "waitForLoad" ? await waitForLoad(params, id)
          : name === "waitForNetworkIdle" ? await waitForNetworkIdle(params, id)
          : name === "scrollToBottomUntil" ? await scrollToBottomUntil(params, id)
          : name === "armEvent" ? await armEvent(params, id)
          : name === "saveFile" && options.saveFile ? (isSaveFileParams(params) ? await options.saveFile(params) : rejectSaveFileParams())
          : await options.call(canonical as ToolName, params, id);

        guard();
        let value = result;

        // 与模型直调的 navigate 一致：新页面就绪后顺手读一次，text 即新页面快照，程序里不必再调 snapshot。地址变成下载或 Chrome 显示错误页时不读。
        if (canonical === "navigate" && result && typeof result === "object" && !["timeout", "download", "error_page"].includes(String((result as { readiness?: unknown }).readiness))) {
          try {
            const page = await options.call("snapshot", {}, nextSubId(id)(), "readonly-poll") as { text?: unknown };

            if (typeof page?.text === "string") value = { ...result, text: page.text };
          } catch { /* 补读失败只退回导航本身的结果。 */ }

          guard();
        }

        if (name === "screenshot" && result && typeof result === "object" && "imageBase64" in result) {
          const shot = result as Record<string, unknown>;
          const data = shot.imageBase64;
          const mediaType = typeof shot.mediaType === "string" ? shot.mediaType : "image/png";

          if (typeof data === "string") images.splice(0, images.length, { type: "image", data, mimeType: mediaType });
          // 去掉 base64 后把真实截图元数据（像素/CSS 视口/DPR/tab/url/source 等）交给程序；
          // 程序内可核对坐标系与页面身份，图片走 images 通道。
          const meta = { ...shot };
          delete meta.imageBase64;
          value = { ...meta, image: "attached to program result" };
        }

        const json = JSON.stringify(value ?? null);

        if (json.length > 512_000) throw new Error("Browser result too large; extract a smaller result");
        const handle = vm.newString(json);
        deferred.resolve(handle);
        handle.dispose();
        emit({ ...step, phase: "end", result, elapsedMs: Date.now() - started });
      } catch (error) {
        const text = message(error);
        // A caught RPC error is not a license to keep writing. The host owns this
        // boundary even if generated JS catches the rejected promise or queued writes.
        stop(error instanceof ProgramAssertError ? error : text);
        emit({ ...step, phase: "end", result: actualResult, error: text, elapsedMs: Date.now() - started });

        if (!closed) {
          const handle = vm.newError(`${step.name}: ${text}`);
          deferred.reject(handle);
          handle.dispose();
        }
      } finally {
        pending.delete(deferred);

        if (deferred.alive) deferred.dispose();
      }
    });

    return deferred.handle;
  });

  vm.setProp(vm.global, "__browserCall", bridge);
  bridge.dispose();

  try {
    const bootstrap = vm.evalCode(`{
      const call=globalThis.__browserCall; delete globalThis.__browserCall;
      globalThis.browser=Object.freeze(Object.fromEntries(${JSON.stringify(METHODS)}.map(name=>[name, async (params)=>JSON.parse(await call(name,JSON.stringify(params??{})))])));
    }`);

    vm.unwrapResult(bootstrap).dispose();
    guard();
    const source = programSource(options);
    cpuDeadline = Date.now() + 100;
    const evaluated = vm.evalCode(source, "browser-program.js");

    if (evaluated.error) {
      const error = vm.dump(evaluated.error);
      evaluated.error.dispose();
      throw stopped ? stop(stopped) : new Error(error.message ? explainProgramError(error.message, options.code, METHODS) : String(error));
    }

    program = evaluated.value;

    for (;;) {
      guard();
      cpuDeadline = Date.now() + 100;
      const jobs = vm.runtime.executePendingJobs(100);

      if (jobs.error) {
        const error = vm.dump(jobs.error);
        jobs.error.dispose();
        throw stopped ? stop(stopped) : new Error(error.message ? explainProgramError(error.message, options.code, METHODS) : String(error));
      }

      const state = vm.getPromiseState(program);

      if (state.type === "fulfilled") {
        try {
          if (pending.size) throw stop("Unawaited browser calls; await every operation. Remaining actions stopped");
          const value = vm.getString(state.value);

          if (value.length > 128_000) throw new Error("Program output too large; return a concise result");

          return { value: JSON.parse(value), steps, images };
        } finally { state.value.dispose(); }
      }

      if (state.type === "rejected") {
        const error = vm.dump(state.error);
        state.error.dispose();
        throw stopped ? stop(stopped) : new Error(error.message ? explainProgramError(error.message, options.code, METHODS) : String(error));
      }

      await pause(10);
    }
  } finally {
    closed = true;

    // An already-dispatched action is drained, never reported as rolled back.
    try { await chain; }
    finally {
      for (const deferred of pending) if (deferred.alive) deferred.dispose();
      program?.dispose();
      vm.dispose();
    }
  }
}
