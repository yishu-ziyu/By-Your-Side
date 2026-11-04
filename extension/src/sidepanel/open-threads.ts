import type { ClientMessage, ConversationSummary, ServerMessage } from "../../../shared/protocol.js";
import type { TaskHistoryEntry } from "../../../shared/task-history.js";
import type { ReadingTurn } from "../../../shared/reading.js";
import { plainStep } from "../../../shared/user-facing.js";

export const OPEN_THREADS_KEY = "sideagent_open_threads";

const HIDDEN_KEY = "sideagent_open_threads_hidden";

const READING_STORE = "readingRecords";

const OPEN_THREADS_MAX = 3;

const OPEN_THREADS_HIDE_MS = 7 * 24 * 60 * 60 * 1000;

const PAST_TASKS_FRESH_MS = 20_000;

type OpenThreadAction =
  | { kind: "conversation"; conversationId: string }
  | { kind: "tab"; tabId: number; url: string };

interface OpenThread {
  id: string;
  title: string;
  where: string;
  label: string;
  site?: string;
  at: number;
  action: OpenThreadAction;
}

interface ReadingSnapshot {
  threadId: string;
  source: { title: string; url: string; text: string; tabId: number };
  turns: Pick<ReadingTurn, "question" | "state">[];
  transferredConversationId?: string;
  updatedAt: number;
}

interface OpenThreadInputs {
  conversations: ConversationSummary[];
  pastTasks: TaskHistoryEntry[];
  readings: ReadingSnapshot[];
  currentConversationId: string;
  hidden: Record<string, number>;
  now: number;
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function relativeDay(at: number, now: number): string {
  const day = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0);

 return d.getTime(); };

  const days = Math.round((day(now) - day(at)) / 86_400_000);

  if (now - at < 3_600_000) return "刚才";

  return days <= 0 ? "今天" : days === 1 ? "昨天" : `${days} 天前`;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();

  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const PAST_OUTCOME_LINE: Record<TaskHistoryEntry["outcome"], string> = {
  complete: "做完了",
  partial: "上次没做完",
  stopped: "你中止了任务",
  error: "上次出错，任务停在中途",
};

function collectOpenThreads(input: OpenThreadInputs): OpenThread[] {
  const out: OpenThread[] = [];
  const known = new Map(input.conversations.map((c) => [c.id, c]));
  const claimed = new Set<string>();

  for (const c of input.conversations) {
    if (c.id === input.currentConversationId || c.state === "running") continue;
    const title = clip(c.title || "未命名会话", 40);

    if (c.checkpoint === "interrupted") {
      out.push({ id: `conv:${c.id}:${c.runId ?? ""}`, title, where: "任务中断了。打开会话后，点「继续原任务」", label: "回到这个任务", at: c.updatedAt, action: { kind: "conversation", conversationId: c.id } });
      claimed.add(c.id);
    } else if (c.state === "user") {
      out.push({ id: `user:${c.id}:${c.runId ?? ""}`, title, where: "页面现在归你。助手在等你回复", label: "回到这个会话", at: c.updatedAt, action: { kind: "conversation", conversationId: c.id } });
      claimed.add(c.id);
    }
  }

  const latest = new Map<string, TaskHistoryEntry>();

  for (const t of input.pastTasks) {
    const prev = latest.get(t.conversationId);

    if (!prev || t.endedAt > prev.endedAt) latest.set(t.conversationId, t);
  }

  for (const t of latest.values()) {
    if (t.conversationId === input.currentConversationId || claimed.has(t.conversationId) || !known.has(t.conversationId)) continue;

    if (known.get(t.conversationId)!.state === "running") continue;
    const open = t.unfinished.length > 0 || t.outcome !== "complete";

    if (!open) continue;
    const where = t.unfinished.length ? `还差：${clip(plainStep(t.unfinished[0]!), 30)}${t.unfinished.length > 1 ? ` 等 ${t.unfinished.length} 件` : ""}` : PAST_OUTCOME_LINE[t.outcome];
    const thread: OpenThread = { id: `task:${t.id}`, title: t.title ?? clip(t.goal, 40), where, label: t.next ?? "回到这个任务", at: t.endedAt, action: { kind: "conversation", conversationId: t.conversationId } };

    if (t.hosts[0]) thread.site = t.hosts[0];
    out.push(thread);
    claimed.add(t.conversationId);
  }

  for (const r of input.readings) {
    const last = r.turns.at(-1);

    if (!last || (last.state !== "error" && last.state !== "stopped") || r.transferredConversationId) continue;
    out.push({
      id: `read:${r.threadId}:${r.turns.length}`,
      title: clip(r.source.title || r.source.text, 40),
      where: `追问没答完：${clip(last.question, 30)}`,
      label: "打开上次页面",
      site: hostOf(r.source.url),
      at: r.updatedAt,
      action: { kind: "tab", tabId: r.source.tabId, url: r.source.url },
    });
  }

  return out
    .filter((t) => !((input.hidden[t.id] ?? 0) > input.now))
    .sort((a, b) => b.at - a.at)
    .slice(0, OPEN_THREADS_MAX);
}

