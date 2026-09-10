/**
 * 示范录制 content script（ISOLATED world，按需注入，重复注入幂等）。
 *
 * 只在用户点「看我做」之后记录**用户自己的**页面动作；不代劳、不解释。
 * 只记语义锚点与动作：不记坐标、不记 DOM 路径、不记敏感字段内容（见 shared/demo-record.ts）。
 * 记录结果经 chrome.runtime.sendMessage 交给 background，页面侧不落盘。
 */
import { anchorFor, isSensitiveField, pushStep, scrubUrl, type DemoStep } from "../../../shared/demo-record.js";
import { anchorOfTarget, insideOverlay, sourceOf } from "../shared/dom-anchor.js";

interface RecordApi {
  /** seed：导航后重新注入时带上已记下的步骤与已过时间，接着记而不是重开一份 */
  start(seed?: { steps?: DemoStep[]; elapsedMs?: number }): { ok: true };
  /** 停止并上行最后一批；count 是页面侧真实记下的步数，供 background 核对最后一批是否到齐 */
  stop(): { ok: true; count: number };
  recording(): boolean;
  /** 自检：只读的录制状态，供隔离浏览器验收核对，生产路径不用 */
  selfCheck(): { recording: boolean; count: number; truncated: boolean; lastKind: string | null };
}

(function () {
  const ns = window.__sideagent as unknown as { record?: RecordApi } | undefined;
  if (ns?.record) return; // 重复注入幂等
  const store = (window.__sideagent ??= {}) as unknown as { record?: RecordApi };

  const TEXTUAL_INPUT = new Set(["", "text", "search", "email", "tel", "url", "number", "password", "date", "datetime-local", "month", "week", "time"]);
  const PRESS_KEYS = new Set(["Enter", "Tab", "Escape"]);

  let recording = false;
  let startedAt = 0;
  let steps: DemoStep[] = [];
  let truncated = false;
  let lastPost = 0;

  function now(): number {
    return Math.round(performance.now() - startedAt);
  }

  function page(): string | undefined {
    return scrubUrl(location.href);
  }

  function record(step: DemoStep): void {
    const result = pushStep(steps, step);
    steps = result.steps;
    truncated = truncated || result.truncated;
    const t = now();
    // 合并期内的连续输入不必每击键都上行，省掉无意义的通道流量。
    if (t - lastPost < 250) return;
    lastPost = t;
    post();
  }

  function post(): void {
    try {
      void chrome.runtime.sendMessage({
        type: "sideagent:demo-step",
        steps,
        truncated,
      });
    } catch {
      /* 连接不可用时静默：示范记录失败由 background 的停止指令收口 */
    }
  }

  function onClick(ev: MouseEvent): void {
    if (!recording || ev.button !== 0 || insideOverlay(ev.target)) return;
    const hit = anchorOfTarget(ev.target);
    if (!hit) return;
    record({ at: now(), kind: "click", anchor: hit.anchor, page: page() });
  }

  function onInput(ev: Event): void {
    if (!recording || insideOverlay(ev.target)) return;
    const el = ev.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return;
    const src = sourceOf(el);
    if (el instanceof HTMLInputElement && !TEXTUAL_INPUT.has((el.type ?? "").toLowerCase())) return;
    const sensitive = isSensitiveField(src);
    const value = el instanceof HTMLSelectElement ? (el.selectedOptions[0]?.textContent ?? el.value) : el.value;
    record({
      at: now(),
      kind: "type",
      anchor: anchorFor(src),
      ...(sensitive ? { redacted: true as const } : { value }),
      page: page(),
    });
  }

  function onKeydown(ev: KeyboardEvent): void {
    if (!recording || insideOverlay(ev.target)) return;
    if (!PRESS_KEYS.has(ev.key)) return;
    record({ at: now(), kind: "press", key: ev.key, page: page() });
  }

  function onSubmit(ev: Event): void {
    if (!recording || insideOverlay(ev.target)) return;
    record({ at: now(), kind: "submit", page: page() });
  }

  function attach(on: boolean): void {
    const fn = on ? document.addEventListener.bind(document) : document.removeEventListener.bind(document);
    fn("click", onClick as EventListener, true);
    fn("input", onInput, true);
    fn("change", onInput, true);
    fn("keydown", onKeydown as EventListener, true);
    fn("submit", onSubmit, true);
  }

  store.record = {
    start(seed?: { steps?: DemoStep[]; elapsedMs?: number }) {
      if (recording) return { ok: true };
      recording = true;
      // performance.now() 每次导航都会归零，所以续录传的是"已过多少毫秒"，不是上一次的基线。
      const elapsed = typeof seed?.elapsedMs === "number" && seed.elapsedMs > 0 ? seed.elapsedMs : 0;
      startedAt = performance.now() - elapsed;
      steps = Array.isArray(seed?.steps) ? seed.steps.slice() : [];
      truncated = false;
      lastPost = 0;
      attach(true);
      return { ok: true };
    },
    stop() {
      if (!recording) return { ok: true, count: steps.length };
      recording = false;
      attach(false);
      post();
      return { ok: true, count: steps.length };
    },
    recording() {
      return recording;
    },
    selfCheck() {
      return { recording, count: steps.length, truncated, lastKind: steps[steps.length - 1]?.kind ?? null };
    },
  };
})();
