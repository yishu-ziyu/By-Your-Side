import { EFFECT_SETTLE_MAX_MS } from "../../../shared/effect.js";
import {
  GUIDE_INPUT_SETTLE_MS,
  classifyGuideTarget,
  formatGuideFieldAfter,
  guideInputWaitingCopy,
  guideSelectWaitingCopy,
  isSensitiveGuideField,
  shouldCompleteInput,
  type GuideTargetKind,
} from "../shared/guide-intent.js";
import { OVERLAY_ATTR } from "../shared/overlay.js";
import type { GuideCanvas } from "./guide-canvas.js";

const GUIDE_NO_CHANGE_TEXT = "点了之后，页面没有变化。再点一次。如果还是没变化，就在侧栏告诉我。";

const GUIDE_PRESS_MS = 1500;

const GUIDE_STATES = ["aria-checked", "aria-selected", "aria-expanded", "aria-pressed"];

export interface TutorGuideHost<Inst> {
  reducedMotion: MediaQueryList;
  guideCanvas(): GuideCanvas | null;
  actionName(el?: Element, fallback?: string): string;
  holdPoint(r: SideAgentRect, corner?: boolean): { x: number; y: number };
  holdAt(inst: Inst, point: { x: number; y: number }, target: string | undefined, el: Element): void;
  releaseHold(inst: Inst): void;
  hideCursor(inst: Inst): void;
  finishPark(inst: Inst): void;
  scheduleSettle(inst: Inst): void;
  isHoldingCorner(inst: Inst): boolean;
  spawnMark(inst: Inst, rect: SideAgentRect, label: string, target: string, options: MarkOptions | undefined, node: Node): HTMLDivElement | null;
  removeMark(el: HTMLDivElement): void;
  frameOfMark(el: HTMLDivElement): { frame: { x: number; y: number; w: number; h: number }; seed: number } | null;
}

export interface ActiveGuideView<Inst> {
  inst: Inst;
  mark: HTMLDivElement | null;
  label: string;
  name: string;
  misses: number;
  checking: boolean;
  step?: number;
  warn: boolean;
  targetElement(): Element | null;
}

export interface TutorGuideController<Inst> {
  start(inst: Inst, node: Node, say: string, target: string, portName: string, options?: MarkOptions): { name: string };
  active(): ActiveGuideView<Inst> | null;
  stop(): void;
}

interface GuideSession<Inst> {
  inst: Inst;
  node: Node;
  target: string;
  relocate: string | null;
  name: string;
  kind: GuideTargetKind;
  initialValue: string;
  inputTouched: boolean;
  options?: MarkOptions;
  step?: number;
  warn: boolean;
  mark: HTMLDivElement | null;
  label: string;
  rect: DOMRect | null;
  port: chrome.runtime.Port;
  observer: MutationObserver;
  resizeObserver?: ResizeObserver;
  misses: number;
  missed: boolean;
  lastChange: number;
  down: { at: number; url: string } | null;
  upTimer?: ReturnType<typeof setTimeout>;
  inputTimer?: ReturnType<typeof setTimeout>;
  scrollTimer?: ReturnType<typeof setTimeout>;
  watch: { since: number; url: string; timer: ReturnType<typeof setTimeout>; poll: ReturnType<typeof setInterval>; settled: boolean } | null;
}

function guideMissText(name: string): string {
  return name ? `这里不是要点的地方。点圈出来的「${name}」。` : "这里不是要点的地方。点圈出来的地方。";
}

function guideElement(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}

function nodeRect(node: Node): DOMRect | null {
  if (!node.isConnected) return null;
  let r: DOMRect;

  if (node instanceof Element) r = node.getBoundingClientRect();
  else {
    const range = document.createRange();
    range.selectNodeContents(node);
    r = range.getBoundingClientRect();
  }

  return r.width && r.height ? r : null;
}

function guideRole(el: Element): string {
  const explicit = el.getAttribute("role")?.trim().split(/\s+/)[0];

  if (explicit) return explicit;
  const type = el instanceof HTMLInputElement ? el.type : "";

  if (el.matches("button, input[type=button], input[type=submit]")) return "button";
  if (el.matches("a[href]")) return "link";
  if (type === "checkbox" || type === "radio") return type;
  if (el instanceof HTMLSelectElement) return "combobox";

  return "";
}

