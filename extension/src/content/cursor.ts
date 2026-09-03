/**
 * Agent 虚拟鼠标 overlay content script（ISOLATED world，重复注入幂等）。
 * 暴露 window.__sideagent.cursor = { move, click, hide, highlight, mark, clearMarks, for(id) }。
 * mark 标注挂在独立的 absolute host（文档坐标，随内容滚动）；其余在 fixed host（视口坐标）。
 * 默认实例（名牌 "SideAgent"）供单任务使用；for(id) 返回实例专属光标（调色板按序着色），
 * 为多任务并行准备的渲染层——每个并行 Agent 一个颜色。
 *
 * shadow DOM（closed）隔离页面样式；host pointer-events:none + 最高 z-index，不干扰页面交互。
 * 坐标均为视口坐标系（与 Input.dispatchMouseEvent / getBoundingClientRect 一致）。
 *
 * 视觉参考：tldraw 协作光标（彩色填充 + 白描边 + 名牌 pill）、ChatGPT Agent（点击波纹）。
 * 箭头形状取自 lucide MousePointer2（ISC）。
 */
import { markLabelPlacement } from "../shared/mark-label.js";

(function () {
  const ns = (window.__sideagent ??= {});
  if (ns.cursor) return;

  const IDLE_HIDE_MS = 3000;
  const SVG_SIZE = 27; // svg 显示尺寸（lucide 图标为 24 网格）
  const SCALE = SVG_SIZE / 24;
  const TIP = { x: 4.037, y: 4.688 }; // 箭头尖端在 24 网格中的位置
  const DEFAULT_ID = "main";
  const DEFAULT_LABEL = "SideAgent";
  /** 并行实例调色板，按 for(id) 首次出现的顺序取色 */
  const PALETTE = ["#2f6fed", "#e2554f", "#16a34a", "#9333ea", "#d97706"];

  const ARROW_PATH =
    "M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z";

  interface Instance {
    el: HTMLDivElement;
    color: string;
    visible: boolean;
    hideTimer?: ReturnType<typeof setTimeout>;
    pressTimer?: ReturnType<typeof setTimeout>;
    highlightEl?: HTMLDivElement;
  }

  let host: HTMLDivElement | null = null;
  let shadow: ShadowRoot | null = null;
  let highlightLayer: HTMLDivElement | null = null;
  let rippleLayer: HTMLDivElement | null = null;
  let marksLayer: HTMLDivElement | null = null; // 文档坐标标注层（独立 absolute host，随页面滚动）
  const instances = new Map<string, Instance>();

  function ensureDom(): void {
    if (host) return;
    host = document.createElement("div");
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
    shadow = host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = `
      .cursor {
        position: absolute; top: 0; left: 0;
        transition: transform 280ms cubic-bezier(.22,1,.36,1), opacity 160ms ease;
        will-change: transform;
      }
      .cursor.no-anim { transition: none; }
      .cursor.hidden { opacity: 0; transition: opacity 160ms ease; }
      .svg-wrap {
        position: absolute; left: 0; top: 0;
        transition: transform 130ms ease;
        transform-origin: ${(TIP.x * SCALE).toFixed(1)}px ${(TIP.y * SCALE).toFixed(1)}px;
      }
      .cursor.pressing .svg-wrap { transform: scale(.8); }
      .cursor svg {
        position: absolute; display: block; overflow: visible;
        left: ${(-TIP.x * SCALE).toFixed(1)}px; top: ${(-TIP.y * SCALE).toFixed(1)}px;
        filter: drop-shadow(0 1.5px 3px rgba(15,23,42,.4));
      }
      .cursor path { fill: var(--c); }
      .label {
        position: absolute; left: 17px; top: 19px;
        padding: 2px 8px; border-radius: 999px;
        background: var(--c); color: #fff;
        font: 600 11px/1.7 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
        letter-spacing: .02em; white-space: nowrap;
        box-shadow: 0 2px 6px rgba(15,23,42,.25);
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
  }

  function ensureMarksDom(): void {
    if (marksLayer) return;
    // 与 fixed 的 cursor host 不同：absolute + 文档坐标，标注随内容滚动（修"滚动后标注漂移"问题）
    const marksHost = document.createElement("div");
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
    `;
    marksShadow.appendChild(style);
    marksLayer = document.createElement("div");
    marksShadow.appendChild(marksLayer);
    (document.documentElement ?? document.body).appendChild(marksHost);
  }

  function getInstance(id: string): Instance {
    const existing = instances.get(id);
    if (existing) return existing;
    ensureDom();
    const el = document.createElement("div");
    el.className = "cursor hidden";
    // 箭头尖端对齐 translate 原点（svg 负偏移 + overflow:visible）
    el.innerHTML =
      `<div class="svg-wrap"><svg width="${SVG_SIZE}" height="${SVG_SIZE}" viewBox="0 0 24 24">` +
      `<path d="${ARROW_PATH}" stroke="#ffffff" stroke-width="1.6" stroke-linejoin="round"/>` +
      `</svg></div>` +
      `<div class="label">${id === DEFAULT_ID ? DEFAULT_LABEL : id}</div>`;
    const color =
      (id === DEFAULT_ID ? PALETTE[0] : PALETTE[instances.size % PALETTE.length]) ?? "#2f6fed";
    el.style.setProperty("--c", color);
    shadow!.appendChild(el);
    const inst: Instance = { el, color, visible: false };
    instances.set(id, inst);
    return inst;
  }

  function scheduleHide(inst: Instance): void {
    clearTimeout(inst.hideTimer);
    inst.hideTimer = setTimeout(() => hide(inst), IDLE_HIDE_MS);
  }

  function place(inst: Instance, x: number, y: number, animate: boolean): void {
    const el = inst.el;
    if (!animate) el.classList.add("no-anim");
    el.classList.remove("hidden");
    el.style.transform = `translate(${x}px, ${y}px)`;
    if (!animate) {
      // 强制 reflow，让无动画定位先生效，再恢复过渡供后续移动使用
      void el.offsetWidth;
      el.classList.remove("no-anim");
    }
    inst.visible = true;
    scheduleHide(inst);
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
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    ensureDom();
    if (inst.highlightEl) {
      inst.highlightEl.remove();
      inst.highlightEl = undefined;
    }
    const pad = 3;
    const el = document.createElement("div");
    el.className = "highlight";
    el.style.setProperty("--c", inst.color);
    el.style.left = `${Math.round(rect.x - pad)}px`;
    el.style.top = `${Math.round(rect.y - pad)}px`;
    el.style.width = `${Math.round(rect.width + pad * 2)}px`;
    el.style.height = `${Math.round(rect.height + pad * 2)}px`;

    const remove = () => {
      el.remove();
      if (inst.highlightEl === el) {
        inst.highlightEl = undefined;
      }
    };
    el.addEventListener("animationend", remove, { once: true });
    // 超时兜底防残影
    setTimeout(remove, 650);
    inst.highlightEl = el;
    highlightLayer!.appendChild(el);
  }

  function spawnMark(inst: Instance, rect: SideAgentRect, label?: string): void {
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    ensureMarksDom();
    const pad = 6;
    // rect 是视口坐标，转成文档坐标，标注随内容滚动
    const x = Math.round(rect.x + window.scrollX) - pad;
    const y = Math.round(rect.y + window.scrollY) - pad;
    const el = document.createElement("div");
    el.className = "mark";
    el.style.setProperty("--c", inst.color);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.width = `${Math.round(rect.width) + pad * 2}px`;
    el.style.height = `${Math.round(rect.height) + pad * 2}px`;
    el.innerHTML =
      `<svg class="mark-arrow" width="24" height="24" viewBox="0 0 24 24" fill="none">` +
      `<path d="M2 12h17m-6-6 6 6-6 6" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>` +
      `</svg>` +
      (label ? `<div class="mark-label"></div>` : "");
    if (label) {
      const labelEl = el.querySelector(".mark-label")!;
      labelEl.textContent = label;
      // 元素贴视口顶部时名牌翻到框下方，避免出屏被裁（箭头/边框不变）
      if (markLabelPlacement(rect.y) === "below") labelEl.classList.add("below");
    }
    marksLayer!.appendChild(el);
  }

  function hide(inst: Instance): void {
    inst.el.classList.add("hidden");
    inst.el.classList.remove("pressing");
    inst.visible = false;
    clearTimeout(inst.hideTimer);
    if (inst.highlightEl) {
      inst.highlightEl.remove();
      inst.highlightEl = undefined;
    }
  }

  function api(id: string): SideAgentCursor {
    return {
      /** 平滑移动到 (x,y)（从隐藏状态首次出现时直接落位，不做长距离滑动）。 */
      move(x: number, y: number): void {
        const inst = getInstance(id);
        place(inst, x, y, inst.visible);
      },

      /** 在 (x,y) 播放点击反馈：光标按下缩放 + 双层交错波纹（通常跟在 move 之后）。 */
      click(x: number, y: number): void {
        const inst = getInstance(id);
        clearTimeout(inst.pressTimer);
        inst.el.classList.add("pressing");
        inst.pressTimer = setTimeout(() => inst.el.classList.remove("pressing"), 160);
        spawnRipple(x, y, "ripple", inst.color);
        spawnRipple(x, y, "ripple r2", inst.color);
        scheduleHide(inst);
      },

      hide(): void {
        const inst = instances.get(id);
        if (inst) hide(inst);
      },

      /** 在目标元素周围绘制呼吸高亮框（透明度脉动，结束后自动销毁）。 */
      highlight(rect: SideAgentRect): void {
        const inst = getInstance(id);
        spawnHighlight(inst, rect);
      },

      /** 在 (rect 视口坐标) 处画持久标注（描边框+箭头+名牌），锚定文档坐标随内容滚动。 */
      mark(rect: SideAgentRect, label?: string): void {
        const inst = getInstance(id);
        spawnMark(inst, rect, label);
      },

      /** 清除全部 mark 标注。 */
      clearMarks(): void {
        marksLayer?.replaceChildren();
      },

      /** 取某个 Agent 实例的专属光标（调色板着色，名牌为 id），供并行任务区分。 */
      for(instanceId: string): SideAgentCursor {
        return api(instanceId);
      },
    };
  }

  ns.cursor = api(DEFAULT_ID);
})();
