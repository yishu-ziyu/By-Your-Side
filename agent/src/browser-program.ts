import { getQuickJS, type QuickJSDeferredPromise, type QuickJSHandle } from "quickjs-emscripten";
import { TOOL_NAMES, type ToolName } from "../../shared/protocol.js";
import { buildPlaywrightProgram } from "./stagehand-bridge.js";
import { createDownloadArmDir, hostDownloadSaveAs, type DownloadStatLike } from "./download-artifacts.js";

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

interface ProgramOptions {
  code: string;
  /** "ego" = 现有 browser.* 程序；"playwright" = 官方兼容层，额外提供 page/context。 */
  api?: "ego" | "playwright";
  /** 任务缺省页；playwright 模式第一步读到的绑定页以它为准（没有则用 list_tabs 的 working 页）。 */
  pageTabId?: number | null;
  call(name: ToolName, params: Record<string, unknown>, stepId?: string, origin?: "readonly-poll"): Promise<unknown>;
  /**
   * 上传 RPC 派发前的同源授权：把 fileId/paths 规范化为本任务已授权的 realpath。
   * 与 tools.ts call 边界共用同一 authorizeUploadPaths 结果；失败则不调用 options.call。
   */
  authorizeUpload?(refs: readonly string[]): string[];
  signal?: AbortSignal;
  id?: string;
  timeoutMs?: number;
  onStep?(step: ProgramStep): void;
}

/** browser.* 的 camelCase 别名：程序里用 EGO 风格名字，账本仍记规范 RPC 名。 */
export const RPC_ALIASES: Record<string, string> = {
  doubleClick: "double_click",
  uploadFile: "upload_file",
  armEvent: "arm_event",
  waitEvent: "wait_event",
  disarmEvent: "disarm_event",
  consumeEvents: "consume_events",
  acceptDialog: "accept_dialog",
  dismissDialog: "dismiss_dialog",
  dialogInfo: "dialog_info",
  fileChooserSetFiles: "file_chooser_set_files",
  downloadStat: "download_stat",
  downloadCancel: "download_cancel",
  downloadDelete: "download_delete",
  mouseDown: "mouse_down",
  mouseUp: "mouse_up",
  keyDown: "key_down",
  keyUp: "key_up",
  releaseHeldInputs: "release_held_inputs",
  html5Drag: "html5_drag",
  html5DragAndDrop: "html5_drag",
  selectOption: "select_option",
};

/**
 * browser_run 组合 helper 的能力事实源：METHODS 白名单与 browser_run 描述文本都从这里取，
 * 防止文档与代码漂移（Issue §十）。它们在宿主内组合现有 RPC 完成，不新增 extension RPC。
 */
export const BROWSER_PROGRAM_HELPERS = [
  { name: "waitFor", summary: "等待唯一目标：state=visible|visible+enabled|attached|detached|hidden（统一 target：@ref / CSS / loc=role / loc=href / xpath= / text=）", composed: "read_element expect 轮询（只读）" },
  { name: "waitForElement", summary: "waitFor 的语义别名", composed: "waitFor" },
  { name: "sleep", summary: "有界等待毫秒（纯宿主，不伪造浏览器动作）", composed: "host timer" },
  { name: "pageInfo", summary: "url/title/readyState/视口/滚动/工作页/未处理 JS dialog（身份一致才返回）", composed: "list_tabs + js + dialog_info" },
  { name: "waitForLoad", summary: "等当前文档的 domcontentloaded / load 就绪", composed: "js(document.readyState+timeOrigin)" },
  { name: "waitForNetworkIdle", summary: "纳入范围的在途请求为 0 且持续静默；捕获不完整不冒充空闲（≠业务完成）", composed: "network 在途集合轮询" },
  { name: "scrollToBottomUntil", summary: "滚动直到条件成立或到底", composed: "scroll + read_element / js 条件" },
  { name: "armEvent", summary: "触发前订阅 popup/download/filechooser；返回宿主 token（串行队列不阻塞）", composed: "arm_event + 下载临时目录" },
  { name: "waitEvent", summary: "消费已 arm 的 token；须先 arm 再动作再 wait", composed: "wait_event" },
  { name: "disarmEvent", summary: "取消尚未消费的 arm", composed: "disarm_event" },
  { name: "consumeEvents", summary: "读清本页缓冲事件", composed: "consume_events" },
  { name: "downloadSaveAs", summary: "等待页面下载完成后复制到绝对路径（非 fetch）", composed: "download_stat + 宿主 fs" },
] as const;

const HOST_METHODS: readonly string[] = BROWSER_PROGRAM_HELPERS.map((h) => h.name);

const METHODS = [...TOOL_NAMES.filter(name => name !== "worker_tabs"), ...Object.keys(RPC_ALIASES), ...HOST_METHODS];

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** 用户程序体；playwright 模式先注入官方兼容层与 RawPage/RawContext 适配。 */
function programSource(options: ProgramOptions): string {
  if (options.api === "playwright") {
    return buildPlaywrightProgram({
      code: options.code,
      pageTabId: typeof options.pageTabId === "number" ? options.pageTabId : null,
      platform: process.platform,
    });
  }

  return `(async()=>{const value=await(async()=>{\n${options.code}\n})();return JSON.stringify(value===undefined?null:value);})()`;
}