function guideCssPath(el: Element): string {
  const parts: string[] = [];

  for (let at: Element | null = el; at && at !== document.body && at !== document.documentElement; at = at.parentElement) {
    if (at.id && at !== el) { parts.unshift(`#${CSS.escape(at.id)}`); break; }
    const tag = at.tagName.toLowerCase();
    const same = at.parentElement ? [...at.parentElement.children].filter((c) => c.tagName === at!.tagName) : [at];
    parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(at) + 1})` : tag);
  }

  return parts.join(" > ");
}

function guideLocator(node: Node, target: string): string | null {
  if (!target.startsWith("@")) return target;
  const el = guideElement(node);
  const dom = window.__sideagent?.dom;

  if (!el || !dom) return null;
  const role = guideRole(el);
  const name = (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ");
  const candidates = [role && name && !name.includes('"') ? `loc=role:${role}[name="${name}"]` : "", el.id ? `#${CSS.escape(el.id)}` : "", guideCssPath(el)];

  for (const candidate of candidates) {
    if (!candidate) continue;

    try {
      if (dom.resolve(candidate) === el) return candidate;
    } catch {  }
  }

  return null;
}

function readControlValue(el: Element | null): string {
  if (!el) return "";
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return el.value;
  if (el instanceof HTMLElement && el.isContentEditable) return el.textContent ?? "";

  return "";
}

function detectTargetKind(el: Element | null): GuideTargetKind {
  if (!el) return "click";

  return classifyGuideTarget({
    tagName: el.tagName,
    inputType: el instanceof HTMLInputElement ? el.type : undefined,
    role: guideRole(el),
    contentEditable: el instanceof HTMLElement && el.isContentEditable,
  });
}

function pageMutated(records: MutationRecord[]): boolean {
  const own = (n: Node) => n instanceof Element && n.hasAttribute(OVERLAY_ATTR);

  return records.some((r) => {
    if (guideElement(r.target)?.closest(`[${OVERLAY_ATTR}]`)) return false;

    return !(r.type === "childList" && [...r.addedNodes, ...r.removedNodes].every(own));
  });
}

function needsScrollIntoView(r: DOMRect): boolean {
  const padY = Math.min(56, window.innerHeight * 0.15);

  return r.top < padY || r.bottom > window.innerHeight - padY || r.left < 16 || r.right > window.innerWidth - 16;
}

