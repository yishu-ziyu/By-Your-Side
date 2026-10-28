import type { AgentUiEvent, ClientMessage, ServerMessage } from "../../../shared/protocol.js";
import { MEMORY_KIND_LABEL, MEMORY_TEXT_MAX, normalizeMemoryHostname, type MemoryEntry, type MemoryScope } from "../../../shared/memory.js";
import type { TaskHistoryEntry } from "../../../shared/task-history.js";
import { BROWSE_CONTROL, BROWSE_DISMISSED_KEY, BROWSE_FOUND_KEY, BROWSE_LOG_KEY, BROWSE_ON_KEY, isBrowseOn, readBrowseEvents, readBrowseFound, readDismissed, type BrowseEvent } from "../shared/browse-habits.js";
import type { BrowseHabit } from "../../../shared/browse-habits.js";
import { MemoryManagementState, memoryKindLabel, memoryScopeLabel, memoryUseLabel, sameMemorySnapshot, type MemoryApplyResult } from "./memory.js";
import { MemoryHistoryOpen } from "./memory-history-open.js";
import { uiEvent } from "./ui-trace.js";

type MemoryInspection = {
  action: Extract<AgentUiEvent, { kind: "memory" }>["action"];
  entries: MemoryEntry[];
  message?: string;
};

type MemoryEdit = {
  id: string;
  text: string;
  scopeKind: MemoryScope["kind"];
  hostname: string;
  pendingRequestId: string | null;
  error: string;
};

type MemoryForget = { id: string; pendingRequestId: string | null; error: string };

type MemoryUiRequest = { action: "list" | "update" | "forget" | "restore" | "ask" | "site" | "unforget"; entryId?: string };

interface MemoryDrawerDeps {
  memoryDrawer: HTMLElement;
  memoryShade: HTMLElement;
  memoryOpen: HTMLButtonElement;
  memoryClose: HTMLButtonElement;
  memoryTitle: HTMLElement;
  memoryBody: HTMLElement;
  memorySearch: HTMLInputElement;
  send: (msg: ClientMessage) => boolean;
  selectedConversationId: () => string;
  conversationTitle: (id: string) => string | undefined;
  onPastTasksRendered: () => void;
  /** 对话里的记忆界面（回答下那一行、询问卡片）发出的请求，结果交回给它。 */
  onOutcome: (outcome: MemoryApplyResult) => void;
}

