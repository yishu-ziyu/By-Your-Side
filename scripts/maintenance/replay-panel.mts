export type TurnSnapshot = {
  sent: boolean;
  running: boolean;
  idle: boolean;
  checking: boolean;
  paused: boolean;
  answer: string;
  has: string[];
  error: string | null;
  cardFailed: boolean;
  elapsedMs: number;
  firstFeedbackMs: number | null;
  answerReadyMs: number | null;
  pauseMs: number | null;
};

export function observeTurn(say: string, selectors: string[]): string {
  return `(() => {
    window.__bysReplayTurn?.dispose();
    const root = document.querySelector("#messages");
    const input = document.querySelector("#input");
    const pill = document.querySelector("#status-pill");
    const banner = document.querySelector("#handoff-banner");
    const previous = new Set(root.querySelectorAll(".msg.user"));
    const expected = ${JSON.stringify(say)};
    const selectors = ${JSON.stringify(selectors)};
    let user, started, answerNode, answerKey, firstFeedbackMs = null, answerReadyMs = null, pauseMs = null;
    const checkedTexts = new Set();
    const normalized = text => text.replace(/\\s+/g, "").trim();
    let frame = 0;
    const elapsed = () => started === undefined ? 0 : Math.round(performance.now() - started);
    const rendered = el => !!el && el.checkVisibility({checkOpacity: true, checkVisibilityCSS: true}) && el.getClientRects().length > 0;
    const inView = el => {
      if (!rendered(el)) return false;
      const box = el.getBoundingClientRect();
      const clip = el.closest("#messages")?.getBoundingClientRect();
      return Math.min(box.right, clip?.right ?? innerWidth, innerWidth) > Math.max(box.left, clip?.left ?? 0, 0)
        && Math.min(box.bottom, clip?.bottom ?? innerHeight, innerHeight) > Math.max(box.top, clip?.top ?? 0, 0);
    };
    const after = (selector) => user ? [...root.querySelectorAll(selector)].filter(el => user.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) : [];
    const read = () => {
      if (!user?.isConnected && started !== undefined) user = [...root.querySelectorAll(".msg.user")].findLast(el => !previous.has(el) && el.querySelector(".user-msg-text")?.textContent === expected);
      const running = !!user && pill.classList.contains("running");
      const answer = after(".msg.assistant:not(.opening-line):not([data-delivery-kind='ack']):not([data-delivery-kind='start_ack'])").filter(rendered).at(-1);
      const error = after(".msg.error").filter(rendered).at(-1);
      const card = after(".ai-task-card").filter(rendered).at(-1);
      const feedback = after(".msg.assistant, .msg.error, .run-steps, .ai-task-card, .handoff-card");
      if (firstFeedbackMs === null && document.visibilityState === "visible" && ((running && inView(pill)) || feedback.some(inView))) firstFeedbackMs = elapsed();
      const paused = !!user && (banner?.dataset.phase === "user" || after(".handoff-card").some(rendered));
      if (paused && pauseMs === null) pauseMs = elapsed();
      for (const el of after(".msg.assistant[data-fact-checked]").filter(rendered)) {
        if (!el.matches(".streaming, [data-revealing='true']")) checkedTexts.add(normalized(el.innerText));
      }
      const text = answer?.innerText.trim() ?? "";
      const has = selectors.filter(sel => answer && [...answer.querySelectorAll(sel)].some(rendered));
      if (!text || answer?.matches(".streaming, [data-streaming='true'], [data-revealing='true']")) {
        answerReadyMs = null;
      } else if (answerReadyMs === null || answerNode !== answer || answerKey !== text || has.length !== lastHas) {
        answerReadyMs = elapsed();
      }
      answerNode = answer;
      answerKey = text;
      lastHas = has.length;
      return { sent: !!user, running, idle: !!user && !running && document.querySelector("#send-btn")?.disabled === false && document.querySelector("#conversation-new")?.disabled === false,
        checking: after(".run-check").some(el => el.textContent.includes("核对中")), paused, answer: text, has,
        error: error?.innerText.trim().slice(0,200) || null, cardFailed: /有 \\d+ 步没做成|还没做成/.test(card?.innerText ?? ""),
        elapsedMs: elapsed(), firstFeedbackMs, answerReadyMs, pauseMs };
    };
    let lastHas = 0;
    const schedule = () => {
      if (started !== undefined && !frame) frame = requestAnimationFrame(() => { frame = 0; read(); });
    };
    const send = event => {
      if (event.key === "Enter" && started === undefined) { started = performance.now(); schedule(); }
    };
    const observer = new MutationObserver(schedule);
    observer.observe(root, {childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "hidden", "data-revealing", "data-streaming", "data-delivery-kind", "data-fact-checked"]});
    observer.observe(pill, {attributes: true, attributeFilter: ["class"]});
    if (banner) observer.observe(banner, {attributes: true, attributeFilter: ["data-phase", "hidden"]});
    input.addEventListener("keydown", send, true);
    window.__bysReplayTurn = { read, correctionsVisible(required) { read(); return required.every(text => [...checkedTexts].some(shown => shown.includes(normalized(text)))); }, dispose() { observer.disconnect(); cancelAnimationFrame(frame); input.removeEventListener("keydown", send, true); } };
    return true;
  })()`;
}
