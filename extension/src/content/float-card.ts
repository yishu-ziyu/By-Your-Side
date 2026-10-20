import { createElement as icon, GripHorizontal, Minus, PanelRight, X, MessageSquare } from "lucide";
import { OVERLAY_ATTR, OVERLAY_KIND_FLOAT_CARD } from "../shared/overlay.js";
import { FLOAT_CARD_KEY, FLOAT_CARD_TO_PANEL, FLOAT_CARD_WHERE, readFloatCard, type FloatCardRect, type FloatCardState } from "../shared/float-card.js";
import { syncColorTone } from "../shared/color-tone.js";

const MIN = { width: 300, height: 360 };
const EDGE = 8;

const STYLES = `
:host {
  all: initial;
  --fc-bg: #f3f6fb;
  --fc-line: #dce3ef;
  --fc-ink: #475569;
  --fc-hover: #e9eef7;
  --fc-shadow: 0 12px 40px rgba(15, 23, 42, .16), 0 2px 8px rgba(15, 23, 42, .06);
  --fc-radius: 14px;
  --fc-bubble: #2d4a86;
  --fc-bubble-ink: #ffffff;
}
:host([data-tone="warm"]) { --fc-bg: oklch(0.980 0.0055 88); --fc-line: #e3dfd5; --fc-ink: #5f5e58; --fc-hover: #ebe7de; --fc-bubble: #3d3a33; }
@media (prefers-color-scheme: dark) {
  :host { --fc-bg: #131924; --fc-line: #2c3646; --fc-ink: #a9b6ca; --fc-hover: #1f2838; --fc-shadow: 0 12px 40px rgba(0, 0, 0, .5); --fc-bubble: #9fb3ff; --fc-bubble-ink: #131924; }
  :host([data-tone="warm"]) { --fc-bg: #211f1b; --fc-line: #484237; --fc-ink: #bbb3a5; --fc-hover: #2b2822; --fc-bubble: #eee9df; --fc-bubble-ink: #211f1b; }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
/* 卡片和圆钮放在浏览器的顶层（popover）：压在网页和我们自己别的浮层（光标、划词卡片）上面，会话页才完整露在外面。 */
.card:not(:popover-open), .bubble:not(:popover-open) { display: none; }
.card { position: fixed; inset: auto; margin: 0; padding: 0 ${EDGE}px ${EDGE}px; display: flex; flex-direction: column; background: var(--fc-bg); border: 1px solid var(--fc-line); border-radius: var(--fc-radius); box-shadow: var(--fc-shadow); overflow: hidden; }
.bar { flex: none; height: 28px; display: flex; align-items: center; justify-content: flex-end; gap: 2px; padding: 0 6px; cursor: grab; user-select: none; touch-action: none; position: relative; }
.bar.dragging { cursor: grabbing; }
.grip { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); color: var(--fc-ink); opacity: .55; display: flex; pointer-events: none; }
.bar button { all: unset; width: 22px; height: 22px; display: grid; place-items: center; border-radius: 50%; color: var(--fc-ink); cursor: pointer; }
.bar button:hover { background: var(--fc-hover); }
.bar button:focus-visible { outline: 2px solid var(--fc-bubble); }
iframe { flex: 1; width: 100%; border: 0; display: block; background: var(--fc-bg); color-scheme: normal; }
.card.moving iframe { pointer-events: none; }
.edge { position: absolute; touch-action: none; }
/* 拉边的把手只放在卡片留出的边上，不压在会话页上：会话页有一点被盖住，就按“看不全”拦下点击。 */
.edge.left { left: 0; top: 28px; bottom: ${EDGE}px; width: ${EDGE}px; cursor: ew-resize; }
.edge.bottom { left: ${EDGE}px; right: 0; bottom: 0; height: ${EDGE}px; cursor: ns-resize; }
.edge.corner { left: 0; bottom: 0; width: ${EDGE}px; height: ${EDGE}px; cursor: nesw-resize; }
.bubble { all: unset; position: fixed; inset: auto; margin: 0; width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; background: var(--fc-bubble); color: var(--fc-bubble-ink); box-shadow: var(--fc-shadow); cursor: pointer; }
.bubble:focus-visible { outline: 2px solid var(--fc-line); outline-offset: 2px; }
`;

/**
 * 浮在网页上的会话卡片。里面是扩展自己的会话页（iframe），和侧栏同一套界面、同一份会话记录。
 * 只在用户正看着的标签页里挂：换到别的标签页，那边按同一份状态重新挂上，这边拆掉，免得每个标签页各连一个会话页。
 */
