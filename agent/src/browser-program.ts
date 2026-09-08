import { getQuickJS, type QuickJSDeferredPromise, type QuickJSHandle } from "quickjs-emscripten";
import { TOOL_NAMES, type ToolName } from "../../shared/protocol.js";
import { USER_BLOCKED_ERROR } from "../../shared/control.js";

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
  call(name: ToolName, params: Record<string, unknown>): Promise<unknown>;
  signal?: AbortSignal;
  id?: string;
  timeoutMs?: number;
  onStep?(step: ProgramStep): void;
}

const METHODS = [...TOOL_NAMES.filter(name => name !== "worker_tabs"), "waitFor", "sleep"];
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

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
  const stop = (reason: string) => { stopped ||= reason; return new Error(stopped); };
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
    if (!Number.isFinite(ms) || ms < 0 || ms > 10_000) throw new Error("sleep.ms must be between 0 and 10000");
    const until = Date.now() + ms;
    while (Date.now() < until) { guard(); await pause(Math.min(50, until - Date.now())); }
    guard();
    return { waitedMs: ms };
  }

  async function waitFor(params: Record<string, unknown>) {
    if (typeof params.selector !== "string" || !params.selector) throw new Error("wait_for requires a native CSS selector");
    const timeout = Number(params.timeoutMs ?? 5000);
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 30_000) throw new Error("wait_for.timeoutMs must be between 1 and 30000");
    const until = Math.min(deadline, Date.now() + timeout);
    let polls = 0;
    let last: unknown;
    const code = `(() => {const es=document.querySelectorAll(${JSON.stringify(params.selector)}); if(es.length>1) throw Error('wait_for matched multiple elements; use a unique selector'); const e=es[0]; if(!e)return {ready:false,count:0}; const r=e.getBoundingClientRect(),s=getComputedStyle(e); return {ready:r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&!e.disabled,count:1};})()`;
    do {
      guard();
      const data = await options.call("js", { code }) as { value?: { ready?: boolean } };
      last = data.value;
      polls++;
      guard();
      if (data.value?.ready) return { ready: true, polls, last };
      if (Date.now() >= until) break;
      await sleep(Math.max(0, Math.min(150, until - Date.now())));
    } while (Date.now() <= until);
    throw new Error(`wait_for ${params.selector} timed out after ${timeout}ms (${polls} polls; last=${JSON.stringify(last)})`);
  }

  const bridge = vm.newFunction("browserCall", (nameHandle, paramsHandle) => {
    guard();
    if (pending.size >= 32) throw stop("Too many pending browser calls; await each operation");
    const name = vm.getString(nameHandle);
    if (!METHODS.includes(name)) throw new Error(`Unknown browser method: ${name}`);
    const params = JSON.parse(vm.getString(paramsHandle)) as Record<string, unknown>;
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("Browser parameters must be an object");
    const deferred = vm.newPromise();
    pending.add(deferred);
    chain = chain.then(async () => {
      if (closed || stopped || options.signal?.aborted) return;
      const id = `${options.id ?? "program"}/${++steps}`;
      const step = { parentId: options.id ?? "program", id, name: name === "waitFor" ? "wait_for" : name, params };
      const started = Date.now();
      let actualResult: unknown;
      emit({ ...step, phase: "start" });
      try {
        guard();
        const result = actualResult = name === "sleep" ? await sleep(Number(params.ms ?? 0))
          : name === "waitFor" ? await waitFor(params)
          : await options.call(name as ToolName, params);
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
        if (text.includes(USER_BLOCKED_ERROR) || /disconnect|not connected|Tool call .* timed out/i.test(text)) stop(text);
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
    cpuDeadline = Date.now() + 100;
    const evaluated = vm.evalCode(`(async()=>{const value=await(async()=>{\n${options.code}\n})();return JSON.stringify(value===undefined?null:value);})()`, "browser-program.js");
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
