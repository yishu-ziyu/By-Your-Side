/**
 * 对话里的记忆界面：回答首句后的「按你说过的…」、记住/忘记的回执、「要我记住吗」询问卡片。
 * 这些界面发出的记忆请求各自等自己的结果；结果由记忆抽屉统一收下后交回这里（settle）。
 */
import { MEMORY_TEXT_MAX, type MemoryEntry, type MemoryScope } from "../../../shared/memory.js";
import { isPageInteractionMessage, type AgentUiEvent, type ClientMessage } from "../../../shared/protocol.js";
import type { TaskHistoryEntry } from "../../../shared/task-history.js";
import type { MemoryApplyResult } from "./memory.js";
import { memoryScopeLabel } from "./memory.js";
import { createAskCard, stepAsk, type AskInput, type MemoryAskCard, type MemoryAskEvent } from "./memory-ask.js";
import type { mountMemoryDrawer } from "./memory-drawer.js";
import { createOrb } from "./orb.js";
import { uiEvent } from "./ui-trace.js";

type UsedItem = ({ kind: "entry"; entry: MemoryEntry; removed?: MemoryEntry[] } | { kind: "task"; task: TaskHistoryEntry })
  & { state: "used" | "forgotten" | "not-here"; pending: boolean; error: string };

type MemoryUsedLine = {
  cite: HTMLButtonElement; el: HTMLElement; items: Map<string, UsedItem>; hostname: string | null;
  open: boolean; showAll: boolean; answer: HTMLElement | null;
};

type UsedLineResult = { ok: boolean; entry?: MemoryEntry; entries?: MemoryEntry[]; error?: string };

const ORB_BOX_RECEIPT = 15;

interface MemoryInlineDeps {
  messagesEl: HTMLElement;
  appendToMessages: (node: HTMLElement) => void;
  scrollToEnd: () => void;
  send: (message: ClientMessage) => boolean;
  conversationId: () => string;
  replaying: () => boolean;
  /** 抽屉要拿 settle 当回调，所以晚于本模块创建；这里只在用户点按时才取。 */
  drawer: () => ReturnType<typeof mountMemoryDrawer>;
}