export function createTutorGuide<Inst>(host: TutorGuideHost<Inst>): TutorGuideController<Inst> {
  let guide: GuideSession<Inst> | null = null;

  function liveGuideNode(g: GuideSession<Inst>): Node {
    if (g.node.isConnected || !g.relocate) return g.node;

    try {
      const fresh = window.__sideagent?.dom?.resolve?.(g.relocate);

      if (fresh) g.node = fresh;
    } catch {  }

    return g.node;
  }

  function postGuide(g: GuideSession<Inst>, message: Record<string, unknown>): void {
    try { g.port.postMessage(message); } catch {  }
  }

  function drawGuideMark(g: GuideSession<Inst>, label: string, warn = false, animate = true): void {
    g.label = label;
    g.warn = warn;

    if (g.mark) host.removeMark(g.mark);
    const node = liveGuideNode(g);
    const r = nodeRect(node);

    if (r) g.rect = r;
    g.mark = r ? host.spawnMark(g.inst, r, label, g.target, g.options, node) : null;

    if (!r || !g.mark) {
      host.guideCanvas()?.clearSpotlight();

      return;
    }

    host.guideCanvas()?.showSpotlight(r);
    const meta = host.frameOfMark(g.mark);
    const labelEl = g.mark.querySelector<HTMLElement>(".mark-label");

    if (meta && labelEl) {
      host.guideCanvas()?.renderGuideOverlay({
        markEl: g.mark,
        labelEl,
        targetFrame: meta.frame,
        targetEl: guideElement(node),
        seed: meta.seed,
        animate,
        warn,
        step: g.step,
        cursorPoint: host.holdPoint(r, true),
      });
    }
  }

  function holdAtGuide(g: GuideSession<Inst>): void {
    const node = liveGuideNode(g);
    const el = guideElement(node);
    const r = nodeRect(node);

    if (!el || !r) return;
    host.holdAt(g.inst, host.holdPoint(r, true), g.relocate ?? undefined, el);
  }

  function followGuideNode(g: GuideSession<Inst>): void {
    const before = g.node;

    if (before.isConnected || liveGuideNode(g) === before) return;
    drawGuideMark(g, g.label, g.warn);

    if (host.isHoldingCorner(g.inst)) holdAtGuide(g);
  }

  function guideAfter(g: GuideSession<Inst>): string | undefined {
    const el = guideElement(liveGuideNode(g));

    if (!el?.isConnected) return undefined;
    const name = host.actionName(el).slice(0, 40);

    if (g.kind === "input") {
      const inputType = el instanceof HTMLInputElement ? el.type : undefined;
      const sensitive = isSensitiveGuideField(inputType, `${name} ${el.getAttribute("name") ?? ""} ${el.getAttribute("autocomplete") ?? ""}`);

      return formatGuideFieldAfter(guideRole(el) || el.tagName.toLowerCase(), name, { value: readControlValue(el), sensitive });
    }

    const states = GUIDE_STATES.flatMap((a) => (el.hasAttribute(a) ? [`${a}=${el.getAttribute(a)}`] : []));

    if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) states.push(`checked=${el.checked}`);
    if (el instanceof HTMLSelectElement) states.push(`value="${(el.selectedOptions[0]?.textContent ?? "").trim().slice(0, 30)}"`);

    return [guideRole(el) || el.tagName.toLowerCase(), name ? `"${name}"` : "", ...states].filter(Boolean).join(" ").slice(0, 120);
  }

  function stopWatch(g: GuideSession<Inst>): void {
    if (!g.watch) return;
    clearTimeout(g.watch.timer);
    clearInterval(g.watch.poll);
    g.watch = null;
  }

  function finishGuide(g: GuideSession<Inst>, changed: "dom" | "url" | "input" | "select"): void {
    const after = guideAfter(g);
    postGuide(g, { kind: "done", changed, ...(after ? { after } : {}), ...(changed === "url" ? { url: location.href } : {}) });
    endGuide(g, false);
  }

  function checkGuide(g: GuideSession<Inst>): void {
    const w = g.watch;

    if (!w) return;
    const changed = location.href !== w.url ? "url" : g.lastChange >= w.since ? "dom" : null;

    if (!changed) return;
    finishGuide(g, changed);
  }

  function guideNoChange(g: GuideSession<Inst>): void {
    const w = g.watch;

    if (!w || w.settled) return;
    w.settled = true;
    drawGuideMark(g, GUIDE_NO_CHANGE_TEXT, true);
    postGuide(g, { kind: "no_change" });
  }

  function isTargetEvent(g: GuideSession<Inst>, target: EventTarget | null, path?: EventTarget[]): boolean {
    const el = guideElement(liveGuideNode(g));

    if (!el) return false;
    if (path) {
      const labels = "labels" in el ? [...((el as HTMLInputElement).labels ?? [])] : [];

      return path.includes(el) || labels.some((label) => path.includes(label));
    }

    return target instanceof Node && (el === target || el.contains(target));
  }

  function tryCompleteInput(g: GuideSession<Inst>, trigger: "enter" | "blur" | "change" | "idle"): void {
    if (g.kind !== "input") return;
    const el = guideElement(liveGuideNode(g));
    const current = readControlValue(el);

    if (!shouldCompleteInput(g.initialValue, current, trigger)) return;
    clearTimeout(g.inputTimer);
    finishGuide(g, "input");
  }

  function onGuideInput(ev: Event): void {
    const g = guide;

    if (!g || !ev.isTrusted || g.kind !== "input") return;
    if (!isTargetEvent(g, ev.target, ev.composedPath())) return;
    g.inputTouched = true;
    clearTimeout(g.inputTimer);
    g.inputTimer = setTimeout(() => {
      if (guide === g) tryCompleteInput(g, "idle");
    }, GUIDE_INPUT_SETTLE_MS);
  }

  function onGuideChange(ev: Event): void {
    const g = guide;

    if (!g || !ev.isTrusted) return;
    if (!isTargetEvent(g, ev.target, ev.composedPath())) return;

    if (g.kind === "select") {
      finishGuide(g, "select");

      return;
    }

    if (g.kind === "input") tryCompleteInput(g, "change");
  }

  function onGuideKeyDown(ev: KeyboardEvent): void {
    const g = guide;

    if (!g || !ev.isTrusted || g.kind !== "input" || ev.key !== "Enter" || ev.isComposing) return;
    if (!isTargetEvent(g, ev.target, ev.composedPath())) return;
    const el = guideElement(liveGuideNode(g));

    if (el instanceof HTMLTextAreaElement && !ev.metaKey && !ev.ctrlKey) return;
    setTimeout(() => { if (guide === g) tryCompleteInput(g, "enter"); }, 40);
  }

  function onGuideBlur(ev: FocusEvent): void {
    const g = guide;

    if (!g || g.kind !== "input" || !g.inputTouched) return;
    if (!isTargetEvent(g, ev.target)) return;
    tryCompleteInput(g, "blur");
  }

  function onGuideDown(ev: PointerEvent): void {
    const g = guide;

    if (!g || !ev.isTrusted) return;
    g.down = { at: performance.now(), url: location.href };

    if (g.watch?.settled) stopWatch(g);
  }

  function onGuideMove(ev: PointerEvent): void {
    const g = guide;

    if (!g || !ev.isTrusted || !g.missed) return;
    g.missed = false;

    if (host.isHoldingCorner(g.inst)) {
      host.releaseHold(g.inst);
      host.finishPark(g.inst);
    }
  }

  function onGuideUp(ev: PointerEvent): void {
    const g = guide;

    if (!g || !ev.isTrusted || ev.button !== 0) return;
    clearTimeout(g.upTimer);
    const path = ev.composedPath();
    g.upTimer = setTimeout(() => onGuidePress(ev, path), 50);
  }

  function onGuideClick(ev: MouseEvent): void {
    if (!guide || !ev.isTrusted) return;
    clearTimeout(guide.upTimer);
    onGuidePress(ev, ev.composedPath());
  }

  function onGuidePress(ev: MouseEvent, path: EventTarget[]): void {
    const g = guide;

    if (!g || (g.watch && !g.watch.settled)) return;
    if (path.some((n) => n instanceof Element && n.hasAttribute(OVERLAY_ATTR))) return;
    stopWatch(g);
    const node = liveGuideNode(g);
    const onPath = isTargetEvent(g, ev.target, path);
    const r = !node.isConnected || path.length === 0 ? nodeRect(node) ?? g.rect : null;
    const inside = !!r && ev.clientX >= r.left - 4 && ev.clientX <= r.right + 4 && ev.clientY >= r.top - 4 && ev.clientY <= r.bottom + 4;

    if (!onPath && !inside) {
      if (g.kind === "input" && g.inputTouched) {
        tryCompleteInput(g, "blur");

        return;
      }

      g.misses += 1;
      g.missed = true;
      drawGuideMark(g, guideMissText(g.name), true);
      holdAtGuide(g);
      postGuide(g, { kind: "miss", misses: g.misses });

      return;
    }

    postGuide(g, { kind: "hit" });

    // WHY: Clicking into an input or select only opens focus/dropdown; wait for real input/change instead of flagging no_change.
    if (g.kind === "input") {
      if (host.isHoldingCorner(g.inst)) {
        host.releaseHold(g.inst);
        host.finishPark(g.inst);
      }
      drawGuideMark(g, guideInputWaitingCopy(g.name), false, false);

      return;
    }

    if (g.kind === "select") {
      drawGuideMark(g, guideSelectWaitingCopy(g.name), false, false);

      return;
    }

    const now = performance.now();
    const pressed = g.down && now - g.down.at < GUIDE_PRESS_MS ? g.down : null;
    g.watch = {
      since: pressed?.at ?? now,
      url: pressed?.url ?? location.href,
      timer: setTimeout(() => guideNoChange(g), EFFECT_SETTLE_MAX_MS),
      poll: setInterval(() => checkGuide(g), 100),
      settled: false,
    };
    checkGuide(g);
  }

  function endGuide(g: GuideSession<Inst>, hidePointer = false): void {
    if (guide !== g) return;
    guide = null;
    window.removeEventListener("click", onGuideClick, true);
    window.removeEventListener("pointerdown", onGuideDown, true);
    window.removeEventListener("pointermove", onGuideMove, true);
    window.removeEventListener("pointerup", onGuideUp, true);
    window.removeEventListener("input", onGuideInput, true);
    window.removeEventListener("change", onGuideChange, true);
    window.removeEventListener("keydown", onGuideKeyDown, true);
    window.removeEventListener("blur", onGuideBlur, true);
    clearTimeout(g.upTimer);
    clearTimeout(g.inputTimer);
    clearTimeout(g.scrollTimer);
    g.observer.disconnect();
    g.resizeObserver?.disconnect();
    stopWatch(g);

    if (g.mark) host.removeMark(g.mark);
    g.mark = null;
    host.guideCanvas()?.clearSpotlight();

    if (hidePointer) {
      host.hideCursor(g.inst);
    } else if (host.isHoldingCorner(g.inst)) {
      host.releaseHold(g.inst);
      host.scheduleSettle(g.inst);
    }
  }

  function start(inst: Inst, node: Node, say: string, target: string, portName: string, options?: MarkOptions): { name: string } {
    if (guide) {
      const old = guide;
      endGuide(old);

      try { old.port.disconnect(); } catch {  }
    }

    const el = guideElement(node);
    const initialRect = nodeRect(node);

    if (el && initialRect && needsScrollIntoView(initialRect)) {
      el.scrollIntoView({ block: "center", inline: "nearest", behavior: host.reducedMotion.matches ? "auto" : "smooth" });
    }

    const full = host.actionName(el ?? undefined);
    const port = chrome.runtime.connect({ name: portName });
    const kind = detectTargetKind(el);

    const g: GuideSession<Inst> = {
      inst,
      node,
      target,
      options,
      step: options?.step,
      warn: false,
      relocate: guideLocator(node, target),
      name: full.length > 20 ? `${full.slice(0, 19)}…` : full,
      kind,
      initialValue: readControlValue(el),
      inputTouched: false,
      mark: null,
      label: say,
      rect: null,
      port,
      observer: new MutationObserver((records) => {
        if (!pageMutated(records)) return;
        g.lastChange = performance.now();
        checkGuide(g);

        if (guide === g) followGuideNode(g);
      }),
      misses: 0,
      missed: false,
      lastChange: -1,
      down: null,
      watch: null,
    };

    guide = g;
    port.onDisconnect.addListener(() => endGuide(g, true));
    g.observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    if (el && typeof ResizeObserver !== "undefined") {
      g.resizeObserver = new ResizeObserver(() => {
        if (guide === g) followGuideNode(g);
      });
      g.resizeObserver.observe(el);
    }
    window.addEventListener("click", onGuideClick, true);
    window.addEventListener("pointerdown", onGuideDown, true);
    window.addEventListener("pointermove", onGuideMove, true);
    window.addEventListener("pointerup", onGuideUp, true);
    window.addEventListener("input", onGuideInput, true);
    window.addEventListener("change", onGuideChange, true);
    window.addEventListener("keydown", onGuideKeyDown, true);
    window.addEventListener("blur", onGuideBlur, true);
    drawGuideMark(g, say);
    holdAtGuide(g);

    if (el && initialRect && needsScrollIntoView(initialRect)) {
      g.scrollTimer = setTimeout(() => {
        if (guide !== g) return;
        drawGuideMark(g, g.label, g.warn, false);
        if (host.isHoldingCorner(g.inst)) holdAtGuide(g);
      }, host.reducedMotion.matches ? 20 : 320);
    }

    return { name: g.name };
  }

  return {
    start,
    active(): ActiveGuideView<Inst> | null {
      if (!guide) return null;
      const g = guide;

      return {
        inst: g.inst,
        mark: g.mark,
        label: g.label,
        name: g.name,
        misses: g.misses,
        checking: Boolean(g.watch && !g.watch.settled),
        step: g.step,
        warn: g.warn,
        targetElement: () => guideElement(liveGuideNode(g)),
      };
    },
    stop(): void {
      if (guide) endGuide(guide, true);
    },
  };
}
