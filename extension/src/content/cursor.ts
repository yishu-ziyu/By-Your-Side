/**
 * Agent 虚拟鼠标 overlay content script（ISOLATED world，重复注入幂等）。
 * 暴露 window.__sideagent.cursor = { move, click, hide }。
 * shadow DOM（closed）隔离页面样式；host pointer-events:none + 最高 z-index，不干扰页面交互。
 * 坐标均为视口坐标系（与 Input.dispatchMouseEvent / getBoundingClientRect 一致）。
 *
 * 视觉参考：tldraw 协作光标（彩色填充 + 白描边 + 名牌 pill）、
 * ChatGPT Agent 模式（落点光环 + 点击波纹）。箭头形状取自 lucide MousePointer2（ISC）。
 */
(function () {
  const ns = (window.__sideagent ??= {});
  if (ns.cursor) return;

  const IDLE_HIDE_MS = 3000;
  const SVG_SIZE = 27; // svg 显示尺寸（lucide 图标为 24 网格）
  const SCALE = SVG_SIZE / 24;
  const TIP = { x: 4.037, y: 4.688 }; // 箭头尖端在 24 网格中的位置
  const ACCENT = "#2f6fed";

  let host: HTMLDivElement | null = null;
  let cursorEl: HTMLDivElement | null = null;
  let rippleLayer: HTMLDivElement | null = null;
  let visible = false;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let pressTimer: ReturnType<typeof setTimeout> | undefined;

  function ensureDom(): void {
    if (host) return;
    host = document.createElement("div");
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
    const shadow = host.attachShadow({ mode: "closed" });

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
      .label {
        position: absolute; left: 17px; top: 19px;
        padding: 2px 8px; border-radius: 999px;
        background: ${ACCENT}; color: #fff;
        font: 600 11px/1.7 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
        letter-spacing: .02em; white-space: nowrap;
        box-shadow: 0 2px 6px rgba(15,23,42,.25);
      }
      .ripple {
        position: absolute; width: 12px; height: 12px; margin: -6px 0 0 -6px;
        border-radius: 50%; border: 2px solid ${ACCENT};
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
    `;
    shadow.appendChild(style);

    rippleLayer = document.createElement("div");
    shadow.appendChild(rippleLayer);

    cursorEl = document.createElement("div");
    cursorEl.className = "cursor hidden";
    // 箭头尖端对齐 translate 原点（svg 负偏移 + overflow:visible）
    cursorEl.innerHTML =
      `<div class="svg-wrap"><svg width="${SVG_SIZE}" height="${SVG_SIZE}" viewBox="0 0 24 24">` +
      `<path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z" ` +
      `fill="${ACCENT}" stroke="#ffffff" stroke-width="1.6" stroke-linejoin="round"/>` +
      `</svg></div>` +
      `<div class="label">SideAgent</div>`;
    shadow.appendChild(cursorEl);

    (document.documentElement ?? document.body).appendChild(host);
  }

  function scheduleHide(): void {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => ns.cursor?.hide(), IDLE_HIDE_MS);
  }

  function place(x: number, y: number, animate: boolean): void {
    ensureDom();
    const el = cursorEl!;
    if (!animate) el.classList.add("no-anim");
    el.classList.remove("hidden");
    el.style.transform = `translate(${x}px, ${y}px)`;
    if (!animate) {
      // 强制 reflow，让无动画定位先生效，再恢复过渡供后续移动使用
      void el.offsetWidth;
      el.classList.remove("no-anim");
    }
    visible = true;
    scheduleHide();
  }

  function spawnRipple(x: number, y: number, cls: string): void {
    const ripple = document.createElement("div");
    ripple.className = cls;
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    ripple.addEventListener("animationend", () => ripple.remove(), { once: true });
    rippleLayer!.appendChild(ripple);
  }

  ns.cursor = {
    /** 平滑移动到 (x,y)（从隐藏状态首次出现时直接落位，不做长距离滑动）。 */
    move(x: number, y: number): void {
      place(x, y, visible);
    },

    /** 在 (x,y) 播放点击反馈：光标按下缩放 + 双层波纹（通常跟在 move 之后）。 */
    click(x: number, y: number): void {
      ensureDom();
      const el = cursorEl!;
      clearTimeout(pressTimer);
      el.classList.add("pressing");
      pressTimer = setTimeout(() => el.classList.remove("pressing"), 160);
      spawnRipple(x, y, "ripple");
      spawnRipple(x, y, "ripple r2");
      scheduleHide();
    },

    hide(): void {
      cursorEl?.classList.add("hidden");
      cursorEl?.classList.remove("pressing");
      visible = false;
      clearTimeout(hideTimer);
    },
  };
})();
