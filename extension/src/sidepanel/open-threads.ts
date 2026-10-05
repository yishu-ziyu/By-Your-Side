/**
 * #53 继续上次的事：空白新对话的起点区里，最多摆 3 张「没做完的事」卡，每张一个下一步按钮。
 *
 * 诚实边界：
 * - 只用本机已有记录：会话清单（中断、页面交给你）、过往任务（没做完的那条）、阅读记录（追问没答完）。
 * - 按钮只做记录里有依据的事：回到原会话（续做仍走那里的「继续原任务」）或切回原标签页。
 *   不发任务、不写页面、不编下一步。没有符合的记录就什么都不显示。
 * - 设置「继续上次的事」默认关；单张卡点 × 后 7 天内不再出现。
 */
import type { ClientMessage, ConversationSummary, ServerMessage } from "../../../shared/protocol.js";
import type { TaskHistoryEntry } from "../../../shared/task-history.js";
import type { ReadingTurn } from "../../../shared/reading.js";
import { plainStep } from "../../../shared/user-facing.js";

/** chrome.storage.local：true 才开启（默认关）。 */
export const OPEN_THREADS_KEY = "sideagent_open_threads";

/** chrome.storage.local：卡片 id → 隐藏到期时间（毫秒）。 */
const HIDDEN_KEY = "sideagent_open_threads_hidden";

/** 与 background/reading.ts 的存储键一致（chrome.storage.session）。 */
const READING_STORE = "readingRecords";

export const OPEN_THREADS_MAX = 3;

export const OPEN_THREADS_HIDE_MS = 7 * 24 * 60 * 60 * 1000;

/** 过往任务清单的缓存时长：起点区反复刷新时不每次都去宿主读。 */
const PAST_TASKS_FRESH_MS = 20_000;

export type OpenThreadAction =
  | { kind: "conversation"; conversationId: string }
  | { kind: "tab"; tabId: number; url: string };

export interface OpenThread {
  id: string;
  title: string;
  where: string;
  label: string;
  at: number;
  action: OpenThreadAction;
}

/** 面板里拿得到的阅读记录字段（background ReadingRecord 的子集）。 */
export interface ReadingSnapshot {
  threadId: string;
  source: { title: string; url: string; text: string; tabId: number };
  turns: Pick<ReadingTurn, "question" | "state">[];
  transferredConversationId?: string;
  updatedAt: number;
}

export interface OpenThreadInputs {
  conversations: ConversationSummary[];
  pastTasks: TaskHistoryEntry[];
  readings: ReadingSnapshot[];
  currentConversationId: string;
  hidden: Record<string, number>;
  now: number;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();

  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const PAST_OUTCOME_LINE: Record<TaskHistoryEntry["outcome"], string> = {
  complete: "做完了",
  partial: "上次停在一半",
  stopped: "你让它停下了",
  error: "上次运行出错停下了",
};

/** 纯函数：记录 → 至多 3 张卡。只收有依据的线索，新的在前。 */
export function collectOpenThreads(input: OpenThreadInputs): OpenThread[] {
  const out: OpenThread[] = [];
  const known = new Map(input.conversations.map((c) => [c.id, c]));
  const claimed = new Set<string>();

  // 1. 会话清单：中断（有检查点）或页面交给了你。
  for (const c of input.conversations) {
    if (c.id === input.currentConversationId || c.state === "running") continue;
    const title = clip(c.title || "未命名会话", 40);

    if (c.checkpoint === "interrupted") {
      out.push({ id: `conv:${c.id}:${c.runId ?? ""}`, title, where: "任务中断了；回去后可点「继续原任务」", label: "回到这个任务", at: c.updatedAt, action: { kind: "conversation", conversationId: c.id } });
      claimed.add(c.id);
    } else if (c.state === "user") {
      out.push({ id: `user:${c.id}:${c.runId ?? ""}`, title, where: "页面交给了你，它在等你接着说", label: "回到这个对话", at: c.updatedAt, action: { kind: "conversation", conversationId: c.id } });
      claimed.add(c.id);
    }
  }

  // 2. 过往任务：每个会话只看最新一条；最新一条做完了就不算没做完。会话已删的不出（没有可回去的地方）。
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
    out.push({ id: `task:${t.id}`, title: clip(t.goal, 40), where, label: "回到这个任务", at: t.endedAt, action: { kind: "conversation", conversationId: t.conversationId } });
    claimed.add(t.conversationId);
  }

  // 3. 阅读记录：最后一次追问没答完（出错或被停下）。已转到侧栏的按会话处理，不在这里重复。
  for (const r of input.readings) {
    const last = r.turns.at(-1);

    if (!last || (last.state !== "error" && last.state !== "stopped") || r.transferredConversationId) continue;
    out.push({
      id: `read:${r.threadId}:${r.turns.length}`,
      title: clip(r.source.title || r.source.text, 40),
      where: `追问没答完：${clip(last.question, 30)}`,
      label: "打开上次页面",
      at: r.updatedAt,
      action: { kind: "tab", tabId: r.source.tabId, url: r.source.url },
    });
  }

  return out
    .filter((t) => !((input.hidden[t.id] ?? 0) > input.now))
    .sort((a, b) => b.at - a.at)
    .slice(0, OPEN_THREADS_MAX);
}

// ── 面板挂载：模块级状态，面板启动早期也能安全调用 refreshOpenThreads ──

export interface OpenThreadsDeps {
  /** 起点区（#starter）；卡片容器挂在它里面。 */
  root: HTMLElement;
  send: (msg: ClientMessage) => boolean;
  conversations: () => Iterable<ConversationSummary>;
  currentConversationId: () => string;
  /** 起点区此刻是否该出现（历史与草稿恢复完、会话为空）。 */
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

/** 宿主回的过往任务清单：是本模块发的请求才收下并返回 true，否则交还给记忆面板。 */
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

/** 读设置、隐藏表和阅读记录，按需补取过往任务，然后重画。设置关闭或起点区不该出现时清空。 */
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

    // 阅读记录跟着标签页走：标签页已关或已换页，就没有可回去的地方。
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
  // SAFETY: 只读字段做类型核对，核对通过才当成阅读记录。
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

  const cards = threads.map((thread) => {
    const card = document.createElement("article");
    card.className = "open-thread";
    card.dataset.threadId = thread.id;
    const text = document.createElement("div");
    text.className = "open-thread-text";
    const title = document.createElement("p");
    title.className = "open-thread-title";
    title.textContent = thread.title;
    title.title = thread.title;
    const where = document.createElement("p");
    where.className = "open-thread-where";
    where.textContent = thread.where;
    text.append(title, where);
    const go = document.createElement("button");
    go.type = "button";
    go.className = "open-thread-go";
    go.textContent = thread.label;
    go.onclick = () => void act(thread.action).catch(() => {
      where.textContent = "原页面已经找不到了";
      go.disabled = true;
    });
    const close = document.createElement("button");
    close.type = "button";
    close.className = "open-thread-close";
    close.textContent = "×";
    close.title = "7 天内不再显示这条";
    close.setAttribute("aria-label", `隐藏「${thread.title}」7 天`);
    close.onclick = () => { card.remove(); void hide(thread.id); };

    card.append(text, go, close);

    return card;
  });

  el.replaceChildren(head, ...cards);
  el.hidden = false;
}
