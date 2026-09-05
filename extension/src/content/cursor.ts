/**
 * Agent 虚拟鼠标 overlay content script（ISOLATED world，重复注入幂等）。
 * 暴露 window.__sideagent.cursor = { move, click, hide, highlight, mark, clearMarks, for(id) }。
 * mark 标注挂在独立的 absolute host（文档坐标）。window 滚动靠文档坐标天然跟随；
 * 内部滚动容器不会改 window.scroll，必须在 scroll 捕获期按锚定元素的最新
 * getBoundingClientRect 重算。resize / visualViewport 同路径重算 mark；光标/高亮
 * 只在 viewport 尺寸变化时收起（滚动不拆瞬时层）。
 * 默认实例（名牌 "SideAgent"）供单任务使用；for(id) 返回实例专属光标（名册上的人），
 * 为多任务并行准备的渲染层——每个并行 Agent 一个名字和颜色。
 *
 * shadow DOM（closed）隔离页面样式；host pointer-events:none + 最高 z-index，不干扰页面交互。
 * 坐标均为视口坐标系（与 Input.dispatchMouseEvent / getBoundingClientRect 一致）。
 *
 * 视觉参考：tldraw 协作光标（彩色填充 + 白描边 + 深色外晕 + 名牌 pill）、ChatGPT Agent（点击波纹）。
 * 轨迹：浅弧（ghost-cursor 一侧弧去掉随机）+ Fitts 时长 + easeInOutCubic。
 * 闲着停角落，要点再飞过去；不 3 秒隐掉。
 * 箭头形状取自 lucide MousePointer2（ISC）。
 *
 * 生命周期：MV3 扩展 reload 会销毁 isolated world 但留下 DOM host。启动时若本 world
 * 还没有 cursor API，按 data-sideagent-overlay 清掉旧 host 再创建。
 */
import { isMarkActionId, parseMarkActions } from "../shared/mark-actions.js";
import { markLabelPlacement } from "../shared/mark-label.js";
import type { MarkAction } from "../../../shared/protocol.js";
import { cursorColor, LEAD_CURSOR_ID } from "../shared/palette.js";
import { displayNameFor } from "../../../shared/cast.js";
import {
  CURSOR_ARROW_PATH,
  CURSOR_STROKE_HALO,
  CURSOR_STROKE_WHITE,
  CURSOR_SVG_SIZE,
  CURSOR_TIP,
} from "../shared/cursor-visual.js";
import {
  PARK_AFTER_MS,
  easeInOutCubic,
  flightMs,
  pointOnArc,
  restOnRight,
  restPoint,
} from "../shared/cursor-path.js";
import {
  HIGHLIGHT_PAD,
  MARK_PAD,
  OVERLAY_ATTR,
  OVERLAY_KIND_CONTROL,
  OVERLAY_KIND_CURSOR,
  OVERLAY_KIND_MARKS,
  highlightBounds,
  sweepStaleOverlayHosts,
  viewportRectToDocumentBox,
} from "../shared/overlay.js";