interface OpenThreadsDeps {
  root: HTMLElement;
  send: (msg: ClientMessage) => boolean;
  conversations: () => Iterable<ConversationSummary>;
  currentConversationId: () => string;
  ready: () => boolean;
  selectConversation: (id: string) => void;
}

let deps: OpenThreadsDeps | null = null;

let box: HTMLElement | null = null;

let pastTasks: TaskHistoryEntry[] = [];

let pastTasksAt = 0;

let requestId: string | null = null;

let renderSeq = 0;

export function configureOpenThreads(next: OpenThreadsDeps): void {
  deps = next;
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === "local" && (OPEN_THREADS_KEY in changes || HIDDEN_KEY in changes)) refreshOpenThreads();

    if (area === "session" && READING_STORE in changes) refreshOpenThreads();
  });
  refreshOpenThreads();
}

export function receiveOpenThreadsTasks(msg: Extract<ServerMessage, { type: "task_history_result" }>): boolean {
  if (!requestId || msg.requestId !== requestId) return false;
  requestId = null;

  if (msg.ok) {
    pastTasks = msg.tasks ?? [];
    pastTasksAt = Date.now();
  }

  refreshOpenThreads();

  return true;
}

function container(): HTMLElement | null {
  if (!deps) return null;

  if (!box || !box.isConnected) {
    box = deps.root.querySelector<HTMLElement>("#open-threads");

    if (!box) {
      box = document.createElement("div");
      box.id = "open-threads";
      box.setAttribute("aria-label", "继续上次的事");
      box.hidden = true;
      deps.root.append(box);
    }
  }

  return box;
}

function clear(): void {
  const el = container();

  if (!el) return;
  el.hidden = true;
  el.replaceChildren();
}

export function refreshOpenThreads(): void {
  if (!deps || typeof chrome === "undefined" || !chrome.storage?.local) return;
  const seq = ++renderSeq;

  void (async () => {
    const local = await chrome.storage.local.get([OPEN_THREADS_KEY, HIDDEN_KEY]);

    if (seq !== renderSeq) return;

    if (local[OPEN_THREADS_KEY] !== true || !deps!.ready()) { clear();

 return; }

    if (!requestId && Date.now() - pastTasksAt > PAST_TASKS_FRESH_MS) {
      requestId = crypto.randomUUID();

      if (!deps!.send({ type: "task_history_list", requestId })) requestId = null;
    }

    let readings: ReadingSnapshot[] = [];

    try {
      const session = await chrome.storage.session.get(READING_STORE);
      const raw: unknown = session[READING_STORE];
      readings = Array.isArray(raw) ? raw.filter(isReadingSnapshot) : [];
    } catch { readings = []; }

    readings = (await Promise.all(readings.map(async (r) => {
      try {
        const tab = await chrome.tabs.get(r.source.tabId);

        return tab.url === r.source.url ? r : null;
      } catch { return null; }
    }))).filter((r): r is ReadingSnapshot => r !== null);

    if (seq !== renderSeq) return;
    const now = Date.now();
    const rawHidden: unknown = local[HIDDEN_KEY];
    const hidden: Record<string, number> = isObjectValue(rawHidden) ? Object.fromEntries(Object.entries(rawHidden).filter(([, until]) => isNumber(until) && until > now)) : {};

    render(collectOpenThreads({ conversations: [...deps!.conversations()], pastTasks, readings, currentConversationId: deps!.currentConversationId(), hidden, now }));
  })().catch(() => clear());
}

