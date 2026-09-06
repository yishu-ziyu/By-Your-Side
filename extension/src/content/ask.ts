/**
 * 选中即问（方案 A）：划网页正文，选区旁「问 / 解释」。
 * 解释和提问的答案贴在选区旁边；「在侧栏继续」才把这段交给侧栏。
 * 输入框 / iframe / PDF 不做。
 */
import { clipSelection, isEditableTarget } from "../shared/ask-selection.js";

const HOST_ATTR = "data-sideagent-ask";

function selectedText(): string | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount < 1) return null;
  if (sel.anchorNode && isEditableTarget(sel.anchorNode.parentElement)) return null;
  return clipSelection(sel.toString());
}

function mount(): { host: HTMLElement; root: ShadowRoot } {
  document.querySelector(`[${HOST_ATTR}]`)?.remove();
  const host = document.createElement("div");
  host.setAttribute(HOST_ATTR, "1");
  host.style.cssText = "position:fixed;z-index:2147483645;display:none;width:min(360px, calc(100vw - 16px));pointer-events:none;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .wrap { pointer-events: auto; font: 12.5px/1.45 -apple-system, "SF Pro Text", "PingFang SC", sans-serif; color: #111; }
      .bar { display: flex; gap: 4px; margin-bottom: 6px; }
      .bar button, .go, .cont {
        border: 0; cursor: pointer; font: 600 12px/1 inherit;
      }
      .bar button {
        background: #111; color: #fff; padding: 6px 10px; border-radius: 999px;
        box-shadow: 0 6px 18px rgba(0,0,0,.16);
      }
      .bar button.ghost { background: #fff; color: #111; box-shadow: 0 0 0 .5px rgba(0,0,0,.12), 0 6px 18px rgba(0,0,0,.1); }
      .bar button:hover { filter: brightness(1.08); }
      .askrow { display: none; gap: 6px; margin-bottom: 6px; }
      .askrow.on { display: flex; }
      .askrow input {
        flex: 1; border: .5px solid rgba(0,0,0,.12); border-radius: 8px; padding: 6px 8px; font: inherit; outline: none;
      }
      .go { background: #111; color: #fff; border-radius: 8px; padding: 6px 10px; }
      .card {
        display: none; background: #fff; border-radius: 12px; padding: 10px 12px;
        box-shadow: 0 0 0 .5px rgba(0,0,0,.1), 0 10px 28px rgba(0,0,0,.12);
        max-height: 220px; overflow: auto; white-space: pre-wrap;
      }
      .card.on { display: block; }
      .head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
      .k { font-size: 10.5px; font-weight: 600; color: #6b7280; flex: 1; }
      .x {
        border: 0; background: transparent; color: #6b7280; cursor: pointer;
        font: 600 14px/1 inherit; padding: 0 2px; border-radius: 4px;
      }
      .x:hover { color: #111; }
      .cont { display: none; margin-top: 8px; background: none; color: #2f6fed; padding: 0; font-weight: 600; }
      .cont.on { display: inline; }
    </style>
    <div class="wrap">
      <div class="bar">
        <button type="button" data-act="ask">问</button>
        <button type="button" class="ghost" data-act="explain">解释</button>
      </div>
      <div class="askrow">
        <input type="text" placeholder="例如：这跟我们实验有关吗" />
        <button class="go" type="button">发送</button>
      </div>
      <div class="card">
        <div class="head">
          <div class="k"></div>
          <button class="x" type="button" title="关闭" aria-label="关闭">×</button>
        </div>
        <div class="body"></div>
        <button class="cont" type="button">在侧栏继续</button>
      </div>
    </div>
  `;
  document.documentElement.appendChild(host);
  return { host, root };
}

function boot(): void {
  if (window !== window.top) return;
  if (document.contentType && document.contentType !== "text/html") return;
  const { host, root } = mount();
  const bar = root.querySelector(".bar") as HTMLElement;
  const askRow = root.querySelector(".askrow") as HTMLElement;
  const input = root.querySelector("input") as HTMLInputElement;
  const card = root.querySelector(".card") as HTMLElement;
  const kicker = root.querySelector(".k") as HTMLElement;
  const body = root.querySelector(".body") as HTMLElement;
  const cont = root.querySelector(".cont") as HTMLButtonElement;
  const closeBtn = root.querySelector(".x") as HTMLButtonElement;
  let liveText = "";

  function hide(): void {
    host.style.display = "none";
    askRow.classList.remove("on");
    card.classList.remove("on");
    cont.classList.remove("on");
    body.textContent = "";
  }

  function placeBar(): void {
    const text = selectedText();
    if (!text) {
      if (!card.classList.contains("on") && !askRow.classList.contains("on")) hide();
      return;
    }
    liveText = text;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount < 1) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (rect.width < 2 && rect.height < 2) return;
    const top = Math.max(8, rect.top - 40);
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - 280);
    host.style.top = `${top}px`;
    host.style.left = `${left}px`;
    host.style.display = "block";
    bar.style.display = "flex";
  }

  function showCard(label: string, seed: string): void {
    kicker.textContent = label;
    body.textContent = seed;
    card.classList.add("on");
    cont.classList.remove("on");
    const rectTop = parseFloat(host.style.top || "8");
    if (rectTop + 280 > window.innerHeight) {
      host.style.top = `${Math.max(8, window.innerHeight - 280)}px`;
    }
  }

  function sendAsk(mode: "explain" | "ask", question?: string): void {
    const text = liveText || selectedText();
    if (!text) return;
    liveText = text;
    chrome.runtime.sendMessage({ type: "ask-selection", mode, text, question });
    showCard(mode === "explain" ? "解释" : "问", "…");
    askRow.classList.remove("on");
  }

  bar.addEventListener("mousedown", (e) => e.preventDefault());
  bar.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("button");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const act = btn.getAttribute("data-act");
    if (act === "explain") sendAsk("explain");
    if (act === "ask") {
      askRow.classList.add("on");
      input.value = "";
      input.focus();
    }
  });
  root.querySelector(".go")!.addEventListener("click", () => {
    const q = input.value.trim();
    sendAsk("ask", q || "这段是什么意思？");
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const q = input.value.trim();
      sendAsk("ask", q || "这段是什么意思？");
    }
  });
  cont.addEventListener("click", () => {
    if (!liveText) return;
    chrome.runtime.sendMessage({ type: "ask-selection", mode: "continue", text: liveText });
    hide();
  });
  closeBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    hide();
  });

  document.addEventListener("pointerdown", (e) => {
    const t = e.target;
    if (t instanceof Node && (t === host || host.contains(t))) return;
    hide();
  }, true);

  document.addEventListener("mouseup", () => {
    window.setTimeout(() => placeBar(), 10);
  });
  document.addEventListener("selectionchange", () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      if (!card.classList.contains("on") && !askRow.classList.contains("on")) hide();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hide();
  });
  window.addEventListener("scroll", () => {
    if (!card.classList.contains("on")) hide();
  }, true);

  chrome.runtime.onMessage.addListener((raw: unknown) => {
    if (!raw || typeof raw !== "object") return;
    const msg = raw as { type?: string; event?: { kind?: string; delta?: string; message?: string }; text?: string };
    if (msg.type === "ask-open" || msg.type === "ask-hotkey") {
      if (msg.text) liveText = clipSelection(msg.text) ?? liveText;
      else liveText = selectedText() ?? liveText;
      if (!liveText) return;
      host.style.display = "block";
      host.style.top = "24px";
      host.style.left = "16px";
      askRow.classList.add("on");
      input.focus();
      return;
    }
    if (msg.type !== "ask-event" || !msg.event) return;
    const ev = msg.event;
    if (ev.kind === "text_delta" && ev.delta) {
      if (body.textContent === "…") body.textContent = "";
      body.textContent += ev.delta;
      card.classList.add("on");
    } else if (ev.kind === "error" || ev.kind === "notice") {
      body.textContent = ev.message || "没连上 Agent。";
      card.classList.add("on");
      cont.classList.add("on");
    } else if (ev.kind === "tool_start") {
      kicker.textContent = "Agent 开始操作页面，到侧栏看";
      cont.classList.add("on");
    } else if (ev.kind === "turn_end" || ev.kind === "agent_end") {
      cont.classList.add("on");
    }
  });
}

boot();