export function mountMemoryDrawer(deps: MemoryDrawerDeps) {
  const {
    memoryDrawer,
    memoryShade,
    memoryOpen,
    memoryClose,
    memoryTitle,
    memoryBody,
    memorySearch,
    send,
    selectedConversationId,
    conversationTitle,
    onPastTasksRendered,
    onOutcome,
  } = deps;

  const memoryState = new MemoryManagementState();
  const memoryUiRequests = new Map<string, MemoryUiRequest>();
  const receiptUndos = new Map<string, (ok: boolean, error?: string) => void>();
  const memoryHistoryOpen = new MemoryHistoryOpen();

  let memoryLoaded = false;
  let memoryListRequestId: string | null = null;
  let memoryListError = "";
  let memoryInspection: MemoryInspection | null = null;
  let memoryEdit: MemoryEdit | null = null;
  let memoryForget: MemoryForget | null = null;
  let memoryRestore: { id: string; pendingRequestId: string | null; error: string } | null = null;
  let currentMemoryHostname = "";
  let memoryQuery = "";
  let pastTasks: TaskHistoryEntry[] = [];
  let pastTasksRequestId: string | null = null;
  let pastTasksError = "";
  let pastTasksConfirmClear = false;
  let browseSeen: { on: boolean; found: BrowseHabit[]; recent: BrowseEvent[] } = { on: true, found: [], recent: [] };
  let browseClearArmed = false;

  const memoryEditorBusy = (): boolean => !!(memoryEdit || memoryForget || memoryRestore);
  const memoryMatches = (...texts: Array<string | undefined>) => !memoryQuery || texts.some(text => text?.toLowerCase().includes(memoryQuery));
  // 习惯的 key 由浏览内容生成，不进诊断；只记动作。
  const browseControl = (message: { action: "dismiss"; key: string } | { action: "clear" }) => {
    uiEvent(message.action === "clear" ? "ui_browse_clear" : "ui_browse_habit_dismiss");

    return chrome.runtime.sendMessage({ type: BROWSE_CONTROL, ...message }).catch(() => undefined);
  };

  function memoryButton(label: string, action: string, id?: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.memoryAction = action;
    if (id) button.dataset.memoryId = id;
    button.textContent = label;
    return button;
  }

  function memorySourceLabel(entry: MemoryEntry): string {
    return conversationTitle(entry.sourceConversationId) || "原会话";
  }

  function formatMemoryTime(timestamp: number): string {
    try {
      return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" }).format(timestamp);
    } catch {
      return "";
    }
  }

  function renderMemoryInspection(): HTMLElement | null {
    const inspection = memoryInspection;
    if (!inspection) return null;
    const section = document.createElement("section");
    section.className = "memory-inspection";
    const title = document.createElement("strong");
    title.textContent = inspection.action === "used"
      ? `这次回复使用了 ${inspection.entries.length} 条记忆`
      : inspection.action === "forgotten"
        ? "已忘记的记忆"
        : inspection.action === "updated"
          ? "更新的记忆"
          : "保存的记忆";
    section.appendChild(title);

    if (inspection.message) {
      const message = document.createElement("p");
      message.textContent = inspection.message;
      section.appendChild(message);
    } else if (inspection.action === "forgotten") {
      const message = document.createElement("p");
      message.textContent = "这条记忆不再用于新请求。以前的会话和回答不受影响。";
      section.appendChild(message);
    }

    for (const snapshot of inspection.entries) {
      const item = document.createElement("div");
      item.className = "memory-inspection-item";
      const text = document.createElement("p");
      text.textContent = snapshot.text;
      const meta = document.createElement("small");
      meta.textContent = `${memoryScopeLabel(snapshot.scope)} · 版本 ${snapshot.version}`;
      item.append(text, meta);
      const current = memoryState.get(snapshot.id);

      if (!current) {
        const changed = document.createElement("small");
        changed.className = "memory-inspection-changed";
        changed.textContent = "这条记忆现已忘记。这里保留的是旧回复的使用记录。";
        item.appendChild(changed);
      } else if (!sameMemorySnapshot(snapshot, current)) {
        const changed = document.createElement("small");
        changed.className = "memory-inspection-changed";
        changed.textContent = "此后已更新。下方列表显示当前版本。";
        item.appendChild(changed);
      }

      section.appendChild(item);
    }

    return section;
  }

  function renderMemoryEdit(entry: MemoryEntry): HTMLElement {
    const edit = memoryEdit!;
    const form = document.createElement("div");
    form.className = "memory-edit";

    const textLabel = document.createElement("label");
    textLabel.textContent = "记忆内容";
    const textarea = document.createElement("textarea");
    textarea.dataset.memoryField = "text";
    textarea.dataset.memoryId = entry.id;
    textarea.maxLength = MEMORY_TEXT_MAX;
    textarea.value = edit.text;
    textarea.disabled = edit.pendingRequestId !== null;
    textarea.oninput = () => { edit.text = textarea.value; edit.error = ""; };
    textLabel.appendChild(textarea);

    const scopeLabel = document.createElement("label");
    scopeLabel.textContent = "适用范围";
    const select = document.createElement("select");
    select.dataset.memoryField = "scope";
    select.dataset.memoryId = entry.id;
    select.disabled = edit.pendingRequestId !== null;

    for (const [value, label] of [["all", "所有网站"], ["site", "指定网站"]] as const) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      option.selected = edit.scopeKind === value;
      select.appendChild(option);
    }

    select.onchange = () => {
      edit.scopeKind = select.value as MemoryScope["kind"];
      if (edit.scopeKind === "site" && !edit.hostname) edit.hostname = currentMemoryHostname;
      edit.error = "";
      renderMemoryDrawer();
    };
    scopeLabel.appendChild(select);

    const hostnameLabel = document.createElement("label");
    hostnameLabel.textContent = "网站域名";
    hostnameLabel.hidden = edit.scopeKind !== "site";
    const hostname = document.createElement("input");
    hostname.type = "text";
    hostname.dataset.memoryField = "hostname";
    hostname.dataset.memoryId = entry.id;
    hostname.placeholder = "example.com";
    hostname.value = edit.hostname;
    hostname.disabled = edit.pendingRequestId !== null;
    hostname.oninput = () => { edit.hostname = hostname.value; edit.error = ""; };
    hostnameLabel.appendChild(hostname);

    const hint = document.createElement("p");
    hint.className = "memory-quiet";
    hint.textContent = `跨会话保留，只在相关任务中使用。${edit.text.length}/${MEMORY_TEXT_MAX}`;
    const error = document.createElement("p");
    error.className = "memory-error";
    error.hidden = !edit.error;
    error.textContent = edit.error;
    const actions = document.createElement("div");
    actions.className = "memory-actions";
    const cancel = memoryButton("取消", "cancel-edit", entry.id);
    cancel.disabled = edit.pendingRequestId !== null;
    const save = memoryButton(edit.pendingRequestId ? "正在保存…" : edit.error ? "重试保存" : "保存修改", "save", entry.id);
    save.className = "memory-primary";
    save.disabled = edit.pendingRequestId !== null;
    actions.append(cancel, save);
    form.append(textLabel, scopeLabel, hostnameLabel, hint, error, actions);

    return form;
  }

  function renderMemoryForgetConfirm(entry: MemoryEntry, state: MemoryForget): HTMLElement {
    const confirm = document.createElement("div");
    confirm.className = "memory-forget-confirm";
    const heading = document.createElement("strong");
    heading.textContent = "忘记这条记忆？";
    const explanation = document.createElement("p");
    explanation.textContent = "以后不再用这条记忆。以前的会话和回答不受影响。";
    const error = document.createElement("p");
    error.className = "memory-error";
    error.hidden = !state.error;
    error.textContent = state.error;
    const confirmActions = document.createElement("div");
    confirmActions.className = "memory-actions";
    const cancel = memoryButton("取消", "cancel-forget", entry.id);
    cancel.disabled = state.pendingRequestId !== null;

    const forget = memoryButton(
      state.pendingRequestId ? "正在忘记…" : state.error ? "重试忘记" : "确认忘记",
      "confirm-forget",
      entry.id,
    );
    forget.className = "memory-danger memory-forget-submit";
    forget.disabled = state.pendingRequestId !== null;
    confirmActions.append(cancel, forget);
    confirm.append(heading, explanation, error, confirmActions);

    return confirm;
  }

  function renderNotHere(hosts: string[] | undefined, restore: (hostname: string) => HTMLButtonElement): HTMLElement | null {
    if (!hosts?.length) return null;
    const notes = document.createElement("div");
    notes.className = "memory-not-here";

    for (const hostname of hosts) {
      const note = document.createElement("span");
      note.className = "memory-not-here-note";
      note.textContent = `在 ${hostname} 不用`;
      notes.append(note, restore(hostname));
    }

    return notes;
  }

  function renderMemoryEntry(entry: MemoryEntry, inGroup = false): HTMLElement {
    const card = document.createElement("article");
    card.className = "memory-row";
    card.dataset.memoryId = entry.id;

    if (memoryEdit?.id === entry.id) {
      card.appendChild(renderMemoryEdit(entry));
      return card;
    }

    const text = document.createElement("p");
    text.className = "memory-row-text";
    text.textContent = entry.text;
    const meta = document.createElement("div");
    meta.className = "memory-row-meta";
    const facts = document.createElement("span");
    facts.className = "memory-facts";
    const kind = document.createElement("span");
    kind.className = "memory-kind";
    kind.dataset.kind = entry.kind;
    kind.textContent = memoryKindLabel(entry);
    const scope = document.createElement("span");
    scope.className = "memory-scope";
    scope.textContent = memoryUseLabel(entry);
    const used = document.createElement("span");
    used.className = "memory-used";
    used.textContent = entry.useCount ? `用过 ${entry.useCount} 次` : "还没用过";

    if (inGroup) {
      const date = document.createElement("span");
      date.className = "memory-used";
      date.textContent = formatMemoryTime(entry.createdAt);
      facts.append(scope, date, used);
    } else {
      facts.append(kind, scope, used);
    }

    const actions = document.createElement("div");
    actions.append(
      memoryButton(card.classList.contains("show-source") ? "收起原话" : "查看原话", "source", entry.id),
      memoryButton("修改", "edit", entry.id),
      memoryButton("忘记", "forget", entry.id),
    );
    actions.lastElementChild?.classList.add("memory-danger");
    meta.append(facts, actions);
    card.append(text);

    if (!inGroup && entry.sourceQuote && entry.sourceQuote !== entry.text) {
      const quote = document.createElement("p");
      quote.className = "memory-quote";
      quote.textContent = `你说：「${entry.sourceQuote}」`;
      card.appendChild(quote);
    }

    card.appendChild(meta);

    const notHere = renderNotHere(entry.notOnHosts, (hostname) => {
      const restore = memoryButton("恢复", "site-on", entry.id);
      restore.dataset.memoryHost = hostname;
      return restore;
    });

    if (notHere) card.appendChild(notHere);

    const source = document.createElement("details");
    source.className = "memory-source";
    source.dataset.memorySource = entry.id;
    const summary = document.createElement("summary");
    summary.textContent = "来源";
    const detail = document.createElement("p");
    detail.textContent = `${inGroup && entry.sourceQuote ? `你当时说：「${entry.sourceQuote}」\n` : ""}会话：${memorySourceLabel(entry)}\n保存于 ${formatMemoryTime(entry.createdAt)} · 当前版本 ${entry.version}`;

    if (entry.experience) detail.textContent += `\n来自这次纠正的待验证做法；再次使用仍需检查。\n${entry.experience.evidence.map(line => line.replace(/^feedback-\d+：/, "你的纠正：").replace(/^(?:previous-)?observation-\d+：/, "网页结果：")).join("\n")}`;
    source.append(summary, detail);
    card.appendChild(source);

    if (memoryForget?.id === entry.id) card.appendChild(renderMemoryForgetConfirm(entry, memoryForget));

    return card;
  }

  function renderMemoryDrawer(): void {
    const shown = memoryBody.querySelector<HTMLDetailsElement>("details.memory-history");
    if (shown) memoryHistoryOpen.recordToggle(shown.open, shown.dataset.forced === "1");
    if (memoryState.takeDeferredRefresh(memoryEditorBusy())) queueMicrotask(() => { if (!memoryDrawer.hidden) requestMemoryList(); });
    const memories = renderMemoryFacts();
    const tasks = pastTasks.filter(task => memoryMatches(task.goal, task.summary));
    memoryBody.appendChild(renderPastTasks(tasks));

    if (!memoryQuery) return;
    memoryTitle.textContent = `找到 ${memories + tasks.length} 条`;
    if (memories + tasks.length) return;
    const nothing = document.createElement("p");
    nothing.className = "memory-quiet memory-search-empty";
    nothing.textContent = `没有找到和「${memorySearch.value.trim()}」有关的记忆或任务。`;
    memoryBody.appendChild(nothing);
  }

  memorySearch.addEventListener("input", () => {
    memoryQuery = memorySearch.value.trim().toLowerCase();
    renderMemoryDrawer();
  });

  const PAST_TASK_OUTCOME: Record<TaskHistoryEntry["outcome"], string> = { complete: "做完了", partial: "还差一些", stopped: "你中止了", error: "出错" };

  function requestPastTasks(forget?: string | null): void {
    if (forget !== undefined) uiEvent(forget === null ? "ui_past_tasks_clear" : "ui_past_task_delete", forget === null ? {} : { taskId: forget });
    pastTasksRequestId = crypto.randomUUID();
    pastTasksError = "";
    const conversationId = selectedConversationId();
    const message: ClientMessage = forget === undefined
      ? { type: "task_history_list", requestId: pastTasksRequestId, conversationId }
      : { type: "task_history_forget", requestId: pastTasksRequestId, conversationId, id: forget };

    if (!send(message)) {
      pastTasksRequestId = null;
      pastTasksError = "侧栏和扩展后台断开了。稍后再试。";
    }
  }

  function requestPastTaskSite(id: string, hostname: string): void {
    uiEvent("ui_past_task_site_restore", { taskId: id });
    pastTasksRequestId = crypto.randomUUID();
    pastTasksError = "";
    if (!send({ type: "task_history_site", requestId: pastTasksRequestId, conversationId: selectedConversationId(), id, hostname, off: false })) {
      pastTasksRequestId = null;
      pastTasksError = "侧栏和扩展后台断开了。稍后再试。";
    }
  }

  function renderPastTasks(shown: TaskHistoryEntry[]): HTMLElement {
    const section = document.createElement("section");
    section.className = "past-tasks";
    section.hidden = !!memoryQuery && !shown.length;
    const head = document.createElement("div");
    head.className = "past-tasks-head";
    const title = document.createElement("h3");
    title.textContent = shown.length ? `过往任务 · ${shown.length}` : "过往任务";
    head.appendChild(title);

    if (pastTasks.length && !memoryQuery) {
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = pastTasksConfirmClear ? "memory-danger" : "";
      clear.textContent = pastTasksConfirmClear ? "确认全部清空" : "全部清空";
      clear.onclick = () => {
        if (!pastTasksConfirmClear) { pastTasksConfirmClear = true; renderMemoryDrawer(); return; }
        pastTasksConfirmClear = false;
        requestPastTasks(null);
        renderMemoryDrawer();
      };
      head.appendChild(clear);
    }

    section.appendChild(head);
    const intro = document.createElement("p");
    intro.className = "memory-quiet";
    intro.textContent = "助手替你订了、交了、取消了什么，会在这里留一条；只打开、浏览页面的问题不留。以后助手能查到做过什么、在哪个网站做的。只存在这个浏览器里。";
    if (!memoryQuery) section.appendChild(intro);

    if (pastTasksError) {
      const failure = document.createElement("p");
      failure.className = "memory-error";
      failure.textContent = pastTasksError;
      section.appendChild(failure);
    }

    if (!pastTasks.length) {
      const empty = document.createElement("p");
      empty.className = "memory-quiet past-tasks-empty";
      empty.textContent = pastTasksRequestId ? "正在读取…" : "还没有记录。";
      section.appendChild(empty);
      return section;
    }

    for (const task of shown) {
      const row = document.createElement("article");
      row.className = "memory-row past-task";
      row.dataset.taskId = task.id;
      const goal = document.createElement("p");
      goal.className = "memory-row-text";
      goal.textContent = task.goal;
      const meta = document.createElement("div");
      meta.className = "memory-row-meta";
      const info = document.createElement("span");
      info.className = "memory-facts";
      const kind = document.createElement("span");
      kind.className = "memory-kind";
      kind.dataset.kind = "past";
      kind.textContent = MEMORY_KIND_LABEL.past;
      const detail = document.createElement("span");
      detail.className = "memory-quiet";
      detail.textContent = [formatMemoryTime(task.endedAt), PAST_TASK_OUTCOME[task.outcome], task.page ?? task.hosts[0], task.validity?.end ? memoryUseLabel({ scope: { kind: "all" }, validity: task.validity }) : ""].filter(Boolean).join(" · ");
      const used = document.createElement("span");
      used.className = "memory-used";
      used.textContent = task.useCount ? `用过 ${task.useCount} 次` : "还没用过";
      info.append(kind, detail, used);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "memory-danger";
      remove.textContent = "删除";
      remove.onclick = () => { requestPastTasks(task.id); renderMemoryDrawer(); };

      meta.append(info, remove);
      row.append(goal, meta);

      const notHere = renderNotHere(task.notOnHosts, (hostname) => {
        const restore = document.createElement("button");
        restore.type = "button";
        restore.textContent = "恢复";
        restore.onclick = () => { requestPastTaskSite(task.id, hostname); renderMemoryDrawer(); };
        return restore;
      });
      if (notHere) row.appendChild(notHere);

      if (task.unfinished.length) {
        const open = document.createElement("p");
        open.className = "memory-quiet";
        open.textContent = `还差：${task.unfinished.join("、")}`;
        row.appendChild(open);
      }

      section.appendChild(row);
    }

    return section;
  }

  function handlePastTasksResult(msg: Extract<ServerMessage, { type: "task_history_result" }>): void {
    if (msg.requestId !== pastTasksRequestId) return;
    pastTasksRequestId = null;
    if (msg.ok) pastTasks = msg.tasks ?? [];
    else pastTasksError = `未能读取过往任务：${msg.error ?? "未知原因"}`;

    if (!memoryDrawer.hidden) renderMemoryDrawer();
    onPastTasksRendered();
  }

  function renderMemoryHistory(history: MemoryEntry[]): HTMLElement {
    const section = document.createElement("details");
    section.className = "memory-history";
    const ids = new Set(history.map((entry) => entry.id));
    const forced = (!!memoryForget && ids.has(memoryForget.id)) || (!!memoryRestore && ids.has(memoryRestore.id));
    section.open = memoryHistoryOpen.shouldOpen(forced);
    if (forced) section.dataset.forced = "1";
    section.addEventListener("toggle", () => memoryHistoryOpen.recordToggle(section.open, forced));
    const summary = document.createElement("summary");
    summary.textContent = `历史 · ${history.length}`;
    const intro = document.createElement("p");
    intro.className = "memory-quiet";
    intro.textContent = "换成新值后，旧的留在这里，不再带给助手。";
    section.append(summary, intro);

    for (const entry of history) {
      const row = document.createElement("article");
      row.className = "memory-row memory-history-row";
      row.dataset.memoryId = entry.id;
      row.dataset.status = entry.status;
      const text = document.createElement("p");
      text.className = "memory-row-text";
      text.textContent = entry.text;
      const meta = document.createElement("div");
      meta.className = "memory-row-meta";
      const facts = document.createElement("span");
      facts.className = "memory-facts";
      const status = document.createElement("span");
      status.className = "memory-status";
      const replacer = entry.replacedBy ? memoryState.get(entry.replacedBy) : undefined;
      status.textContent = entry.status === "replaced" ? "已被替换" : "已失效";
      const kind = document.createElement("span");
      kind.className = "memory-kind";
      kind.dataset.kind = entry.kind;
      kind.textContent = memoryKindLabel(entry);
      facts.append(status, kind);

      if (replacer) {
        const by = document.createElement("span");
        by.className = "memory-quiet";
        by.textContent = `换成了「${replacer.text.length > 24 ? `${replacer.text.slice(0, 23)}…` : replacer.text}」`;
        facts.append(by);
      }

      const actions = document.createElement("div");
      const pending = memoryRestore?.id === entry.id && memoryRestore.pendingRequestId !== null;
      if (entry.status === "replaced" || entry.status === "invalid") {
        const restore = memoryButton(pending ? "正在恢复…" : entry.status === "replaced" ? "撤销替换" : "恢复这条", "restore", entry.id);
        restore.disabled = pending;
        actions.append(restore);
      }

      const forget = memoryButton("删除", "forget", entry.id);
      forget.classList.add("memory-danger");
      actions.append(forget);
      meta.append(facts, actions);
      row.append(text, meta);

      if (memoryRestore?.id === entry.id && memoryRestore.error) {
        const error = document.createElement("p");
        error.className = "memory-error";
        error.textContent = memoryRestore.error;
        row.appendChild(error);
      }

      if (memoryForget?.id === entry.id) row.appendChild(renderMemoryForgetConfirm(entry, memoryForget));
      section.appendChild(row);
    }

    return section;
  }

  async function loadBrowseSeen(): Promise<void> {
    const stored = await chrome.storage.local.get([BROWSE_ON_KEY, BROWSE_FOUND_KEY, BROWSE_LOG_KEY, BROWSE_DISMISSED_KEY]);
    const dismissed = readDismissed(stored[BROWSE_DISMISSED_KEY]);
    browseSeen = { on: isBrowseOn(stored[BROWSE_ON_KEY]), found: readBrowseFound(stored[BROWSE_FOUND_KEY]).filter(h => !dismissed.includes(h.key)), recent: readBrowseEvents(stored[BROWSE_LOG_KEY]) };
    memoryBody.querySelector('[data-memory-group="seen"]')?.replaceWith(renderSeenGroup());
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && [BROWSE_ON_KEY, BROWSE_FOUND_KEY, BROWSE_LOG_KEY, BROWSE_DISMISSED_KEY].some(key => key in changes)) void loadBrowseSeen().catch(() => {});
  });
  void loadBrowseSeen().catch(() => {});

  function renderSeenGroup(): HTMLElement {
    const group = document.createElement("section");
    group.className = "memory-group";
    group.dataset.memoryGroup = "seen";
    const heading = document.createElement("h3");
    heading.textContent = `看到的操作 · ${browseSeen.on ? "正在观察" : "已暂停"}`;
    const intro = document.createElement("p");
    intro.className = "memory-quiet";
    intro.textContent = browseSeen.on
      ? `已记下你自己做的 ${browseSeen.recent.length} 步。快速模型每半小时最多归纳一次，同一件事出现在 2 天里就问你要不要记住。`
      : `已暂停，暂停期间什么都不记。已记下的 ${browseSeen.recent.length} 步保留。`;
    group.append(heading, intro);
    const feedback = document.createElement("p");
    feedback.className = "memory-quiet";
    feedback.setAttribute("role", "status");
    const succeeded = (value: unknown): boolean => !!value && typeof value === "object" && "ok" in value && value.ok === true;
    const list = document.createElement("div");
    list.className = "memory-list";

    for (const habit of [...browseSeen.found].sort((a, b) => (b.days.at(-1) ?? "").localeCompare(a.days.at(-1) ?? ""))) {
      const row = document.createElement("div");
      row.className = "memory-row";
      row.dataset.browseHabit = habit.key;
      const text = document.createElement("p");
      text.className = "memory-row-text";
      text.textContent = habit.habit;
      const meta = document.createElement("div");
      meta.className = "memory-row-meta";
      const facts = document.createElement("div");
      facts.className = "memory-facts";
      const count = document.createElement("span");
      count.className = "memory-scope";
      count.textContent = `${habit.days.length} 天 · ${habit.times} 次`;
      const hosts = document.createElement("span");
      hosts.className = "memory-used";
      hosts.textContent = habit.hosts.slice(0, 3).join("、");
      facts.append(count, hosts);
      const actions = document.createElement("div");
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "删除";
      remove.onclick = async () => {
        remove.disabled = true;
        const result: unknown = await browseControl({ action: "dismiss", key: habit.key });
        if (!succeeded(result)) { feedback.textContent = "没有删除这条记录，请重试。"; remove.disabled = false; }
      };
      actions.append(remove);
      meta.append(facts, actions);
      row.append(text, meta);
      list.append(row);
    }

    group.append(list);

    if (browseSeen.recent.length) {
      const raw = document.createElement("details");
      raw.className = "memory-history";
      raw.dataset.browseRaw = "";
      const summary = document.createElement("summary");
      summary.textContent = `看原始记录（最近 ${Math.min(50, browseSeen.recent.length)} 步）`;
      const lines = document.createElement("p");
      lines.className = "memory-quiet";
      lines.style.whiteSpace = "pre-wrap";
      lines.textContent = browseSeen.recent.slice(-50).reverse().map(event => `${event.day.slice(5)} ${event.line}`).join("\n");
      raw.append(summary, lines);
      group.append(raw);
    }

    const actions = document.createElement("div");
    actions.className = "memory-actions";
    const pause = document.createElement("button");
    pause.type = "button";
    pause.dataset.browsePause = "";
    pause.textContent = browseSeen.on ? "暂停观察" : "继续观察";
    pause.onclick = () => {
      uiEvent("ui_browse_toggle", { on: !browseSeen.on });
      void chrome.storage.local.set({ [BROWSE_ON_KEY]: !browseSeen.on }).catch(() => { feedback.textContent = "没有保存观察状态，请重试。"; });
    };
    const clear = document.createElement("button");
    clear.type = "button";
    clear.textContent = "全部删除";
    clear.onclick = async () => {
      if (!browseClearArmed) {
        browseClearArmed = true;
        clear.textContent = "再点一次，全部删除";
        setTimeout(() => { browseClearArmed = false; clear.textContent = "全部删除"; }, 4000);
        return;
      }
      browseClearArmed = false;
      clear.disabled = true;
      clear.textContent = "全部删除";
      const result: unknown = await browseControl({ action: "clear" });
      if (!succeeded(result)) { feedback.textContent = "没有清除记录，请重试。"; clear.disabled = false; }
    };
    actions.append(pause, clear);
    group.append(actions, feedback);

    return group;
  }

  function renderMethodGroup(methods: MemoryEntry[]): HTMLElement {
    const group = document.createElement("section");
    group.className = "memory-group";
    group.dataset.memoryGroup = "method";
    group.hidden = !!memoryQuery && !methods.length;
    const heading = document.createElement("h3");
    heading.textContent = memoryQuery ? `${MEMORY_KIND_LABEL.method} · ${methods.length}` : MEMORY_KIND_LABEL.method;
    group.appendChild(heading);

    if (!methods.length) {
      const empty = document.createElement("p");
      empty.className = "memory-quiet";
      empty.textContent = "你纠正我之后，记下的做法会列在这里。";
      group.appendChild(empty);
    }

    for (const entry of methods) group.appendChild(renderMemoryEntry(entry, true));
    return group;
  }

  function renderMemoryFacts(): number {
    const all = memoryState.getEntries();
    const active = all.filter(entry => entry.status === "active");
    memoryTitle.textContent = active.length ? `记忆 · ${active.length}` : "记忆";
    const shown = all.filter(entry => memoryMatches(entry.text));
    const methods = shown.filter(entry => entry.status === "active" && entry.kind === "method");
    const entries = shown.filter(entry => entry.status === "active" && entry.kind !== "method");
    const history = shown.filter(entry => entry.status !== "active");
    const matched = shown.length;
    memoryBody.replaceChildren();
    const inspection = renderMemoryInspection();
    if (inspection) memoryBody.appendChild(inspection);

    const intro = document.createElement("p");
    intro.className = "memory-quiet memory-intro";
    intro.textContent = "你在会话里说过的邮箱、姓名、偏好和日程，会自动记在这里。关于你的记忆，每次回答都会用。带日期的记忆，过了那天就不再用。你可以修改或忘记任何一条。";
    if (!memoryQuery) memoryBody.appendChild(intro);

    if (memoryListError) {
      const failure = document.createElement("div");
      failure.className = "memory-load-error";
      const text = document.createElement("span");
      text.textContent = memoryListError;
      failure.append(text, memoryButton("重试", "reload"));
      memoryBody.appendChild(failure);
    }

    if (!memoryLoaded && memoryListRequestId) {
      const loading = document.createElement("div");
      loading.className = "memory-empty";
      loading.textContent = "正在读取记忆…";
      memoryBody.appendChild(loading);
      return 0;
    }

    if (!memoryLoaded && !memoryListRequestId) {
      const unavailable = document.createElement("div");
      unavailable.className = "memory-empty";
      unavailable.append("还不能读取记忆。", memoryButton("重试", "reload"));
      memoryBody.appendChild(unavailable);
      return 0;
    }

    if (entries.length === 0 && history.length === 0) {
      const empty = document.createElement("div");
      empty.className = "memory-empty";
      const heading = document.createElement("strong");
      heading.textContent = "还没有保存的记忆";
      const text = document.createElement("p");
      text.textContent = "你在会话里说过的邮箱、姓名，会自动记在这里。";
      empty.append(heading, text);
      if (!methods.length && !memoryQuery) memoryBody.appendChild(empty);
      if (!memoryQuery) memoryBody.appendChild(renderSeenGroup());
      memoryBody.appendChild(renderMethodGroup(methods));
      return matched;
    }

    const list = document.createElement("div");
    list.className = "memory-list";
    for (const entry of entries) list.appendChild(renderMemoryEntry(entry));
    memoryBody.appendChild(list);
    if (!memoryQuery) memoryBody.appendChild(renderSeenGroup());
    memoryBody.appendChild(renderMethodGroup(methods));
    if (history.length) memoryBody.appendChild(renderMemoryHistory(history));

    return matched;
  }

  function processMemoryOutcome(outcome: MemoryApplyResult): void {
    if (outcome.kind === "ignored") return;
    const undo = receiptUndos.get(outcome.requestId);
    if (undo) {
      receiptUndos.delete(outcome.requestId);
      undo(outcome.kind === "success", outcome.kind === "failure" ? outcome.error : undefined);
    }

    onOutcome(outcome);

    const uiRequest = memoryUiRequests.get(outcome.requestId);
    memoryUiRequests.delete(outcome.requestId);

    if (outcome.action === "list") {
      if (memoryListRequestId !== outcome.requestId) return;
      memoryListRequestId = null;
      if (outcome.kind === "success") {
        memoryLoaded = true;
        memoryListError = "";
        if (memoryEdit && !memoryState.get(memoryEdit.id)) memoryEdit = null;
        if (memoryForget && !memoryState.get(memoryForget.id)) memoryForget = null;
      } else {
        memoryListError = `未能读取记忆：${outcome.error}`;
      }
    } else if (outcome.action === "update" && uiRequest?.entryId) {
      if (memoryEdit?.id === uiRequest.entryId && memoryEdit.pendingRequestId === outcome.requestId) {
        memoryEdit.pendingRequestId = null;
        if (outcome.kind === "success") memoryEdit = null;
        else memoryEdit.error = `修改未保存：${outcome.error}`;
      }
    } else if (outcome.action === "restore" && uiRequest?.entryId) {
      if (memoryRestore?.id === uiRequest.entryId && memoryRestore.pendingRequestId === outcome.requestId) {
        memoryRestore.pendingRequestId = null;
        if (outcome.kind === "success") memoryRestore = null;
        else memoryRestore.error = `没有撤销：${outcome.error}`;
      }
    } else if (outcome.action === "forget" && uiRequest?.entryId) {
      if (memoryForget?.id === uiRequest.entryId && memoryForget.pendingRequestId === outcome.requestId) {
        memoryForget.pendingRequestId = null;
        if (outcome.kind === "success") memoryForget = null;
        else memoryForget.error = `没有忘记这条记忆：${outcome.error}`;
      }
    }

    if (!memoryDrawer.hidden) renderMemoryDrawer();
    if (outcome.kind === "success" && (outcome.action === "forget" || outcome.action === "restore" || outcome.action === "site" || outcome.action === "unforget" || (outcome.action === "ask" && outcome.entry && !outcome.alreadySaved))) requestMemoryList();
  }

  function dispatchMemoryRequest(message: Extract<ClientMessage, { type: "memory_list" | "memory_update" | "memory_forget" | "memory_restore" | "memory_ask_answer" | "memory_site" | "memory_unforget" }>, ui: MemoryUiRequest): void {
    // 「ask」由询问卡片自己记（带显示时长）；这里记面板里对一条记忆的处理。
    if (ui.action !== "list" && ui.action !== "ask") {
      const kind = ui.entryId ? memoryState.get(ui.entryId)?.kind : undefined;
      uiEvent("ui_memory_entry_action", { action: ui.action, entryId: ui.entryId, kind, ...(message.type === "memory_site" ? { off: message.off } : {}) });
    }
    memoryUiRequests.set(message.requestId, ui);
    if (send(message)) return;
    processMemoryOutcome(memoryState.rejectLocally(message.requestId, "侧栏和扩展后台断开了。稍后再试。"));
  }

  function requestMemoryList(): void {
    requestPastTasks();
    const message = memoryState.beginList(selectedConversationId());
    memoryListRequestId = message.requestId;
    memoryListError = "";
    renderMemoryDrawer();
    dispatchMemoryRequest(message, { action: "list" });
  }

  function openMemoryDrawer(inspection: MemoryInspection | null = null): void {
    memoryInspection = inspection;
    memoryEdit = null;
    memoryForget = null;
    memoryHistoryOpen.reset();
    if (memoryDrawer.hidden) uiEvent("ui_memory_drawer_open", { fromInspection: inspection !== null });
    memoryDrawer.hidden = false;
    memoryShade.hidden = false;
    memoryOpen.setAttribute("aria-expanded", "true");
    renderMemoryDrawer();
    requestMemoryList();
    memoryClose.focus();
  }

  function closeMemoryDrawer(): void {
    if (!memoryDrawer.hidden) uiEvent("ui_memory_drawer_close");
    memoryDrawer.hidden = true;
    memorySearch.value = "";
    memoryQuery = "";
    memoryShade.hidden = true;
    memoryOpen.setAttribute("aria-expanded", "false");
    memoryEdit = null;
    memoryForget = null;
    memoryInspection = null;
    memoryOpen.focus();
  }

  memoryOpen.onclick = () => memoryDrawer.hidden ? openMemoryDrawer() : closeMemoryDrawer();
  memoryClose.onclick = closeMemoryDrawer;
  memoryShade.onclick = closeMemoryDrawer;

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !memoryDrawer.hidden) {
      event.preventDefault();
      closeMemoryDrawer();
    }
  });

  memoryBody.addEventListener("click", (event) => {
    const target = (event.target as Element).closest<HTMLButtonElement>("button[data-memory-action]");
    if (!target) return;
    const action = target.dataset.memoryAction;
    const id = target.dataset.memoryId;

    if (action === "reload") {
      requestMemoryList();
      return;
    }

    if (!id) return;
    const entry = memoryState.get(id);
    if (!entry) {
      requestMemoryList();
      return;
    }

    if (action === "source") {
      const details = memoryBody.querySelector<HTMLDetailsElement>(`details[data-memory-source="${CSS.escape(id)}"]`);
      if (details) details.open = !details.open;
      return;
    }

    if (action === "edit") {
      memoryForget = null;
      memoryEdit = {
        id,
        text: entry.text,
        scopeKind: entry.scope.kind,
        hostname: entry.scope.kind === "site" ? entry.scope.hostname : currentMemoryHostname,
        pendingRequestId: null,
        error: "",
      };
      renderMemoryDrawer();
      memoryBody.querySelector<HTMLTextAreaElement>(`textarea[data-memory-id="${CSS.escape(id)}"]`)?.focus();
      return;
    }

    if (action === "cancel-edit") {
      memoryEdit = null;
      renderMemoryDrawer();
      return;
    }

    if (action === "save" && memoryEdit?.id === id) {
      const text = memoryEdit.text.trim();
      if (!text) {
        memoryEdit.error = "写一句要记住的话。";
        renderMemoryDrawer();
        return;
      }
      if (text.length > MEMORY_TEXT_MAX) {
        memoryEdit.error = `记忆内容最多 ${MEMORY_TEXT_MAX} 个字符。`;
        renderMemoryDrawer();
        return;
      }

      let scope: MemoryScope = { kind: "all" };
      if (memoryEdit.scopeKind === "site") {
        const hostname = normalizeMemoryHostname(memoryEdit.hostname);
        if (!hostname) {
          memoryEdit.error = "填网站域名，例如 example.com。";
          renderMemoryDrawer();
          return;
        }
        memoryEdit.hostname = hostname;
        scope = { kind: "site", hostname };
      }

      const message = memoryState.beginUpdate(selectedConversationId(), entry, text, scope);
      memoryEdit.pendingRequestId = message.requestId;
      memoryEdit.error = "";
      renderMemoryDrawer();
      dispatchMemoryRequest(message, { action: "update", entryId: id });
      return;
    }

    if (action === "restore") {
      const message = memoryState.beginRestore(selectedConversationId(), entry);
      memoryRestore = { id, pendingRequestId: message.requestId, error: "" };
      renderMemoryDrawer();
      dispatchMemoryRequest(message, { action: "restore", entryId: id });
      return;
    }

    if (action === "forget") {
      memoryEdit = null;
      memoryForget = { id, pendingRequestId: null, error: "" };
      renderMemoryDrawer();
      return;
    }

    if (action === "cancel-forget") {
      memoryForget = null;
      renderMemoryDrawer();
      return;
    }

    if (action === "confirm-forget" && memoryForget?.id === id) {
      const message = memoryState.beginForget(selectedConversationId(), entry);
      memoryForget.pendingRequestId = message.requestId;
      memoryForget.error = "";
      renderMemoryDrawer();
      dispatchMemoryRequest(message, { action: "forget", entryId: id });
      return;
    }

    if (action === "site-on" && target.dataset.memoryHost) {
      target.disabled = true;
      dispatchMemoryRequest(memoryState.beginSite(selectedConversationId(), entry, target.dataset.memoryHost, false), { action: "site", entryId: id });
    }
  });

  return {
    memoryState,
    receiptUndos,
    openMemoryDrawer,
    openForEdit(entry: MemoryEntry): void {
      openMemoryDrawer();
      memoryEdit = {
        id: entry.id,
        text: entry.text,
        scopeKind: entry.scope.kind,
        hostname: entry.scope.kind === "site" ? entry.scope.hostname : currentMemoryHostname,
        pendingRequestId: null,
        error: "",
      };
      renderMemoryDrawer();
    },
    closeMemoryDrawer,
    renderMemoryDrawer,
    requestMemoryList,
    requestPastTasks,
    dispatchMemoryRequest,
    processMemoryOutcome,
    handlePastTasksResult,
    refreshIfStale(rev: number | undefined, hasLearnedRules: boolean): void {
      if ((memoryDrawer.hidden && !hasLearnedRules) || !memoryLoaded) return;
      if (memoryState.noteRev(rev, memoryEditorBusy())) requestMemoryList();
    },
    setCurrentHostname(hostname: string): void {
      currentMemoryHostname = hostname;
    },
    setSearchQuery(query: string): void {
      memoryQuery = query.trim().toLowerCase();
    },
    getPastTasks(): readonly TaskHistoryEntry[] {
      return pastTasks;
    },
    isPastTasksPending(): boolean {
      return pastTasksRequestId !== null;
    },
    isListPending(): boolean {
      return memoryListRequestId !== null;
    },
  };
}