(function () {
  const ns = (window.__sideagent ??= {});
  // 同一 world 重复注入：保留现有实例。新 world（扩展 reload）先清旧 DOM 再挂。
  if (!ns.cursor) sweepStaleOverlayHosts(document);
  if (ns.cursor) return;

  const SCALE = CURSOR_SVG_SIZE / 24;
  const DEFAULT_ID = LEAD_CURSOR_ID;
  const DEFAULT_LABEL = "SideAgent";

  interface Instance {
    el: HTMLDivElement;
    color: string;
    visible: boolean;
    restIndex: number;
    pos: { x: number; y: number };
    resting: boolean;
    raf?: number;
    parkTimer?: ReturnType<typeof setTimeout>;
    pressTimer?: ReturnType<typeof setTimeout>;
    replayTimer?: ReturnType<typeof setTimeout>;
    replayGen?: number;
    highlightEl?: HTMLDivElement;
  }

  interface LiveMark {
    el: HTMLDivElement;
    anchor: Element | null;
    target?: string;
    pad: number;
    label?: string;
    actions?: MarkAction[];
  }

  let host: HTMLDivElement | null = null;
  let marksHost: HTMLDivElement | null = null;
  let controlHost: HTMLDivElement | null = null;
  let controlBar: HTMLDivElement | null = null;
  let shadow: ShadowRoot | null = null;
  let highlightLayer: HTMLDivElement | null = null;
  let rippleLayer: HTMLDivElement | null = null;
  let marksLayer: HTMLDivElement | null = null;
  let viewportHooked = false;
  const instances = new Map<string, Instance>();
  const liveMarks: LiveMark[] = [];

  function ensureDom(): void {
    if (host) return;
    host = document.createElement("div");
    host.setAttribute(OVERLAY_ATTR, OVERLAY_KIND_CURSOR);
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
    shadow = host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = `
      .cursor {
        position: absolute; top: 0; left: 0;
        transition: opacity 160ms ease;
        will-change: transform;
      }
      .cursor.hidden { opacity: 0; }
      .cursor.rest { opacity: .86; }
      .cursor.rest .label { opacity: 0; }
      .cursor.flip .label { left: auto; right: 18px; }
      .svg-wrap {
        position: absolute; left: 0; top: 0;
        transition: transform 130ms ease;
        transform-origin: ${(CURSOR_TIP.x * SCALE).toFixed(1)}px ${(CURSOR_TIP.y * SCALE).toFixed(1)}px;
      }
      .cursor.pressing .svg-wrap { transform: scale(.8); }
      .cursor svg {
        position: absolute; display: block; overflow: visible;
        left: ${(-CURSOR_TIP.x * SCALE).toFixed(1)}px; top: ${(-CURSOR_TIP.y * SCALE).toFixed(1)}px;
        filter: drop-shadow(0 0 1px #fff) drop-shadow(0 2px 6px rgba(15,23,42,.55));
      }
      .cursor path.fill { fill: var(--c); }
      .cursor path.halo { fill: none; }
      .label {
        position: absolute; left: 22px; top: 24px;
        padding: 2px 9px; border-radius: 999px;
        background: var(--c); color: #fff;
        font: 600 12px/1.7 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
        letter-spacing: .02em; white-space: nowrap;
        box-shadow: 0 0 0 1px rgba(255,255,255,.7), 0 2px 8px rgba(15,23,42,.35);
        text-shadow: 0 1px 1px rgba(15,23,42,.35);
        transition: opacity 160ms ease;
      }
      .ripple {
        position: absolute; width: 12px; height: 12px; margin: -6px 0 0 -6px;
        border-radius: 50%; border: 2px solid;
        animation: rip 480ms cubic-bezier(.22,1,.36,1) forwards;
      }
      .ripple.r2 {
        width: 6px; height: 6px; margin: -3px 0 0 -3px;
        border-width: 1.5px; animation-delay: 90ms;
      }
      @keyframes rip {
        from { transform: scale(.5); opacity: .95; }
        to { transform: scale(4.2); opacity: 0; }
      }
      .highlight {
        position: absolute;
        box-sizing: border-box;
        pointer-events: none;
        border-radius: 6px;
        border: 2px solid var(--c);
        background: color-mix(in srgb, var(--c) 12%, transparent);
        box-shadow: 0 0 0 1px rgba(255,255,255,0.4), 0 0 14px color-mix(in srgb, var(--c) 45%, transparent);
        animation: highlight-breathe 500ms cubic-bezier(.25, 1, .5, 1) forwards;
        will-change: opacity, transform;
      }
      @keyframes highlight-breathe {
        0% { opacity: 0; transform: scale(0.97); }
        20% { opacity: 1; transform: scale(1); }
        45% { opacity: 0.35; transform: scale(1); }
        70% { opacity: 0.95; transform: scale(1); }
        100% { opacity: 0; transform: scale(1.01); }
      }
    `;
    shadow.appendChild(style);

    highlightLayer = document.createElement("div");
    shadow.appendChild(highlightLayer);

    rippleLayer = document.createElement("div");
    shadow.appendChild(rippleLayer);
    (document.documentElement ?? document.body).appendChild(host);
    hookViewport();
  }

  function ensureMarksDom(): void {
    if (marksLayer) return;
    marksHost = document.createElement("div");
    marksHost.setAttribute(OVERLAY_ATTR, OVERLAY_KIND_MARKS);
    marksHost.setAttribute("aria-hidden", "true");
    marksHost.style.cssText =
      "position:absolute;left:0;top:0;width:0;height:0;z-index:2147483646;pointer-events:none;";
    const marksShadow = marksHost.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      .mark {
        position: absolute; box-sizing: border-box; pointer-events: none;
        border: 2.5px solid var(--c); border-radius: 8px;
        background: color-mix(in srgb, var(--c) 7%, transparent);
        box-shadow: 0 0 0 1px rgba(255,255,255,.5), 0 0 16px color-mix(in srgb, var(--c) 40%, transparent);
      }
      .mark-arrow {
        position: absolute; left: -30px; top: 50%; transform: translateY(-50%);
        display: block; overflow: visible;
        filter: drop-shadow(0 1px 2px rgba(15,23,42,.35));
      }
      .mark-arrow path, .mark-arrow line { stroke: var(--c); }
      .mark-label {
        position: absolute; left: -3px; top: -26px;
        padding: 1px 8px; border-radius: 999px;
        background: var(--c); color: #fff;
        font: 600 11px/1.7 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
        letter-spacing: .02em; white-space: nowrap;
        box-shadow: 0 2px 6px rgba(15,23,42,.25);
      }
      .mark-label.below { top: calc(100% + 6px); }
      .mark-actions {
        position: absolute; left: 0; top: calc(100% + 10px);
        display: flex; gap: 8px; pointer-events: none;
      }
      .mark-action {
        pointer-events: auto; cursor: pointer;
        font: 600 13px/1.2 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
        padding: 6px 12px; border-radius: 8px;
      }
      .mark-action.confirm {
        background: #c43c32; color: #fff; border: 0;
      }
      .mark-action.cancel {
        background: #fff; color: #1c1916;
        border: 1px solid rgba(15, 23, 42, .18);
      }
      .mark-action:disabled { opacity: .45; cursor: default; }
    `;
    marksShadow.appendChild(style);
    marksLayer = document.createElement("div");
    marksShadow.appendChild(marksLayer);
    (document.documentElement ?? document.body).appendChild(marksHost);
    hookViewport();
  }

  function hookViewport(): void {
    if (viewportHooked) return;
    viewportHooked = true;
    window.addEventListener("resize", onViewportResize);
    window.visualViewport?.addEventListener("resize", onViewportResize);
    // scroll 不冒泡；捕获才能听到内部 overflow 容器。滚动只重锚 mark，不收光标。
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.visualViewport?.addEventListener("scroll", onScroll, { passive: true });
  }

  function onViewportResize(): void {
    for (const inst of instances.values()) {
      if (inst.highlightEl) {
        inst.highlightEl.remove();
        inst.highlightEl = undefined;
      }
      cancelFly(inst);
      if (inst.visible) {
        const home = restPoint(inst.restIndex, window.innerWidth);
        setPos(inst, home);
        setResting(inst, true);
      }
    }
    relayoutMarks();
  }

  function onScroll(): void {
    relayoutMarks();
  }

  function liveAnchor(mark: LiveMark): Element | null {
    if (mark.anchor?.isConnected) return mark.anchor;
    if (mark.target) {
      const el = window.__sideagent?.dom?.resolve?.(mark.target) ?? null;
      if (el) mark.anchor = el;
      return el;
    }
    return null;
  }

  function relayoutMarks(): void {
    if (liveMarks.length === 0) return;
    for (const mark of liveMarks) {
      const anchor = liveAnchor(mark);
      if (!anchor) {
        mark.el.style.visibility = "hidden";
        continue;
      }
      mark.el.style.visibility = "";
      const r = anchor.getBoundingClientRect();
      applyMarkBox(
        mark.el,
        { x: r.x, y: r.y, width: r.width, height: r.height },
        mark.pad,
        mark.label,
        Boolean(mark.actions?.length),
      );
    }
  }

  function getInstance(id: string): Instance {
    const existing = instances.get(id);
    if (existing) return existing;
    ensureDom();
    const el = document.createElement("div");
    el.className = "cursor hidden";
    el.innerHTML =
      `<div class="svg-wrap"><svg width="${CURSOR_SVG_SIZE}" height="${CURSOR_SVG_SIZE}" viewBox="0 0 24 24">` +
      `<path class="halo" d="${CURSOR_ARROW_PATH}" fill="none" stroke="#0f172a" stroke-width="${CURSOR_STROKE_HALO}" stroke-linejoin="round"/>` +
      `<path class="fill" d="${CURSOR_ARROW_PATH}" stroke="#ffffff" stroke-width="${CURSOR_STROKE_WHITE}" stroke-linejoin="round"/>` +
      `</svg></div>` +
      `<div class="label">${id === DEFAULT_ID ? DEFAULT_LABEL : displayNameFor(id)}</div>`;
    const color = cursorColor(id);
    el.style.setProperty("--c", color);
    shadow!.appendChild(el);
    const restIndex = instances.size;
    const home = restPoint(restIndex, window.innerWidth);
    const inst: Instance = {
      el,
      color,
      visible: false,
      restIndex,
      pos: home,
      resting: true,
    };
    instances.set(id, inst);
    return inst;
  }

  function setPos(inst: Instance, p: { x: number; y: number }): void {
    inst.pos = p;
    inst.el.style.transform = `translate(${p.x}px, ${p.y}px)`;
  }

  function setResting(inst: Instance, on: boolean): void {
    inst.resting = on;
    inst.el.classList.toggle("rest", on);
    inst.el.classList.toggle("flip", on && restOnRight(inst.restIndex));
  }

  function cancelFly(inst: Instance): void {
    if (inst.raf !== undefined) {
      cancelAnimationFrame(inst.raf);
      inst.raf = undefined;
    }
  }

  function showAtRest(inst: Instance): void {
    const home = restPoint(inst.restIndex, window.innerWidth);
    setPos(inst, home);
    setResting(inst, true);
    inst.el.classList.remove("hidden");
    inst.visible = true;
  }

  function flyTo(inst: Instance, to: { x: number; y: number }): number {
    cancelFly(inst);
    const from = inst.pos;
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    if (dist < 2) {
      setPos(inst, to);
      return 0;
    }
    const ms = flightMs(from, to);
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / ms);
      setPos(inst, pointOnArc(from, to, easeInOutCubic(t)));
      if (t < 1) inst.raf = requestAnimationFrame(tick);
      else {
        inst.raf = undefined;
        setPos(inst, to);
      }
    };
    inst.raf = requestAnimationFrame(tick);
    return ms;
  }

  function schedulePark(inst: Instance): void {
    clearTimeout(inst.parkTimer);
    inst.parkTimer = setTimeout(() => {
      const home = restPoint(inst.restIndex, window.innerWidth);
      setResting(inst, true);
      flyTo(inst, home);
    }, PARK_AFTER_MS);
  }

  function spawnRipple(x: number, y: number, cls: string, color: string): void {
    const ripple = document.createElement("div");
    ripple.className = cls;
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    ripple.style.borderColor = color;
    ripple.addEventListener("animationend", () => ripple.remove(), { once: true });
    rippleLayer!.appendChild(ripple);
  }

  function spawnHighlight(inst: Instance, rect: SideAgentRect): void {
    const bounds = highlightBounds(rect, HIGHLIGHT_PAD);
    if (!bounds) return;
    ensureDom();
    if (inst.highlightEl) {
      inst.highlightEl.remove();
      inst.highlightEl = undefined;
    }
    const el = document.createElement("div");
    el.className = "highlight";
    el.style.setProperty("--c", inst.color);
    el.style.left = `${bounds.left}px`;
    el.style.top = `${bounds.top}px`;
    el.style.width = `${bounds.width}px`;
    el.style.height = `${bounds.height}px`;

    const remove = () => {
      el.remove();
      if (inst.highlightEl === el) {
        inst.highlightEl = undefined;
      }
    };
    el.addEventListener("animationend", remove, { once: true });
    setTimeout(remove, 650);
    inst.highlightEl = el;
    highlightLayer!.appendChild(el);
  }

  function resolveAnchor(rect: SideAgentRect, target?: string): Element | null {
    if (target) {
      const el = window.__sideagent?.dom?.resolve?.(target);
      if (el) return el;
    }
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    return document.elementFromPoint(cx, cy);
  }

  function applyMarkBox(
    el: HTMLDivElement,
    rect: SideAgentRect,
    pad: number,
    label?: string,
    hasActions?: boolean,
  ): void {
    const box = viewportRectToDocumentBox(rect, window.scrollX, window.scrollY, pad);
    if (!box) return;
    el.style.left = `${box.x}px`;
    el.style.top = `${box.y}px`;
    el.style.width = `${box.width}px`;
    el.style.height = `${box.height}px`;
    const labelEl = el.querySelector(".mark-label");
    if (labelEl && label) {
      // 框外已有双键时名牌不再翻到下方，避免和按钮叠在一起。
      const below = !hasActions && markLabelPlacement(rect.y) === "below";
      labelEl.classList.toggle("below", below);
    }
  }

  function armMarkActions(el: HTMLDivElement, actions: MarkAction[]): void {
    const row = document.createElement("div");
    row.className = "mark-actions";
    for (const action of actions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `mark-action ${action.id}`;
      btn.dataset.action = action.id;
      btn.textContent = action.label;
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (el.dataset.armed === "0") return;
        el.dataset.armed = "0";
        for (const b of row.querySelectorAll("button")) b.disabled = true;
        try {
          chrome.runtime.sendMessage({ type: "mark_action", action: action.id }, () => {
            void chrome.runtime.lastError;
          });
        } catch {
          /* 无扩展运行时（自检页）忽略 */
        }
      });
      row.appendChild(btn);
    }
    el.appendChild(row);
  }

  function spawnMark(
    inst: Instance,
    rect: SideAgentRect,
    label?: string,
    target?: string,
    actions?: MarkAction[],
  ): void {
    const box = viewportRectToDocumentBox(rect, window.scrollX, window.scrollY, MARK_PAD);
    if (!box) return;
    ensureMarksDom();
    const el = document.createElement("div");
    el.className = "mark";
    el.style.setProperty("--c", inst.color);
    el.innerHTML =
      `<svg class="mark-arrow" width="24" height="24" viewBox="0 0 24 24" fill="none">` +
      `<path d="M2 12h17m-6-6 6 6-6 6" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>` +
      `</svg>` +
      (label ? `<div class="mark-label"></div>` : "");
    if (label) {
      const labelEl = el.querySelector(".mark-label")!;
      labelEl.textContent = label;
    }
    const parsed = parseMarkActions(actions);
    if (parsed) armMarkActions(el, parsed);
    applyMarkBox(el, rect, MARK_PAD, label, Boolean(parsed?.length));
    marksLayer!.appendChild(el);
    liveMarks.push({
      el,
      anchor: resolveAnchor(rect, target),
      target,
      pad: MARK_PAD,
      label,
      actions: parsed,
    });
  }

  function stopReplayInst(inst: Instance): void {
    inst.replayGen = (inst.replayGen ?? 0) + 1;
    cancelFly(inst);
    clearTimeout(inst.replayTimer);
  }

  function waitReplay(inst: Instance, gen: number, ms: number): Promise<void> {
    return new Promise((resolve) => {
      clearTimeout(inst.replayTimer);
      inst.replayTimer = setTimeout(resolve, Math.max(0, ms));
    });
  }

  async function runReplay(
    inst: Instance,
    points: Array<{ x: number; y: number; click: boolean }>,
  ): Promise<void> {
    const gen = (inst.replayGen ?? 0) + 1;
    inst.replayGen = gen;
    cancelFly(inst);
    clearTimeout(inst.parkTimer);
    if (!inst.visible) showAtRest(inst);
    setResting(inst, false);
    inst.el.classList.remove("hidden");
    inst.visible = true;
    for (const p of points) {
      if (inst.replayGen !== gen) return;
      if (
        p.x - window.scrollX < 8 ||
        p.y - window.scrollY < 8 ||
        p.x - window.scrollX > window.innerWidth - 8 ||
        p.y - window.scrollY > window.innerHeight - 8
      ) {
        window.scrollTo(Math.max(0, p.x - window.innerWidth / 2), Math.max(0, p.y - window.innerHeight / 2));
      }
      const to = { x: p.x - window.scrollX, y: p.y - window.scrollY };
      const ms = flyTo(inst, to);
      await waitReplay(inst, gen, ms);
      if (inst.replayGen !== gen) return;
      if (p.click) {
        spawnRipple(to.x, to.y, "ripple", inst.color);
        spawnRipple(to.x, to.y, "ripple r2", inst.color);
        inst.el.classList.add("pressing");
        clearTimeout(inst.pressTimer);
        inst.pressTimer = setTimeout(() => inst.el.classList.remove("pressing"), 160);
        await waitReplay(inst, gen, 180);
      }
    }
    if (inst.replayGen === gen) schedulePark(inst);
  }

  function ensureControlDom(): HTMLDivElement {
    if (controlBar) return controlBar;
    controlHost = document.createElement("div");
    controlHost.setAttribute(OVERLAY_ATTR, OVERLAY_KIND_CONTROL);
    controlHost.style.cssText =
      "position:fixed;inset:0;z-index:2147483645;pointer-events:none;";
    const controlShadow = controlHost.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      .bar {
        position: absolute; left: 12px; top: 12px;
        display: inline-flex; align-items: center; gap: 10px;
        width: max-content; max-width: calc(100vw - 24px);
        pointer-events: auto;
        background: #fff; color: #1c1f24;
        border-radius: 10px; padding: 8px 10px;
        box-shadow: 0 8px 24px rgba(15,23,42,.12), 0 0 0 .5px rgba(15,23,42,.12);
        font: 600 13px/1.3 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
        opacity: 0; transform: translateY(-6px);
        transition: opacity 160ms ease, transform 160ms ease;
      }
      .bar.on { opacity: 1; transform: none; }
      .bar b { font-weight: 600; white-space: nowrap; }
      .bar .sub { color: #7c828b; font: 500 11px/1.2 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif; white-space: nowrap; }
      .bar .stack { display: flex; margin-left: 1px; }
      .bar .avatar {
        width: 16px; height: 16px; margin-left: -4px;
        border: 2px solid #fff; border-radius: 50%;
        display: grid; place-items: center; color: #fff;
        font: 700 8px/1 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
        background: #56667d;
      }
      .bar .avatar:first-child { margin-left: 0; }
      .bar button {
        font: 600 12px/1 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
        border: 0; border-radius: 8px; padding: 7px 10px;
        background: #1c1f24; color: #fff; cursor: pointer;
      }
      .bar button:disabled { opacity: .55; cursor: default; }
    `;
    controlBar = document.createElement("div");
    controlBar.className = "bar";
    const status = document.createElement("b");
    status.textContent = "现在归你";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "交还";
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (btn.disabled) return;
      try {
        chrome.runtime.sendMessage({ type: "handback_click" }, () => {
          void chrome.runtime.lastError;
        });
      } catch {
        /* 无扩展运行时（自检页）忽略 */
      }
    });
    controlBar.append(status, btn);
    controlShadow.append(style, controlBar);
    (document.documentElement ?? document.body).appendChild(controlHost);
    return controlBar;
  }

  function applyControlView(view?: {
    status?: string;
    sub?: string;
    action?: string;
    actionEnabled?: boolean;
    members?: Array<{ id: string; initial: string; color: string }>;
  }): void {
    const bar = ensureControlDom();
    const status = bar.querySelector("b");
    const btn = bar.querySelector("button");
    let sub = bar.querySelector<HTMLElement>(".sub");
    let stack = bar.querySelector<HTMLElement>(".stack");
    if (status) status.textContent = view?.status || "现在归你";
    const subText = view?.sub?.trim() ?? "";
    if (subText) {
      if (!sub) {
        sub = document.createElement("span");
        sub.className = "sub";
        status?.after(sub);
      }
      sub.textContent = subText;
    } else {
      sub?.remove();
    }
    const members = view?.members ?? [];
    if (members.length > 0) {
      if (!stack) {
        stack = document.createElement("div");
        stack.className = "stack";
        (bar.querySelector(".sub") ?? status)?.after(stack);
      }
      stack.replaceChildren();
      for (const m of members) {
        const av = document.createElement("i");
        av.className = "avatar";
        av.textContent = m.initial || "?";
        if (m.color) av.style.background = m.color;
        stack.appendChild(av);
      }
    } else {
      stack?.remove();
    }
    if (btn) {
      const action = view?.action ?? "交还";
      btn.textContent = action;
      btn.hidden = !action;
      btn.disabled = view?.actionEnabled === false;
    }
  }

  function showUserControl(view?: {
    status?: string;
    sub?: string;
    action?: string;
    actionEnabled?: boolean;
    members?: Array<{ id: string; initial: string; color: string }>;
  }): void {
    applyControlView(view);
    const bar = ensureControlDom();
    bar.classList.add("on");
  }

  function hideUserControl(): void {
    if (!controlBar) return;
    controlBar.classList.remove("on");
  }

  function hide(inst: Instance): void {
    stopReplayInst(inst);
    cancelFly(inst);
    clearTimeout(inst.parkTimer);
    inst.el.classList.add("hidden");
    inst.el.classList.remove("pressing", "rest", "flip");
    inst.visible = false;
    inst.resting = true;
    if (inst.highlightEl) {
      inst.highlightEl.remove();
      inst.highlightEl = undefined;
    }
  }

  function teardown(): void {
    for (const inst of instances.values()) {
      stopReplayInst(inst);
      cancelFly(inst);
      clearTimeout(inst.parkTimer);
      clearTimeout(inst.pressTimer);
    }
    instances.clear();
    liveMarks.length = 0;
    host?.remove();
    marksHost?.remove();
    controlHost?.remove();
    host = null;
    marksHost = null;
    controlHost = null;
    controlBar = null;
    shadow = null;
    highlightLayer = null;
    rippleLayer = null;
    marksLayer = null;
    ns.cursor = undefined;
    ns.cursorHidden = undefined;
    ns.markLayout = undefined;
    ns.markActionLabels = undefined;
    ns.clickMarkAction = undefined;
    ns.controlBanner = undefined;
    ns.clickHandback = undefined;
  }

  window.addEventListener("pagehide", teardown);

  function api(id: string): SideAgentCursor {
    return {
      move(x: number, y: number): number {
        const inst = getInstance(id);
        clearTimeout(inst.parkTimer);
        if (!inst.visible) showAtRest(inst);
        setResting(inst, false);
        inst.el.classList.remove("hidden");
        inst.visible = true;
        return flyTo(inst, { x, y });
      },

      click(x: number, y: number): void {
        const inst = getInstance(id);
        clearTimeout(inst.pressTimer);
        inst.el.classList.add("pressing");
        inst.pressTimer = setTimeout(() => inst.el.classList.remove("pressing"), 160);
        spawnRipple(x, y, "ripple", inst.color);
        spawnRipple(x, y, "ripple r2", inst.color);
        schedulePark(inst);
      },

      park(): void {
        const inst = getInstance(id);
        if (!inst.visible) {
          showAtRest(inst);
          return;
        }
        schedulePark(inst);
      },

      replay(points: Array<{ x: number; y: number; click: boolean }>): void {
        void runReplay(getInstance(id), points);
      },

      stopReplay(): void {
        const inst = instances.get(id);
        if (inst) stopReplayInst(inst);
      },

      hide(): void {
        const inst = instances.get(id);
        if (inst) hide(inst);
      },

      showUserControl(view?: {
        status?: string;
        sub?: string;
        action?: string;
        actionEnabled?: boolean;
        members?: Array<{ id: string; initial: string; color: string }>;
      }): void {
        showUserControl(view);
      },

      hideUserControl(): void {
        hideUserControl();
      },

      highlight(rect: SideAgentRect): void {
        const inst = getInstance(id);
        spawnHighlight(inst, rect);
      },

      mark(rect: SideAgentRect, label?: string, target?: string, actions?: MarkAction[]): void {
        const inst = getInstance(id);
        spawnMark(inst, rect, label, target, actions);
      },

      clearMarks(): void {
        liveMarks.length = 0;
        marksLayer?.replaceChildren();
      },

      for(instanceId: string): SideAgentCursor {
        return api(instanceId);
      },
    };
  }

  ns.cursor = api(DEFAULT_ID);
  ns.cursorHidden = () => {
    const inst = instances.get(DEFAULT_ID);
    return !inst || !inst.visible;
  };
  ns.controlBanner = () => {
    if (!controlBar || !controlBar.classList.contains("on")) return null;
    const statusEl = controlBar.querySelector("b");
    const actionEl = controlBar.querySelector("button");
    const barRect = controlBar.getBoundingClientRect();
    const statusRect = statusEl?.getBoundingClientRect();
    const actionRect = actionEl?.getBoundingClientRect();
    return {
      status: statusEl?.textContent ?? "",
      action: actionEl?.textContent ?? "",
      barWidth: barRect.width,
      statusRight: statusRect?.right ?? 0,
      actionLeft: actionRect?.left ?? 0,
      actionRight: actionRect?.right ?? 0,
      viewportWidth: window.innerWidth,
    };
  };
  ns.clickHandback = () => {
    const btn = controlBar?.querySelector("button");
    if (!btn || !controlBar?.classList.contains("on")) return false;
    btn.click();
    return true;
  };
  ns.markActionLabels = () =>
    liveMarks.flatMap((m) =>
      [...m.el.querySelectorAll<HTMLButtonElement>(".mark-action")].map((b) => ({
        id: b.dataset.action ?? "",
        label: b.textContent ?? "",
      })),
    );
  ns.clickMarkAction = (id: string) => {
    if (!isMarkActionId(id)) return false;
    const btn = liveMarks
      .flatMap((m) => [...m.el.querySelectorAll<HTMLButtonElement>(".mark-action")])
      .find((b) => b.dataset.action === id);
    if (!btn) return false;
    btn.click();
    return true;
  };
  ns.markLayout = () =>
    liveMarks.map((m) => ({
      x: parseFloat(m.el.style.left) || 0,
      y: parseFloat(m.el.style.top) || 0,
      width: parseFloat(m.el.style.width) || 0,
      height: parseFloat(m.el.style.height) || 0,
    }));
})();