export function mountMemoryInline({ messagesEl, appendToMessages, scrollToEnd, send, conversationId, replaying, drawer }: MemoryInlineDeps) {
  /** 这一轮带给助手的记忆：先攒着，这一轮结束（agent_end）时放进回答首句。 */
  let pendingUsedLine: MemoryUsedLine | null = null;

  /** 定稿回答 → 它的那一行。正文重渲染会冲掉插进去的节点，再挂复制按钮时放回。 */
  const usedLineByAnswer = new WeakMap<HTMLElement, MemoryUsedLine>();

  /** 这一轮结束时回答还没定稿（或没有回答）：先独立显示一行，回答定稿后搬进去。 */
  let floatingUsedLine: MemoryUsedLine | null = null;

  /** 「用了 N 条记忆」里各条按钮发出的请求，各自等自己的结果。 */
  const usedLineHandlers = new Map<string, (result: UsedLineResult) => void>();

  /** 询问卡片的状态按 askId 留在面板内存里，切会话重绘时照原样画回；它发出的请求各自等自己的结果。 */
  const memoryAskCards = new Map<string, MemoryAskCard>();

  const memoryAskHandlers = new Map<string, (result: AskInput) => void>();

  // 回答首句末尾「按你说过的「…」等 N 条 ›」：展开后插在首句与正文之间，每条可「忘掉」或「这里别用」。
  /** 展开后先列几条，其余收在「另有 N 条」里。 */
  const USED_VISIBLE = 3;

  const usedItemKey = (item: UsedItem): string => item.kind === "entry" ? `entry:${item.entry.id}` : `task:${item.task.id}`;

  /** 同一轮里多次带记忆（重试、助手又查了记忆）并成一行，同一条只算一次。 */
  function noteMemoryUsed(event: Extract<AgentUiEvent, { kind: "memory" }>): void {
    const line = pendingUsedLine ?? {
      cite: document.createElement("button"), el: document.createElement("div"), items: new Map<string, UsedItem>(),
      hostname: null, open: false, showAll: false, answer: null,
    };

    pendingUsedLine = line;
    line.hostname = event.hostname ?? line.hostname;

    const incoming: UsedItem[] = [
      ...event.entries.map((entry): UsedItem => ({ kind: "entry", entry: { ...entry, scope: { ...entry.scope } }, state: "used", pending: false, error: "" })),
      ...(event.tasks ?? []).map((task): UsedItem => ({ kind: "task", task, state: "used", pending: false, error: "" })),
    ];

    for (const item of incoming) if (!line.items.has(usedItemKey(item))) line.items.set(usedItemKey(item), item);
    renderUsedLine(line);
  }

  /** 最后一条用户消息之后、消息流里的最后一个回答。 */
  function latestAnswer(): HTMLElement | null {
    for (let node = messagesEl.lastElementChild; node && !node.matches(".msg.user"); node = node.previousElementSibling) {
      if (node instanceof HTMLElement && node.matches(".msg.assistant:not(.opening-line)")) return node;
    }

    return null;
  }

  function flushMemoryUsedLine(): void {
    const line = pendingUsedLine;
    pendingUsedLine = null;

    if (!line || !line.items.size) return;
    const answer = latestAnswer();

    // 这一轮没有回答（停止、出错）：不单独挂这一行，免得它悬在空处。
    if (!answer) return;

    // 复制按钮在最终稿放完后才挂：有它说明正文不会再整段重渲染。
    if (answer.querySelector(".answer-actions")) {
      placeUsedLine(line, answer);

      return;
    }

    if (repeatsEarlierUsedLine(line, null)) return;
    floatingUsedLine = line;
    messagesEl.appendChild(line.el);
    scrollToEnd();
  }

  /** 回答定稿（或重渲染后重新挂复制按钮）时调用：把这一轮的那一行放进首句。 */
  function adoptUsedLine(answer: HTMLElement): void {
    const line = usedLineByAnswer.get(answer) ?? (floatingUsedLine && answer === latestAnswer() ? floatingUsedLine : null);

    if (line) placeUsedLine(line, answer);
  }

  function placeUsedLine(line: MemoryUsedLine, answer: HTMLElement): void {
    if (floatingUsedLine === line) floatingUsedLine = null;

    // 和上一行用的是同一组记忆：不再每条回答都重复一遍。也不登记到回答上，网页上点「忘记」时改的是看得到的那一行。
    if (repeatsEarlierUsedLine(line, answer)) {
      line.el.remove();
      line.cite.remove();
      usedLineByAnswer.delete(answer);

      return;
    }
    line.answer = answer;
    usedLineByAnswer.set(answer, line);
    // 「用了 N 条记忆 ›」跟在首句后面，点开在首段下面撑出小条；「来源」面板只放网页。
    const first = answer.firstElementChild;
    let head: HTMLElement;

    // 首段是段落或标题就接在句尾；是列表、代码块等就单独起一行放在最前。
    if (first instanceof HTMLElement && /^(P|H[1-6])$/.test(first.tagName)) {
      head = first;
    } else {
      head = document.createElement("p");
      head.className = "memory-used-cite-row";
      answer.prepend(head);
    }

    head.append(line.cite);
    head.after(line.el);
    renderUsedLine(line);
  }

  /** 这一行实际用到的记忆（完整的一组，连同网站），摘要文字一样不代表用的是同几条。 */
  const usedLineKey = (line: MemoryUsedLine): string => `${line.hostname ?? ""}\n${[...line.items.keys()].sort().join("\n")}`;

  /** 对话里在 anchor 之前、看得到的最后一行用的是同一组记忆：只和紧挨着的上一行比，换过一组再换回来时重新显示。 */
  function repeatsEarlierUsedLine(line: MemoryUsedLine, anchor: Node | null): boolean {
    const earlier = Array.from(messagesEl.querySelectorAll<HTMLElement>(".memory-used-toggle")).filter(cite =>
      cite !== line.cite && (!anchor || !!(cite.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING)));

    return earlier.at(-1)?.dataset.usedKey === usedLineKey(line);
  }

  const USED_GLYPHS: Record<"past" | "profile" | "method", string> = {
    past: '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="5" cy="5" r="4"/><path d="M5 2.8V5l1.5 1"/></svg>',
    profile: '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="5" cy="3.3" r="1.8"/><path d="M1.6 9c.4-1.9 1.8-2.9 3.4-2.9S8 7.1 8.4 9"/></svg>',
    method: '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M2 2.5h6M2 5h4M2 7.5h5"/></svg>',
  };

  /** 行内点名用上的第一条（带给助手时排第一），多条时加「等 N 条」。太长的截断，全文在展开里。 */
  function usedLineLabel(line: MemoryUsedLine): string {
    const first = line.items.values().next().value!;
    const text = first.kind === "entry" ? first.entry.text : first.task.done || first.task.goal;
    const short = text.length > 16 ? `${text.slice(0, 15)}…` : text;

    return `${first.kind === "entry" ? "参考了你记住的" : "本轮提供的过往任务"}「${short}」${line.items.size > 1 ? `等 ${line.items.size} 条` : ""}`;
  }

  function renderUsedLine(line: MemoryUsedLine): void {
    line.el.className = "memory-used-line";
    line.el.dataset.memoryUsedLine = String(line.items.size);
    const cite = line.cite;
    cite.type = "button";
    cite.className = "memory-used-toggle";
    cite.dataset.usedKey = usedLineKey(line);
    cite.setAttribute("aria-expanded", String(line.open));
    const chevron = document.createElement("span");
    chevron.className = "memory-used-chevron";
    chevron.textContent = "›";
    cite.replaceChildren(`${usedLineLabel(line)} `, chevron);
    cite.onclick = () => { line.open = !line.open; renderUsedLine(line); };

    const list = document.createElement("ul");
    list.className = "memory-used-list";
    // 放进回答后由外层按 data-open 弹簧撑开（styles.css），列表本身常在，展开收起不重建节点。
    list.hidden = !line.open && !line.answer;
    line.el.dataset.open = String(line.open);
    const items = Array.from(line.items.values());
    const shown = line.showAll ? items : items.slice(0, USED_VISIBLE);

    for (const item of shown) list.appendChild(renderUsedItem(line, item));

    if (shown.length < items.length) {
      const more = document.createElement("li");
      more.className = "memory-used-more";
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `另有 ${items.length - shown.length} 条`;
      button.onclick = () => { line.showAll = true; renderUsedLine(line); };

      more.appendChild(button);
      list.appendChild(more);
    }

    // 还没放进回答时，灰字和列表一起独立成行。
    line.el.replaceChildren(...(line.answer ? [] : [cite]), list);
  }

  function usedButton(label: string, action: string, item: UsedItem, onClick: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.memoryUsedAction = action;
    button.textContent = label;
    button.disabled = item.pending;
    button.onclick = onClick;

    return button;
  }

  function renderUsedItem(line: MemoryUsedLine, item: UsedItem): HTMLElement {
    const row = document.createElement("li");
    row.className = "memory-used-item";
    row.dataset.usedKind = item.kind;
    row.dataset.usedId = item.kind === "entry" ? item.entry.id : item.task.id;
    row.dataset.state = item.state;
    const glyph = document.createElement("span");
    glyph.className = "memory-used-glyph";
    glyph.setAttribute("aria-hidden", "true");
    glyph.innerHTML = USED_GLYPHS[item.kind === "entry" ? item.entry.kind : "past"];
    const text = document.createElement("span");
    text.className = "memory-used-text";
    // 过往任务显示做成了什么（和带给助手的一样），没有时显示原话目标；完整原文在展开区换行。
    text.textContent = item.kind === "entry" ? item.entry.text : item.task.done || item.task.goal;
    text.title = text.textContent;
    const actions = document.createElement("span");
    actions.className = "memory-used-actions";
    const rerender = () => { if (line.el.isConnected || line === pendingUsedLine) renderUsedLine(line); };

    if (item.state === "used") {
      // 没有当前网站（扩展页、空白页）就没有「这里」可言。
      if (line.hostname) actions.append(usedButton("在这个网站不用", "not-here", item, () => runUsedAction(item, "not-here", rerender, line.hostname!)));
      actions.append(usedButton("忘记", "forget", item, () => runUsedAction(item, "forget", rerender)));
    } else {
      const note = document.createElement("span");
      note.className = "memory-used-note";
      note.textContent = item.state === "forgotten" ? "已忘记" : `在 ${line.hostname} 不用`;
      actions.append(note, usedButton("撤销", "undo", item, () => runUsedAction(item, "undo", rerender, line.hostname ?? undefined)));
    }

    row.append(glyph, text, actions);

    if (item.error) {
      const error = document.createElement("span");
      error.className = "memory-used-error";
      error.textContent = item.error;
      row.appendChild(error);
    }

    return row;
  }

  /** 本对话里最近一次带上这条记忆、还没动过的那一行（从最新的回答往前找）。 */
  function findUsedEntry(id: string): { line: MemoryUsedLine; item: UsedItem } | null {
    const answers = Array.from(messagesEl.querySelectorAll<HTMLElement>(".msg.assistant")).reverse();
    const lines = [pendingUsedLine, floatingUsedLine, ...answers.map(answer => usedLineByAnswer.get(answer) ?? null)];

    for (const line of lines) {
      const item = line?.items.get(`entry:${id}`);

      if (line && item?.state === "used" && !item.pending) return { line, item };
    }

    return null;
  }

  // 网页上「记得的」小卡点「忘掉」：用回答下面那一行同一套「忘掉」，展开那一行让你看到「已忘掉 · 撤销」。
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (!isPageInteractionMessage(message) || message.type !== "MEMORY_FIELD_FORGET") return;
    const found = findUsedEntry(message.id);

    if (!found) { respond({ ok: false });

   return; }

    const { line, item } = found;
    line.open = true;
    runUsedAction(item, "forget", () => {
      if (line.el.isConnected || line === pendingUsedLine) renderUsedLine(line);

      if (!item.pending) respond({ ok: item.state === "forgotten" });
    });

    return true;
  });

  /** 忘掉 / 这里别用 / 撤销：记忆走记忆面板的同一套请求，过往任务走过往任务的请求。 */
  function runUsedAction(item: UsedItem, action: "forget" | "not-here" | "undo", rerender: () => void, hostname?: string): void {
    const undoing = action === "undo" ? item.state : null;
    const next: UsedItem["state"] = action === "forget" ? "forgotten" : action === "not-here" ? "not-here" : "used";

    const done = (result: { ok: boolean; entry?: MemoryEntry; entries?: MemoryEntry[]; error?: string }) => {
      item.pending = false;

      if (result.ok) {
        item.state = next;
        item.error = "";

        if (item.kind === "entry") {
          if (action === "forget") item.removed = result.entries;
          const current = result.entry ?? result.entries?.find(entry => entry.id === item.entry.id);

          if (current) item.entry = current;
        }
      } else {
        item.error = `${action === "forget" ? "没能忘记" : action === "not-here" ? "没能改成在这个网站不用" : "没能撤销"}：${result.error ?? "再试一次"}`;
      }

      rerender();
    };

    item.pending = true;
    item.error = "";
    rerender();

    if (item.kind === "entry") {
      const message = action === "forget" ? drawer().memoryState.beginForget(conversationId(), item.entry)
        : undoing === "forgotten" ? drawer().memoryState.beginUnforget(conversationId(), item.removed ?? [item.entry])
          : drawer().memoryState.beginSite(conversationId(), item.entry, hostname!, action === "not-here");

      usedLineHandlers.set(message.requestId, done);
      drawer().dispatchMemoryRequest(message, { action: message.type === "memory_forget" ? "forget" : message.type === "memory_unforget" ? "unforget" : "site", entryId: item.entry.id });

      return;
    }

    const requestId = crypto.randomUUID();

    const message: ClientMessage = action === "forget" ? { type: "task_history_forget", requestId, conversationId: conversationId(), id: item.task.id }
      : undoing === "forgotten" ? { type: "task_history_restore", requestId, conversationId: conversationId(), task: item.task }
        : { type: "task_history_site", requestId, conversationId: conversationId(), id: item.task.id, hostname: hostname!, off: action === "not-here" };

    usedLineHandlers.set(requestId, done);

    if (!send(message)) {
      usedLineHandlers.delete(requestId);
      done({ ok: false, error: "侧栏和扩展后台断开了。稍后再试。" });
    }
  }

  /** 「原来是…」只写变了的部分：新旧值在同一个「：」或空格之前完全相同，就省掉这一段（不在词中间截断）。 */
  function changedPart(now: string, before: string): string {
    let cut = 0;

    for (let i = 0; i < Math.min(now.length, before.length) && now[i] === before[i]; i++) if ("：: ".includes(now[i]!)) cut = i + 1;

    return before.slice(cut) || before;
  }

  function renderMemoryReceipt(event: Extract<AgentUiEvent, { kind: "memory" }>): HTMLElement {
    const receipt = document.createElement("div");
    receipt.className = `memory-receipt memory-receipt-${event.action}`;
    const mark = document.createElement("span");
    mark.className = "memory-receipt-mark";
    // 记忆的身份标记：connecting 球（星座接线）。记录已落定，球定格不转。
    mark.appendChild(createOrb("connecting", ORB_BOX_RECEIPT).el);
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.memoryReceipt = event.action;
    button.textContent = event.action === "used"
      ? `使用了 ${event.entries.length} 条记忆 · 查看`
      : event.action === "forgotten"
        ? event.entries.some(entry => entry.experience) ? "旧做法已停用 · 查看" : "已忘记 · 查看"
        : event.action === "updated"
          ? "记忆已更新 · 查看"
          : event.entries.some(entry => entry.experience) ? "已记下这次纠正 · 查看" : "已记住 · 查看";
    const snapshots = event.entries.map((entry) => ({ ...entry, scope: { ...entry.scope } }));
    button.onclick = () => drawer().openMemoryDrawer({ action: event.action, entries: snapshots, message: event.message });
    receipt.append(mark, button);
    const single = event.entries.length === 1 && !event.entries[0]!.experience ? event.entries[0]! : null;
    const saved = event.action === "saved" ? single : null;
    // 改了一条资料：回执写出新值和旧值，「撤销」把旧值恢复回来。
    const previous = event.action === "updated" && single && event.replaced?.length === 1 && !event.replaced[0]!.experience ? event.replaced[0]! : null;
    const quick = saved ?? (previous && single);

    // 自动记下或改过的资料：回执直接写出记了什么，旁边给「撤销」（用户选的「自动记，给撤销」）。
    if (quick) {
      const text = document.createElement("span");
      text.className = "memory-receipt-text";
      text.textContent = previous ? `已更新：${quick.text}（原来是${changedPart(quick.text, previous.text)}）` : `已记住：${quick.text}`;
      text.title = text.textContent;
      button.textContent = "查看";
      const undo = document.createElement("button");
      undo.type = "button";
      undo.dataset.memoryUndo = quick.id;
      undo.textContent = "撤销";
      undo.onclick = () => {
        undo.disabled = true;
        const message = previous ? drawer().memoryState.beginRestore(conversationId(), previous) : drawer().memoryState.beginForget(conversationId(), quick);
        drawer().receiptUndos.set(message.requestId, (ok, error) => {
          if (ok) { text.textContent = previous ? `已撤销，还是${previous.text}` : "已撤销，不再记住这条"; text.title = text.textContent; undo.remove(); button.remove();

   return; }

          undo.disabled = false;
          text.textContent = `没能撤销：${error ?? "请重试"}`;
        });
        drawer().dispatchMemoryRequest(message, previous ? { action: "restore", entryId: previous.id } : { action: "forget", entryId: quick.id });
      };

      receipt.replaceChildren(mark, text, undo, button);
    }

    if (event.entries.length === 1 && !quick) {
      const scope = document.createElement("span");
      scope.className = "memory-receipt-scope";
      scope.textContent = memoryScopeLabel(event.entries[0]!.scope);
      receipt.appendChild(scope);
    }

    messagesEl.appendChild(receipt);
    scrollToEnd();

    return receipt;
  }

  // 纠正或攒够证据后开口问「要我记住吗」。
  /**
   * 询问事件：第一条带出卡片；同一 askId 带 outcome 的后续事件（现场或对话历史回放）把它推到结局。
   * 没有本地状态的回放卡片直接停在结局；没有结局的照常可点。
   */
  function renderMemoryAsk(event: MemoryAskEvent): void {
    if (!memoryAskCards.has(event.askId)) {
      const card = createAskCard(event, !replaying());
      memoryAskCards.set(event.askId, card);

      if (!replaying() && card.phase === "open") {
        openMemoryAsks.set(event.askId, Date.now());
        uiEvent("ui_memory_ask_shown", { askId: event.askId, source: askSource(event) });
      }
    }

    if (event.outcome) stepMemoryAsk(event.askId, { kind: "outcome", outcome: event.outcome });

    if (messagesEl.querySelector(`[data-memory-ask="${CSS.escape(event.askId)}"]`)) return;
    appendToMessages(buildMemoryAsk(event.askId));
    if (event.learned && !drawer().isListPending()) drawer().requestMemoryList();
    scrollToEnd();
  }

  /** 显示过、用户还没回应的询问卡片 → 显示时刻；复盘要分清「点了不记」和「根本没理」。 */
  const openMemoryAsks = new Map<string, number>();

  function askSource(event: MemoryAskEvent): string {
    return event.evidence ? "browsing" : event.quotes ? "style" : event.habit ? "habit" : "correction";
  }

  /** 还开着的询问没被回应就离开了视线（换会话、关侧栏、后台作废）。 */
  function memoryAsksUnanswered(reason: string, only?: string): void {
    for (const [askId, shownAt] of openMemoryAsks) {
      if (only && askId !== only) continue;
      openMemoryAsks.delete(askId);
      uiEvent("ui_memory_ask_unanswered", { askId, reason, shownMs: Date.now() - shownAt });
    }
  }

  /** 用户动作或后台结果交给询问卡片：重画，有请求就发出去，结果（含被忽略）再回到这里。 */
  function stepMemoryAsk(askId: string, input: AskInput): void {
    const current = memoryAskCards.get(askId);

    if (!current) return;
    const { card, request } = stepAsk(current, input);

    if (input.kind === "outcome" && input.outcome === "closed" && card.phase === "closed") memoryAsksUnanswered("closed", askId);
    else if (input.kind === "outcome") openMemoryAsks.delete(askId);

    if (input.kind === "remember" || input.kind === "once" || input.kind === "scope" || input.kind === "undo" || input.kind === "edit") {
      if (request || input.kind === "edit") {
        const shownAt = openMemoryAsks.get(askId);
        uiEvent("ui_memory_ask_action", { askId, action: input.kind, edited: "text" in input, ...(shownAt ? { shownMs: Date.now() - shownAt } : {}) });
      }

      if (request && (input.kind === "remember" || input.kind === "once")) openMemoryAsks.delete(askId);
    }
    memoryAskCards.set(askId, card);
    messagesEl.querySelector(`[data-memory-ask="${CSS.escape(askId)}"]`)?.replaceWith(buildMemoryAsk(askId));

    if (!request) return;

    const message = request.type === "answer"
      ? drawer().memoryState.beginAskAnswer(conversationId(), askId, request.answer, request.text)
      : request.type === "update"
        ? drawer().memoryState.beginUpdate(conversationId(), request.entry, request.text, request.scope)
        : request.type === "restore"
          ? drawer().memoryState.beginRestore(conversationId(), request.entry)
          : drawer().memoryState.beginForget(conversationId(), request.entry);

    memoryAskHandlers.set(message.requestId, (result) => stepMemoryAsk(askId, result));
    drawer().dispatchMemoryRequest(message, request.type === "answer" ? { action: "ask" } : { action: request.type, entryId: request.entry.id });
  }

  function memoryAskButton(className: string, label: string, input: AskInput, card: MemoryAskCard): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.disabled = card.pending !== null || !stepAsk(card, input).request;
    button.onclick = () => stepMemoryAsk(card.ask.askId, input);

    return button;
  }

  function buildMemoryAsk(askId: string): HTMLElement {
    const card = memoryAskCards.get(askId)!;
    const root = document.createElement("div");
    root.className = "memory-ask";
    root.dataset.memoryAsk = askId;
    root.dataset.state = card.phase;
    const line = document.createElement("p");
    line.className = "memory-ask-line";
    root.appendChild(line);
    const scopeLabel = (scope: MemoryScope): string => scope.kind === "all" ? "所有网站" : "这个网站";

    if (card.phase === "open" || card.phase === "closed") {
      const rule = card.ask.rule.trim().replace(/[。.!！?？，,；;]+$/u, "");
      // 习惯是不带主语的短句（「在 B 站提取字幕并保存」）；纠正是助手第一人称的承诺（「以后我都…」），不加前缀。
      line.textContent = card.ask.habit ? `你好像每次都这样做：${rule}。要我记住吗？` : `${rule}，要我记住吗？`;

      if (card.ask.evidence?.length) {
        const why = document.createElement("details");
        why.className = "memory-ask-replaces";
        why.dataset.memoryAskEvidence = "";
        const summary = document.createElement("summary");
        summary.textContent = `依据：${card.ask.evidence.length} 天里做过，来自你自己的浏览`;
        why.append(summary, ...card.ask.evidence.map(text => Object.assign(document.createElement("div"), { textContent: text })));
        root.appendChild(why);
      }

      if (card.ask.quotes?.length) {
        const why = document.createElement("details");
        why.className = "memory-ask-replaces";
        why.dataset.memoryAskEvidence = "";
        const summary = document.createElement("summary");
        summary.textContent = "依据：你对回答方式说过的话";
        why.append(summary, ...card.ask.quotes.map(text => Object.assign(document.createElement("div"), { textContent: text })));
        root.appendChild(why);
      }

      if (card.ask.replaces) {
        const replaces = document.createElement("p");
        replaces.className = "memory-ask-replaces";
        replaces.dataset.memoryAskReplaces = card.ask.replaces.id;
        replaces.textContent = `这会替换：${card.ask.replaces.text}`;
        root.appendChild(replaces);
      }

      // 已作废：问句加一行说明（后台的原话或「这条询问已结束」），不给按钮。
      if (card.phase === "closed") {
        const note = document.createElement("p");
        note.className = "memory-ask-replaces";
        note.textContent = card.error || "这条询问已结束";
        root.appendChild(note);

        return root;
      }

      // 「改一下」：在卡片里改规则文字，点「记住」时存改后的文字（范围仍是这张卡片的范围）。
      let draft: HTMLTextAreaElement | null = null;

      if (card.draft !== undefined) {
        draft = document.createElement("textarea");
        draft.className = "memory-ask-edit";
        draft.dataset.memoryAskEdit = "";
        draft.rows = 2;
        draft.maxLength = MEMORY_TEXT_MAX;
        draft.value = card.draft;
        draft.disabled = card.pending !== null;
        draft.setAttribute("aria-label", "改成要我记住的做法");
        root.appendChild(draft);
      }

      const pills = document.createElement("div");
      pills.className = "memory-ask-pills";

      for (const [answer, label] of [["remember", "记住"], ["once", "这次就行"]] as const) {
        const pill = memoryAskButton(answer === "remember" ? "memory-ask-pill memory-ask-yes" : "memory-ask-pill", label, { kind: answer }, card);
        pill.dataset.memoryAskAnswer = answer;

        if (answer === "remember" && draft) pill.onclick = () => stepMemoryAsk(card.ask.askId, { kind: "remember", text: draft.value });

        if (card.pending === answer) pill.setAttribute("aria-busy", "true");
        pills.appendChild(pill);
      }

      if (!draft) {
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "memory-ask-pill";
        edit.dataset.memoryAskEditOpen = "";
        edit.textContent = "改一下";
        edit.disabled = card.pending !== null;

        edit.onclick = () => {
          stepMemoryAsk(card.ask.askId, { kind: "edit" });
          messagesEl.querySelector<HTMLTextAreaElement>(`[data-memory-ask="${CSS.escape(card.ask.askId)}"] [data-memory-ask-edit]`)?.focus();
        };

        pills.appendChild(edit);
      }

      root.appendChild(pills);
    } else if (card.phase === "once") {
      line.textContent = "好，这次就不记了。";
    } else if (card.phase === "noted") {
      line.textContent = card.ask.learned ? `当时记下了：${card.ask.rule} 当前状态可在「记忆」中查看。` : "好，记住了。可在「记忆」面板查看或撤销";
    } else if (card.phase === "undone") {
      line.textContent = card.ask.learned ? "已删除这条规则。" : "已撤销。";

      if (card.ask.learned) {
        const details = document.createElement("details");
        details.className = "memory-ask-replaces";
        const summary = document.createElement("summary");
        summary.textContent = "删除影响";
        details.append(summary, "后续任务不再加载这条保存的规则。当前对话和过往任务仍可能影响回答，已执行的网页操作不变。");
        root.append(details);
      }
    } else if (card.phase === "inactive") {
      line.textContent = "这条规则已被替换或停用。";
    } else if (card.phase === "already") {
      line.append("已经记着了。");

      if (card.entry) {
        const scope = document.createElement("span");
        scope.className = "memory-ask-scope";
        scope.dataset.memoryAskScope = card.entry.scope.kind;
        scope.textContent = scopeLabel(card.entry.scope);
        line.append(scope);
      }
    } else if (card.entry) {
      const entry = card.entry;
      const scope = memoryAskButton("memory-ask-scope", scopeLabel(entry.scope), { kind: "scope" }, card);
      scope.dataset.memoryAskScope = entry.scope.kind;

      if (!scope.disabled) scope.title = entry.scope.kind === "site" ? `只在 ${entry.scope.hostname} 照做，点一下改成所有网站` : "在所有网站照做，点一下改成只在这个网站";
      const undo = memoryAskButton("memory-ask-undo", card.pending === "undo" ? (card.ask.learned ? "正在删除…" : "正在撤销…") : (card.ask.learned ? "删除规则" : "撤销"), { kind: "undo" }, card);
      undo.dataset.memoryAskUndo = entry.id;
      line.append(card.ask.learned ? `已记住：${entry.text.trim().replace(/[。.!！]+$/u, "")}。` : "好，记住了。", scope);

      if (card.ask.learned) {
        scope.textContent = entry.scope.kind === "site" ? `仅 ${entry.scope.hostname}` : "所有网站";
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "memory-ask-undo";
        edit.textContent = "编辑";
        edit.onclick = () => {
          drawer().openForEdit(entry);
        };
        line.append(edit);
      }

      line.append(undo);
    }

    if (card.error) {
      const error = document.createElement("p");
      error.className = "memory-ask-error";
      error.setAttribute("role", "alert");
      error.textContent = card.error;
      root.appendChild(error);
    }

    return root;
  }

  /** 记忆请求有了结果（抽屉已按结果更新本地记忆）：交给发出它的那一行或那张卡片，并同步已学会的规则。 */
  function settle(outcome: MemoryApplyResult): void {
    if (outcome.kind === "ignored") return;

    const lineHandler = usedLineHandlers.get(outcome.requestId);

    if (lineHandler) {
      usedLineHandlers.delete(outcome.requestId);
      lineHandler(outcome.kind === "success" ? { ok: true, entry: outcome.entry, entries: outcome.entries } : { ok: false, error: outcome.error });
    }

    const askHandler = memoryAskHandlers.get(outcome.requestId);

    if (askHandler) {
      memoryAskHandlers.delete(outcome.requestId);
      askHandler(outcome.kind === "success"
        ? { kind: "result", ok: true, entry: outcome.entry, entries: outcome.entries, alreadySaved: outcome.alreadySaved }
        : { kind: "result", ok: false, error: outcome.error, askClosed: outcome.askClosed });
    }

    if (outcome.kind !== "success") return;

    if (outcome.action === "list") {
      for (const [askId, card] of memoryAskCards) {
        if (card.ask.learned) stepMemoryAsk(askId, { kind: "sync", entry: drawer().memoryState.get(card.ask.learned.id) });
      }
    } else if (outcome.action === "update" && outcome.entry) {
      for (const [askId, card] of memoryAskCards) {
        if (card.ask.learned?.id === outcome.entry.id) stepMemoryAsk(askId, { kind: "sync", entry: outcome.entry });
      }
    }
  }

  /** 发出的请求被判作过期或不属于它：不会再有结果，那一条恢复可点。 */
  function settleIgnored(requestId: string): void {
    const lineHandler = usedLineHandlers.get(requestId);
    const askHandler = memoryAskHandlers.get(requestId);

    usedLineHandlers.delete(requestId);
    memoryAskHandlers.delete(requestId);
    lineHandler?.({ ok: false, error: "这条记忆刚在别处改过，请再试一次" });
    askHandler?.({ kind: "ignored" });
  }

  return {
    noteUsed: noteMemoryUsed,
    flushUsedLine: flushMemoryUsedLine,
    adoptUsedLine,
    resetUsedLines(): void {
      pendingUsedLine = null;
      floatingUsedLine = null;
    },
    renderReceipt: renderMemoryReceipt,
    renderAsk: renderMemoryAsk,
    asksUnanswered: memoryAsksUnanswered,
    settle,
    settleIgnored,
    /** 过往任务的忘掉/撤销/这里别用的结果；不是这里发出的返回 false。 */
    settleTaskHistory(requestId: string, ok: boolean, error?: string): boolean {
      const handler = usedLineHandlers.get(requestId);

      if (!handler) return false;
      usedLineHandlers.delete(requestId);
      handler(ok ? { ok: true } : { ok: false, error: error ?? "请重试" });

      return true;
    },
    hasLearnedRules: (): boolean => [...memoryAskCards.values()].some(card => card.ask.learned),
    isLearnedRule: (id: string): boolean => [...memoryAskCards.values()].some(card => card.ask.learned?.id === id),
  };
}