export function installFloatCard(): void {
  let state: FloatCardState | null = null;
  let host: HTMLElement | null = null;
  let card: HTMLElement | null = null;
  let bubble: HTMLButtonElement | null = null;
  let mounting: Promise<void> | null = null;
  /** 助手正在点被卡片挡住的网页目标：这些点击做完前卡片藏起来。 */
  const yielding = new Set<string>();

  const save = (next: Partial<FloatCardState>) => {
    if (!state) return;
    state = { ...state, ...next };
    void chrome.storage.local.set({ [FLOAT_CARD_KEY]: state }).catch(() => { /* 扩展刚重载 */ });
  };

  /** 视口变小时只在显示上收进来，不改存着的位置：窗口拉回原大小，卡片回原处。 */
  const fit = (r: FloatCardRect): FloatCardRect => {
    const width = Math.max(MIN.width, Math.min(r.width, innerWidth - 16));
    const height = Math.max(MIN.height, Math.min(r.height, innerHeight - 16));

    return {
      width, height,
      right: Math.max(0, Math.min(r.right, innerWidth - width)),
      top: Math.max(0, Math.min(r.top, innerHeight - height)),
    };
  };

  const place = () => {
    if (!state || !card || !bubble) return;
    const r = fit(state.rect);
    Object.assign(card.style, { right: `${r.right}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    // 收起后贴到窗口右边，不压在正文上；高度跟卡片顶边走，用户还认得出是它。
    Object.assign(bubble.style, { right: "16px", top: `${r.top}px` });
  };

  const teardown = () => {
    host?.remove();
    host = card = bubble = null;
  };

  /** 拖动或拉边：pointer 抓在把手上，iframe 暂时不吃鼠标，不然一滑进去就丢了。 */
  const track = (handle: HTMLElement, onMove: (dx: number, dy: number, start: FloatCardRect) => FloatCardRect) => {
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !state || (e.target as HTMLElement).closest("button")) return;
      e.preventDefault();
      const start = fit(state.rect);
      const x0 = e.clientX, y0 = e.clientY;
      handle.setPointerCapture(e.pointerId);
      card!.classList.add("moving");
      handle.classList.add("dragging");
      const move = (ev: PointerEvent) => {
        state = { ...state!, rect: fit(onMove(ev.clientX - x0, ev.clientY - y0, start)) };
        place();
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        card?.classList.remove("moving");
        handle.classList.remove("dragging");
        save({});
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up, { once: true });
      handle.addEventListener("pointercancel", up, { once: true });
    });
  };

  const button = (label: string, glyph: Parameters<typeof icon>[0], onClick: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.title = label;
    b.setAttribute("aria-label", label);
    b.append(icon(glyph, { width: 14, height: 14, "aria-hidden": "true" }));
    b.addEventListener("click", onClick);
    return b;
  };

  const mount = async () => {
    // 会话页要知道自己替哪个窗口看网页；内容脚本自己拿不到窗口号，问后台。
    const where = await chrome.runtime.sendMessage({ type: FLOAT_CARD_WHERE }).catch(() => null) as { windowId?: number } | null;
    if (typeof where?.windowId !== "number" || !state?.open || document.hidden) return;

    host = document.createElement("div");
    host.setAttribute(OVERLAY_ATTR, OVERLAY_KIND_FLOAT_CARD);
    syncColorTone(host);
    // closed：网页脚本读不到会话页的地址，没法把它另嵌到自己页面里骗点击。
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = STYLES;

    card = document.createElement("div");
    card.className = "card";
    card.popover = "manual";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "By Your Side");
    const bar = document.createElement("div");
    bar.className = "bar";
    const grip = document.createElement("span");
    grip.className = "grip";
    grip.append(icon(GripHorizontal, { width: 16, height: 16, "aria-hidden": "true" }));
    bar.append(
      grip,
      button("回到侧栏", PanelRight, () => {
        void chrome.runtime.sendMessage({ type: FLOAT_CARD_TO_PANEL }).catch(() => {});
        save({ open: false });
      }),
      button("收起", Minus, () => save({ collapsed: true })),
      button("关闭浮动卡片", X, () => save({ open: false })),
    );
    const frame = document.createElement("iframe");
    frame.title = "By Your Side 会话";
    frame.allow = "clipboard-write";
    const edges = (["left", "bottom", "corner"] as const).map(kind => {
      const edge = document.createElement("div");
      edge.className = `edge ${kind}`;
      track(edge, (dx, dy, s) => ({
        ...s,
        width: kind === "bottom" ? s.width : s.width - dx,
        height: kind === "left" ? s.height : s.height + dy,
      }));
      return edge;
    });
    track(bar, (dx, dy, s) => ({ ...s, right: s.right - dx, top: s.top + dy }));
    card.append(bar, frame, ...edges);

    bubble = document.createElement("button");
    bubble.className = "bubble";
    bubble.popover = "manual";
    bubble.type = "button";
    bubble.setAttribute("aria-label", "展开 By Your Side");
    bubble.append(icon(MessageSquare, { width: 20, height: 20, "aria-hidden": "true" }));
    bubble.addEventListener("click", () => save({ collapsed: false }));

    root.append(style, card, bubble);
    document.documentElement.append(host);
    frame.src = chrome.runtime.getURL(`sidepanel.html?float=1&conversation=${encodeURIComponent(state.conversation)}&window=${where.windowId}`);
  };

  const render = () => {
    if (!state?.open || document.hidden) return teardown();
    if (!host) {
      // 扩展重载后旧脚本问不到后台，挂不上就停在这里，不原地反复重试。
      mounting ??= mount().finally(() => { mounting = null; if (host) render(); });
      return;
    }
    host.style.visibility = yielding.size ? "hidden" : "";
    card!.togglePopover(!state.collapsed);
    bubble!.togglePopover(state.collapsed);
    place();
  };

  const ns = (window.__sideagent ??= {});
  ns.floatCard = {
    uncover(target, x, y, token) {
      if (!host || !target.isConnected || document.elementFromPoint(x, y) !== host) return false;
      // 目标必须是网页自己的：跨 closed shadow 往上查，不能借让位点到我们自己的界面。
      for (let node: Element | null = target; node;) {
        if (node.closest(`[${OVERLAY_ATTR}]`)) return false;
        const parent = node.getRootNode();
        node = parent instanceof ShadowRoot ? parent.host : null;
      }
      yielding.add(token);
      render();
      return true;
    },
    restore(token) {
      if (yielding.delete(token)) render();
    },
  };

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !(FLOAT_CARD_KEY in changes)) return;
    state = readFloatCard(changes[FLOAT_CARD_KEY]!.newValue);
    render();
  });
  document.addEventListener("visibilitychange", render);
  addEventListener("resize", place);
  void chrome.storage.local.get(FLOAT_CARD_KEY).then(stored => {
    state = readFloatCard(stored[FLOAT_CARD_KEY]);
    render();
  }, () => {});
}