const isObjectValue = (v: unknown): v is object => !!v && typeof v === "object";

const isNumber = (v: unknown): v is number => typeof v === "number";

function isReadingTurn(t: unknown): t is ReadingSnapshot["turns"][number] {
  return !!t && typeof t === "object" && "question" in t && typeof t.question === "string" && "state" in t && typeof t.state === "string";
}

function isReadingSnapshot(v: unknown): v is ReadingSnapshot {
  if (!v || typeof v !== "object") return false;
  const r = v as ReadingSnapshot;

  return typeof r.threadId === "string" && !!r.source && typeof r.source.tabId === "number" && typeof r.source.url === "string"
    && typeof r.source.title === "string" && typeof r.source.text === "string" && Array.isArray(r.turns)
    && r.turns.every(isReadingTurn) && typeof r.updatedAt === "number";
}

async function hide(id: string): Promise<void> {
  const now = Date.now();
  const stored = (await chrome.storage.local.get(HIDDEN_KEY))[HIDDEN_KEY];
  const kept = isObjectValue(stored) ? Object.fromEntries(Object.entries(stored).filter(([, until]) => isNumber(until) && until > now)) : {};
  await chrome.storage.local.set({ [HIDDEN_KEY]: { ...kept, [id]: now + OPEN_THREADS_HIDE_MS } });
}

async function act(action: OpenThreadAction): Promise<void> {
  if (action.kind === "conversation") { deps?.selectConversation(action.conversationId);

 return; }

  const tab = await chrome.tabs.update(action.tabId, { active: true });

  if (tab?.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
}

function render(threads: OpenThread[]): void {
  const el = container();

  if (!el) return;

  if (!threads.length) { clear();

 return; }

  const head = document.createElement("p");
  head.className = "open-threads-head";
  head.textContent = "继续上次的事";
  const now = Date.now();

  const rows = threads.map((thread) => {
    const row = document.createElement("div");
    row.className = "open-thread";
    row.dataset.threadId = thread.id;
    const go = document.createElement("button");
    go.type = "button";
    go.className = "open-thread-go";
    go.title = thread.where;
    const glyph = document.createElement("span");
    glyph.className = "open-thread-glyph";
    glyph.setAttribute("aria-hidden", "true");
    glyph.textContent = (thread.site || thread.title).charAt(0).toUpperCase();
    const title = document.createElement("span");
    title.className = "open-thread-title";
    title.textContent = thread.title;
    const time = document.createElement("span");
    time.className = "open-thread-time";
    time.textContent = relativeDay(thread.at, now);
    const next = document.createElement("span");
    next.className = "open-thread-next";
    next.textContent = `${thread.label} →`;
    go.append(glyph, title, time, next);
    go.onclick = () => void act(thread.action).catch(() => {
      next.textContent = "原页面已经找不到了";
      go.disabled = true;
    });
    const close = document.createElement("button");
    close.type = "button";
    close.className = "open-thread-close";
    close.textContent = "×";
    close.title = "7 天内不再显示这条";
    close.setAttribute("aria-label", `隐藏「${thread.title}」7 天`);
    close.onclick = () => { row.remove(); void hide(thread.id); };

    row.append(go, close);

    return row;
  });

  el.replaceChildren(head, ...rows);
  el.hidden = false;
}