/** Isolated JS heap. The only host capability is the existing, serialized browser RPC. */
export async function runBrowserProgram(options: ProgramOptions): Promise<{
  value: unknown;
  steps: number;
  images: Array<{ type: "image"; data: string; mimeType: string }>;
}> {
  if (options.code.length > 64_000) throw new Error("Browser program exceeds 64000 characters");
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

  const stop = (reason: string) => { stopped ||= reason;

 return new Error(stopped); };

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
  const emit = (step: ProgramStep) => { try { options.onStep?.(step); } catch { /* observation is not control */ } };

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

  /** pageInfo：list_tabs 与 js 之间工作页必须稳定，禁止 A 身份 + B 内容；附带未处理 JS dialog。 */
  async function pageInfo(_params: Record<string, unknown>, stepId: string): Promise<unknown> {
    guard();
    const sub = nextSubId(stepId);
    const tabs = await options.call("list_tabs", {}, sub(), "readonly-poll") as { tabs?: Array<{ id: number; title?: string; url?: string; working?: boolean }> };
    const working = tabs.tabs?.find(t => t.working === true) ?? null;

    if (working?.id == null) throw new Error("IDENTITY_CHANGED: pageInfo 没有工作标签页");

    const info = await options.call("js", {
      tabId: working.id,
      code: "({href:location.href,title:document.title,readyState:document.readyState,viewport:{width:innerWidth,height:innerHeight},scroll:{x:Math.round(scrollX),y:Math.round(scrollY)},timeOrigin:performance.timeOrigin})",
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
   * download 时由宿主创建临时目录再交给扩展 Page.setDownloadBehavior（不设全局目录）。
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

    if (type === "download") {
      callParams.downloadPath = typeof params.downloadPath === "string" && params.downloadPath.startsWith("/")
        ? params.downloadPath
        : createDownloadArmDir(String(stepId).replace(/\W+/g, "").slice(-12) || "arm");
    }

    return options.call("arm_event", callParams, stepId);
  }

  async function downloadSaveAs(params: Record<string, unknown>, stepId: string): Promise<unknown> {
    guard();
    const downloadId = String(params.downloadId ?? "");
    const path = String(params.path ?? "");
    const sub = nextSubId(stepId);

    const result = await hostDownloadSaveAs({
      downloadId,
      path,
      timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : undefined,
      stat: async () => options.call("download_stat", { downloadId }, sub()) as Promise<DownloadStatLike>,
    });

    return result;
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
      const jsParams = typeof params.tabId === "number" ? { code: "({readyState:document.readyState,href:location.href,timeOrigin:performance.timeOrigin})", tabId: params.tabId } : { code: "({readyState:document.readyState,href:location.href,timeOrigin:performance.timeOrigin})" };
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

    if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("Browser parameters must be an object");
    const deferred = vm.newPromise();
    pending.add(deferred);
    chain = chain.then(async () => {
      if (closed || stopped || options.signal?.aborted) return;
      const id = `${options.id ?? "program"}/${++steps}`;
      const stepName = RPC_ALIASES[name] ?? (name === "waitFor" || name === "waitForElement" ? "wait_for" : name);
      const step = { parentId: options.id ?? "program", id, name: stepName, params };
      const started = Date.now();
      let actualResult: unknown;
      emit({ ...step, phase: "start" });

      try {
        guard();
        const canonical = RPC_ALIASES[name] ?? name;
        let callParams = params;

        if (canonical === "upload_file" || canonical === "file_chooser_set_files") {
          // RPC 派发前授权：别名/Playwright/chooser 不能带着未授权路径出沙箱。
          if (!options.authorizeUpload) {
            throw new Error("本任务没有可上传的文件授权记录，未执行。");
          }

          const refs = Array.isArray(params.paths) ? (params.paths as unknown[]).map(String) : [];
          callParams = { ...params, paths: options.authorizeUpload(refs) };
        }

        const result = actualResult = name === "sleep" ? await sleep(Number(params.ms ?? 0))
          : name === "waitFor" || name === "waitForElement" ? await waitFor(params, id)
          : name === "pageInfo" ? await pageInfo(params, id)
          : name === "waitForLoad" ? await waitForLoad(params, id)
          : name === "waitForNetworkIdle" ? await waitForNetworkIdle(params, id)
          : name === "scrollToBottomUntil" ? await scrollToBottomUntil(params, id)
          : name === "armEvent" ? await armEvent(params, id)
          : name === "downloadSaveAs" ? await downloadSaveAs(params, id)
          : await options.call(canonical as ToolName, callParams, id);

        if (result && typeof result === "object" && "held" in result && result.held) {
          throw stop("Held click: waiting for user confirmation. This program is stopped; do not issue further actions");
        }

        guard();
        let value = result;

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
        stop(text);
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
      globalThis.browser=Object.freeze(Object.fromEntries(${JSON.stringify(METHODS)}.map(name=>[name, async (params={})=>JSON.parse(await call(name,JSON.stringify(params)))])));
    }`);

    vm.unwrapResult(bootstrap).dispose();
    guard();
    const source = programSource(options);
    // The trusted facade is substantially larger than user code. Its initial evaluation
    // yields at list_tabs before entering user code; subsequent jobs retain the 100ms limit.
    cpuDeadline = Date.now() + (options.api === "playwright" ? 1000 : 100);
    const evaluated = vm.evalCode(source, "browser-program.js");

    if (evaluated.error) {
      const error = vm.dump(evaluated.error);
      evaluated.error.dispose();
      throw new Error(stopped || error.message || String(error));
    }

    program = evaluated.value;

    for (;;) {
      guard();
      cpuDeadline = Date.now() + 100;
      const jobs = vm.runtime.executePendingJobs(100);

      if (jobs.error) {
        const error = vm.dump(jobs.error);
        jobs.error.dispose();
        throw new Error(stopped || error.message || String(error));
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
        throw new Error(stopped || error.message || String(error));
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
