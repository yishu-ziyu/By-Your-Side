/**
 * T03 轻量任务条：不展开工具日志也能知道「目标是什么、正在做什么、用的是哪些材料、现在该谁行动」。
 *
 * 事实来源与诚实边界：
 * - 状态/目标/作用页/等待原因全部消费 T02 的只读 task_view 投影，不另造状态机；
 * - 材料入口只列面板实际发出的请求里的东西（选区/附件，发送时快照），作用页以 task_view.page 为准；
 * - 「发送中」不冒充「已接收」：只有 accepted 回执才把材料标为已随任务送入；
 * - 不显示百分比/剩余时间；接管与停止区分「请求中」与「已生效」，失败保留原状态可重试；
 * - 不新增任何动画：信息不依赖动效，prefers-reduced-motion 下完全等价。
 *
 * 纯逻辑（waitingCopy/buildTaskBarModel 等）与 DOM 装配同文件分层，便于无 DOM 单测。
 */
import type { TaskView } from "../../../shared/task-view.js";
import type { TaskReceipt } from "../../../shared/task-actions.js";
import type { Attachment, PageContext } from "../../../shared/protocol.js";
import { displayNameFor } from "../../../shared/cast.js";
import { formatDuration } from "./steps.js";

// ── 纯逻辑：文案与展示模型 ─────────────────────────────────────────

/** 阻塞/等待原因 → 人话。直接取 task_view 的真实 reason，不合并成含糊「思考中」。 */
export function waitingCopy(reason: string, detail: string | null): { text: string; detail: string | null } {
  const map: Record<string, string> = {
    human_control: "页面已交给你，Agent 暂停等待",
    restart_checkpoint: "上次会话中断，任务停在检查点",
    cancelled: "已按你的停止要求结束",
    failure_limit: "连续失败达到上限，已停住等你决定",
    unknown_with_baseline: "结果未知，等待核对",
    unknown_without_baseline: "结果未知，且没有可对比的基线",
    readback_required: "需要你读回确认结果",
    tool_failed: "上一步工具失败",
    runtime_error: "运行出错",
  };
  const detailMap: Record<string, string> = {
    host_restart: "伴随进程当时停止了",
    connection_lost: "与伴随进程的连接断了",
    manual_continuation: "按你的要求停在这里",
  };
  return {
    text: map[reason] ?? reason,
    detail: detail ? (detailMap[detail] ?? detail) : null,
  };
}

/** 状态层：一句话说清现在该谁行动。interrupted 必须区分有无真实恢复依据（与 T05 接续入口同口径）。 */
export function stateHeadline(state: TaskView["state"], resumable?: boolean): string {
  switch (state) {
    case "running": return "正在执行";
    case "paused": return "已暂停 · 页面归你";
    case "interrupted": return resumable === false ? "已中断 · 没有可恢复的依据" : "已中断 · 可继续";
    case "aborted": return "已停止";
    case "error": return "出错";
    case "idle": return "已结束";
    default: return "";
  }
}

export function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, Math.max(0, max - 1))}…` : t;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

export function pageLabelOf(info: { title?: string; url?: string }): string {
  const host = info.url ? hostOf(info.url) : "";
  const title = clip(info.title ?? "", 24);
  if (host && title) return `${title}（${host}）`;
  return host || title || "页面";
}

/** 当前活动行：lead 不带名字，worker 带名字；无活动时为 null。 */
export function activityText(view: TaskView): string | null {
  if (!view.active.length) return null;
  return view.active
    .map((a) => (a.member === "main" ? a.action : `${displayNameFor(a.member)}：${a.action}`))
    .join("；");
}

/** 与 background 的 CONTROL_TIMEOUT_MS 同值：超过这个时间仍未见到权威结果，就如实说「还没得到确认」。 */
export const CONTROL_PENDING_TIMEOUT_MS = 10_000;

export interface ControlState {
  takeover: { pending: boolean; since: number | null; failReason: string | null };
  stop: { pending: boolean; since: number | null; accepted: boolean; failReason: string | null };
}

export interface ControlNote {
  /** requested=请求中；unconfirmed=还没得到确认（可再试） */
  phase: "requested" | "unconfirmed";
  text: string;
  tone: "pending" | "fail";
  retry: "takeover" | "stop";
}

/** 控制请求的文案：区分「请求中」与「已生效」（已生效由状态层表达），失败不宣布已停手。 */
export function controlCopy(control: ControlState, state: TaskView["state"] | null, now: number): ControlNote | null {
  if (control.takeover.failReason) {
    return { phase: "unconfirmed", tone: "fail", retry: "takeover", text: `接管未生效：${clip(control.takeover.failReason, 40)}` };
  }
  // 已生效由状态层（state=paused + headline）表达，这里只讲请求还没落地。
  if (control.takeover.pending && state !== "paused" && state !== "idle" && state !== "aborted") {
    const waited = control.takeover.since != null ? now - control.takeover.since : 0;
    return waited > CONTROL_PENDING_TIMEOUT_MS
      ? { phase: "unconfirmed", tone: "fail", retry: "takeover", text: "接管请求还没得到确认，页面可能仍由 Agent 控制" }
      : { phase: "requested", tone: "pending", retry: "takeover", text: "已请求接管：正在让 Agent 停下手上动作…" };
  }
  if (control.stop.failReason) {
    return { phase: "unconfirmed", tone: "fail", retry: "stop", text: `停止未生效：${clip(control.stop.failReason, 40)}` };
  }
  if (control.stop.pending && state === "running") {
    const waited = control.stop.since != null ? now - control.stop.since : 0;
    if (waited > CONTROL_PENDING_TIMEOUT_MS) {
      return { phase: "unconfirmed", tone: "fail", retry: "stop", text: "停止请求还没得到确认，任务可能仍在执行" };
    }
    return {
      phase: "requested",
      tone: "pending",
      retry: "stop",
      text: control.stop.accepted ? "停止已受理：正在停下当前任务…" : "已请求停止：等 Agent 收手…",
    };
  }
  return null;
}

export interface DraftMaterials {
  page: { tabId: number; title: string; url: string } | null;
  selection: string | null;
  attachments: Array<{ id: string; name: string }>;
}

export interface SentRequestMaterials {
  requestId: string;
  action: "start" | "steer";
  status: "sending" | "accepted" | "rejected" | "failed" | "unknown";
  runId: string | null;
  page: PageContext | null;
  selection: string | null;
  attachments: Array<{ id: string; name: string }>;
  note: string | null;
}

export interface TaskMaterialItem {
  key: string;
  kind: "page" | "selection" | "attachment";
  label: string;
}

export interface TaskMaterialSet {
  runId: string | null;
  items: TaskMaterialItem[];
}

export interface MaterialRow {
  key: string;
  kind: TaskMaterialItem["kind"];
  kindLabel: string;
  label: string;
  removable: boolean;
}

export interface TaskBarModel {
  visible: boolean;
  state: TaskView["state"] | "draft";
  goal: string | null;
  goalTitle: string | null;
  headline: string;
  activity: string | null;
  /** 距上次真实动作的时长（长时间无进展时的诚实信号）；无依据为 null。 */
  idleAge: string | null;
  waiting: { text: string; detail: string | null } | null;
  page: { label: string; mismatch: boolean } | null;
  materials: {
    rows: MaterialRow[];
    head: string;
    note: string | null;
    /** 发送中/未接收等状态行，已随任务送入时为 null。 */
    status: string | null;
  } | null;
  control: ControlNote | null;
}

export interface TaskBarInputs {
  view: TaskView | null;
  draft: DraftMaterials | null;
  /** 草稿里已写但还没发出的正文：有正文时才为一行「页面」材料（发送时后台一定会带上页面上下文）。 */
  draftHasText?: boolean;
  /** 已发出但还没有 accepted/终态回执的请求（一般 0–1 条）。 */
  sending: SentRequestMaterials[];
  /** 当前 run 已确认送入的材料。 */
  taskMaterials: TaskMaterialSet | null;
  control: ControlState;
  pageLabel: string | null;
  /** 当前活动标签页；与 task_view.page 不一致时如实提示（A03-03）。 */
  activeTabId: number | null;
  pageTabId: number | null;
  now: number;
}

const KIND_LABEL: Record<TaskMaterialItem["kind"], string> = { page: "页面", selection: "选区", attachment: "附件" };

function draftRows(draft: DraftMaterials): MaterialRow[] {
  const rows: MaterialRow[] = [];
  if (draft.page) rows.push({ key: "draft:page", kind: "page", kindLabel: KIND_LABEL.page, label: pageLabelOf(draft.page), removable: false });
  if (draft.selection) rows.push({ key: "draft:sel", kind: "selection", kindLabel: KIND_LABEL.selection, label: `「${clip(draft.selection, 20)}」`, removable: true });
  for (const att of draft.attachments) rows.push({ key: `draft:att:${att.id}`, kind: "attachment", kindLabel: KIND_LABEL.attachment, label: clip(att.name, 18), removable: true });
  return rows;
}

/** 已发出、还没确认接收的材料行（发送中/接收未知）。 */
function sentRows(entry: SentRequestMaterials): MaterialRow[] {
  const rows: MaterialRow[] = [];
  if (entry.page) rows.push({ key: `sent:${entry.requestId}:page`, kind: "page", kindLabel: KIND_LABEL.page, label: pageLabelOf({ title: entry.page.title, url: entry.page.url }), removable: false });
  if (entry.selection) rows.push({ key: `sent:${entry.requestId}:sel`, kind: "selection", kindLabel: KIND_LABEL.selection, label: `「${clip(entry.selection, 20)}」`, removable: false });
  for (const att of entry.attachments) rows.push({ key: `sent:${entry.requestId}:att:${att.id}`, kind: "attachment", kindLabel: KIND_LABEL.attachment, label: clip(att.name, 18), removable: false });
  return rows;
}

function taskRows(set: TaskMaterialSet, resolvedPageLabel: string | null): MaterialRow[] {
  const rows: MaterialRow[] = [];
  for (const item of set.items) {
    if (item.kind === "page") {
      rows.push({ key: item.key, kind: "page", kindLabel: KIND_LABEL.page, label: resolvedPageLabel ?? item.label, removable: false });
    } else {
      rows.push({ key: item.key, kind: item.kind, kindLabel: KIND_LABEL[item.kind], label: item.label, removable: false });
    }
  }
  if (!rows.some((r) => r.kind === "page") && resolvedPageLabel) {
    rows.unshift({ key: "task:page", kind: "page", kindLabel: KIND_LABEL.page, label: resolvedPageLabel, removable: false });
  }
  return rows;
}

/** 组装展示模型：纯函数，同一输入必得同一输出（可固定时钟单测）。 */
export function buildTaskBarModel(input: TaskBarInputs): TaskBarModel {
  const { view, draft, sending, taskMaterials, control, now } = input;
  const unresolved = sending.filter((s) => s.status === "sending" || s.status === "unknown");
  const failedSend = sending.find((s) => s.status === "rejected" || s.status === "failed");
  const pageTabId = input.pageTabId ?? view?.page?.tabId ?? null;
  const page = pageTabId != null
    ? {
        label: input.pageLabel ?? `标签页 ${pageTabId}`,
        mismatch: input.activeTabId != null && input.activeTabId !== pageTabId,
      }
    : null;

  const controlNote = controlCopy(control, view?.state ?? null, now);

  // ── 材料区：已确认送入的任务材料 + 这一条还没确认接收的材料；草稿只在没有前两者时出现 ──
  let materials: TaskBarModel["materials"] = null;
  const pendingEntry = unresolved.length ? unresolved[unresolved.length - 1]! : null;
  const confirmedRows = taskMaterials ? taskRows(taskMaterials, view?.page ? page?.label ?? null : null) : [];
  const pendingRows = pendingEntry ? sentRows(pendingEntry) : [];
  if (taskMaterials || pendingEntry || confirmedRows.length || pendingRows.length) {
    const rows = [...confirmedRows, ...pendingRows];
    // 普通发送的页面材料要等页面快照回来才认识；这段时间也必须先有「发送中」，
    // 不能因为还没行就整块不显示（本地反馈不能靠异步查页面来决定有没有）。
    const head = confirmedRows.length ? `已随任务送入 · ${confirmedRows.length} 项` : rows.length ? `材料 · ${rows.length} 项` : "材料";
    materials = {
      rows,
      head: pendingRows.length && confirmedRows.length ? `${head}（另有 ${pendingRows.length} 项材料待确认）` : head,
      status: pendingEntry ? (pendingEntry.status === "unknown" ? "这一条接收状态未知，等待回执核对" : "发送中，尚未确认接收") : null,
      note: null,
    };
  }
  // 草稿行只在既没有已确认材料、也没有发送中请求时接管材料区；
  // 任务运行中新起草的材料由输入区的瓷贴/引用条负责移除，任务条优先讲正在用的材料。
  if (!materials && draft) {
    const onlyPage = !draft.selection && !draft.attachments.length && !input.draftHasText;
    const rows = onlyPage ? [] : draftRows(draft);
    if (rows.length) {
      materials = { rows, head: `待发送材料 · ${rows.length} 项`, status: null, note: "发送前可移除" };
    }
  }
  if (!materials && failedSend) {
    materials = { rows: [], head: "材料", status: `未接收：${clip(failedSend.note ?? "", 40)}`, note: null };
  }

  // ── 可见性：没有任何可说的事就整条隐藏 ──
  const hasViewStory = !!view && view.state !== "none" && (!!view.goal || view.state !== "idle");
  const visible = !!materials || hasViewStory || !!controlNote;
  if (!visible) {
    return { visible: false, state: "draft", goal: null, goalTitle: null, headline: "", activity: null, idleAge: null, waiting: null, page: null, materials: null, control: null };
  }

  const goal = view?.goal ?? null;
  const headline = view ? stateHeadline(view.state, view.resumable) : "新任务";
  let activity: string | null = null;
  if (view?.state === "running") {
    activity = activityText(view);
    if (activity && view.active.length) {
      const since = view.active[view.active.length - 1]!.since;
      if (Number.isFinite(since) && now >= since) activity = `${activity} · ${formatDuration(now - since)}`;
    }
    if (!activity && view.lastAction && Number.isFinite(view.lastAction.at) && now >= view.lastAction.at) {
      activity = view.lastAction.failed ? "上一步失败" : null;
    }
  }
  // 长时间没动作才提示：短任务不该被多余数字包住（依据是真实 lastAction.at）。
  let idleAge: string | null = null;
  if (view?.state === "running" && !view.active.length && view.lastAction && Number.isFinite(view.lastAction.at) && now - view.lastAction.at >= 15_000) {
    idleAge = `距上次动作 ${formatDuration(now - view.lastAction.at)}`;
  }
  const waiting = view?.waiting ? waitingCopy(view.waiting.reason, view.waiting.detail) : null;

  return {
    visible: true,
    state: view?.state ?? "draft",
    goal: goal ? clip(goal, 48) : null,
    goalTitle: goal && goal.length > 48 ? goal : null,
    headline,
    activity,
    idleAge,
    waiting,
    page,
    materials,
    control: controlNote,
  };
}

// ── DOM 装配 ───────────────────────────────────────────────────────

export interface TaskBarOptions {
  /** 挂载点；TaskBar 拥有其内容（replaceChildren）。 */
  root: HTMLElement;
  resolvePage(tabId: number): Promise<{ title?: string; url?: string } | null>;
  getActiveTabId(): Promise<number | null>;
  removeDraftAttachment(id: string): void;
  removeDraftSelection(): void;
  /** 控制失败后的重试入口（复用真实控制按钮，不是新权限）。 */
  onRetryControl?(action: "takeover" | "stop"): void;
  /** 当前选中的会话：不属于它的视图不得改写任务条（切会话/旧 run 重放都不能串）。 */
  currentConversationId?(): string;
  now?(): number;
  /** 文档工厂，单测注入假 DOM；缺省用全局 document。 */
  doc?: Document;
}

/**
 * 任务条组件。main.ts 只调用 updateView/setDraft/noteRequestSent/noteReceipt/noteControl*；
 * 渲染幂等：同一状态重复渲染不产生重复节点或重复控件。
 */
export class TaskBar {
  private view: TaskView | null = null;
  private draft: DraftMaterials | null = null;
  private readonly sent = new Map<string, SentRequestMaterials>();
  private taskMaterials: TaskMaterialSet | null = null;
  private control: ControlState = { takeover: { pending: false, since: null, failReason: null }, stop: { pending: false, since: null, accepted: false, failReason: null } };
  private draftHasText = false;
  private readonly pageCache = new Map<number, { label: string | null; at: number }>();
  private activeTab: { id: number | null; at: number } = { id: null, at: 0 };
  private model: TaskBarModel | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private readonly el: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly waitingEl: HTMLElement;
  private readonly pageEl: HTMLElement;
  private readonly materialsEl: HTMLElement;
  private readonly controlEl: HTMLElement;
  private readonly goalEl: HTMLElement;
  private readonly headEl: HTMLElement;
  private readonly revisionsEl: HTMLElement;
  private readonly now: () => number;
  private readonly doc: Document;
  private disposed = false;

  constructor(private readonly opts: TaskBarOptions) {
    this.now = opts.now ?? Date.now;
    const doc = opts.doc ?? (typeof document !== "undefined" ? document : undefined as unknown as Document);
    if (!doc) throw new Error("TaskBar 需要 document（或注入 doc）");
    this.doc = doc;
    this.el = doc.createElement("section");
    this.el.className = "task-bar";
    this.el.setAttribute("aria-label", "当前任务");
    this.headEl = doc.createElement("div");
    this.headEl.className = "tb-head";
    const dot = doc.createElement("span");
    dot.className = "tb-dot";
    this.goalEl = doc.createElement("span");
    this.goalEl.className = "tb-goal";
    this.revisionsEl = doc.createElement("span");
    this.revisionsEl.className = "tb-revisions";
    this.headEl.append(dot, this.goalEl, this.revisionsEl);
    this.statusEl = doc.createElement("p");
    this.statusEl.className = "tb-status";
    this.statusEl.setAttribute("role", "status");
    this.statusEl.setAttribute("aria-live", "polite");
    this.waitingEl = doc.createElement("p");
    this.waitingEl.className = "tb-waiting";
    this.pageEl = doc.createElement("p");
    this.pageEl.className = "tb-page";
    this.materialsEl = doc.createElement("div");
    this.materialsEl.className = "tb-materials";
    this.controlEl = doc.createElement("p");
    this.controlEl.className = "tb-control";
    this.el.append(this.headEl, this.statusEl, this.waitingEl, this.pageEl, this.materialsEl, this.controlEl);
    this.el.addEventListener("click", (event) => this.onClick(event));
    opts.root.replaceChildren(this.el);
    this.render();
  }

  dispose(): void {
    this.disposed = true;
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  /** task_view 下行。同一 run 内重复/重放同一视图幂等。 */
  updateView(view: TaskView): void {
    if (this.disposed) return;
    // 视图自带任务身份：会话对不上（切会话、历史重放、旧 run）一律不显示。
    const current = this.opts.currentConversationId?.();
    if (current !== undefined && view.conversationId !== current) return;
    const previous = this.view;
    this.view = view;
    // 控制请求的收束：状态权威变化后不再显示「请求中」
    if (view.state === "paused") this.control.takeover.pending = false;
    if (view.state !== "running") this.control.stop.pending = false;
    if (view.state === "paused" || view.state === "running") {
      this.control.takeover.failReason = null;
      this.control.stop.failReason = null;
    }
    // 换 run / 任务归零：旧 run 的材料不再展示
    if (this.taskMaterials) {
      const staleRun = this.taskMaterials.runId != null && view.runId != null && this.taskMaterials.runId !== view.runId;
      if (view.state === "none" || staleRun) this.taskMaterials = null;
    }
    if (previous && previous.conversationId !== view.conversationId) this.taskMaterials = null;
    this.render();
  }

  /** 切会话 / 重置渲染：全部清空。 */
  reset(): void {
    this.view = null;
    this.draft = null;
    this.draftHasText = false;
    this.sent.clear();
    this.taskMaterials = null;
    this.pageCache.clear();
    this.control = { takeover: { pending: false, since: null, failReason: null }, stop: { pending: false, since: null, accepted: false, failReason: null } };
    this.render();
  }

  setDraft(draft: DraftMaterials | null, hasText = false): void {
    if (this.disposed) return;
    this.draft = draft;
    this.draftHasText = hasText;
    this.render();
  }

  /** 发送成功后立刻调用：快照当时真正送出的材料（这是界面上材料的唯一来源之一）。 */
  noteRequestSent(payload: {
    requestId: string;
    action: "start" | "steer";
    context?: PageContext | null;
    attachments?: Attachment[] | null;
  }): void {
    if (this.disposed) return;
    this.sent.set(payload.requestId, {
      requestId: payload.requestId,
      action: payload.action,
      status: "sending",
      runId: null,
      page: payload.context ?? null,
      selection: payload.context?.selection?.text ?? null,
      attachments: (payload.attachments ?? []).map((a) => ({ id: a.id, name: a.name })),
      note: null,
    });
    this.render();
  }

  /** 任务回执：accepted 才把材料升级为「已随任务送入」。 */
  noteReceipt(receipt: TaskReceipt): void {
    if (this.disposed) return;
    const entry = this.sent.get(receipt.requestId);
    if (!entry) return;
    if (receipt.status === "accepted" || receipt.status === "applied") {
      entry.status = "accepted";
      entry.runId = receipt.runId;
      this.absorbMaterials(entry);
    } else if (receipt.status === "rejected" || receipt.status === "failed") {
      entry.status = receipt.status;
      entry.note = receipt.message;
    } else if (receipt.status === "unknown") {
      entry.status = "unknown";
      entry.note = receipt.message;
    } else {
      return; // queued 等中间态不改口径
    }
    this.render();
  }

  noteControlRequested(action: "takeover" | "stop"): void {
    if (this.disposed) return;
    const at = this.now();
    if (action === "takeover") this.control.takeover = { pending: true, since: at, failReason: null };
    else this.control.stop = { pending: true, since: at, accepted: false, failReason: null };
    this.render();
  }

  noteControlResult(action: "takeover" | "stop", ok: boolean, reason?: string): void {
    if (this.disposed) return;
    if (action === "takeover") {
      // 生效与否最终由 task_view 状态层确认；这里只收掉「请求中」或如实保留失败原因。
      this.control.takeover = { pending: false, since: null, failReason: ok ? null : reason ?? null };
    } else {
      this.control.stop = { pending: false, since: null, accepted: ok, failReason: ok ? null : reason ?? null };
    }
    this.render();
  }

  /** 停止请求已被受理但任务还没停下：状态层仍是 running，不要提前宣布停手。 */
  noteStopAccepted(): void {
    if (this.disposed) return;
    if (!this.control.stop.pending) return;
    this.control.stop = { ...this.control.stop, accepted: true, failReason: null };
    this.render();
  }

  /** 发送时页面材料要按真正上行的那一页补全（后台发送前会附当前页面上下文）。 */
  noteRequestPage(requestId: string, page: { tabId: number; title?: string; url?: string }): void {
    if (this.disposed) return;
    const entry = this.sent.get(requestId);
    if (!entry || entry.page) return;
    entry.page = { tabId: page.tabId, title: page.title ?? "", url: page.url ?? "" };
    this.render();
  }

  /** 标签页切换/关闭后调用：重解析作用页身份与当前活动页。 */
  noteTabsChanged(): void {
    if (this.disposed) return;
    this.activeTab = { id: null, at: 0 };
    const tabId = this.view?.page?.tabId;
    if (tabId != null) this.pageCache.delete(tabId);
    this.render();
  }

  getModel(): TaskBarModel | null {
    return this.model;
  }

  private absorbMaterials(entry: SentRequestMaterials): void {
    const items: TaskMaterialItem[] = [];
    if (entry.action === "start" || !this.taskMaterials) {
      if (entry.page) items.push({ key: "task:page", kind: "page", label: pageLabelOf({ title: entry.page.title, url: entry.page.url }) });
      if (entry.selection) items.push({ key: `task:sel:${clip(entry.selection, 24)}`, kind: "selection", label: `「${clip(entry.selection, 20)}」` });
      for (const att of entry.attachments) items.push({ key: `task:att:${att.id}`, kind: "attachment", label: clip(att.name, 18) });
      this.taskMaterials = { runId: entry.runId, items };
      return;
    }
    // steer：并入当前 run 的材料（页面按最新，选区/附件去重追加）
    const merged = [...this.taskMaterials.items];
    if (entry.page) {
      const index = merged.findIndex((i) => i.kind === "page");
      const label = pageLabelOf({ title: entry.page!.title, url: entry.page!.url });
      if (index >= 0) merged[index] = { key: "task:page", kind: "page", label };
      else merged.unshift({ key: "task:page", kind: "page", label });
    }
    if (entry.selection && !merged.some((i) => i.kind === "selection" && i.label === `「${clip(entry.selection!, 20)}」`)) {
      merged.push({ key: `task:sel:${clip(entry.selection, 24)}`, kind: "selection", label: `「${clip(entry.selection, 20)}」` });
    }
    for (const att of entry.attachments) {
      if (!merged.some((i) => i.key === `task:att:${att.id}`)) merged.push({ key: `task:att:${att.id}`, kind: "attachment", label: clip(att.name, 18) });
    }
    this.taskMaterials = { runId: this.taskMaterials.runId ?? entry.runId, items: merged };
  }

  private onClick(event: Event): void {
    const target = event.target as Element | null;
    if (!target || typeof target.closest !== "function") return;
    const remove = target.closest("button[data-remove-key]") as HTMLButtonElement | null;
    if (remove) {
      const key = remove.getAttribute("data-remove-key") ?? "";
      if (key === "draft:sel") this.opts.removeDraftSelection();
      else if (key.startsWith("draft:att:")) this.opts.removeDraftAttachment(key.slice("draft:att:".length));
      return;
    }
    const retry = target.closest("button[data-retry-control]") as HTMLButtonElement | null;
    if (retry) {
      const action = retry.getAttribute("data-retry-control") === "stop" ? "stop" : "takeover";
      this.opts.onRetryControl?.(action);
    }
  }

  private resolvePages(): void {
    const tabId = this.view?.page?.tabId ?? null;
    if (tabId != null) {
      const cached = this.pageCache.get(tabId);
      const fresh = cached && this.now() - cached.at < 30_000;
      if (cached && fresh && cached.label != null) return;
      void this.opts.resolvePage(tabId).then((info) => {
        if (this.disposed) return;
        const label = info ? pageLabelOf(info) : null;
        const before = this.pageCache.get(tabId)?.label ?? undefined;
        this.pageCache.set(tabId, { label, at: this.now() });
        if (before !== label) this.render();
      }).catch(() => {
        if (this.disposed) return;
        this.pageCache.set(tabId, { label: null, at: this.now() });
      });
    }
    if (tabId != null && this.now() - this.activeTab.at > 5_000) {
      void this.opts.getActiveTabId().then((id) => {
        if (this.disposed) return;
        this.activeTab = { id, at: this.now() };
        this.render();
      }).catch(() => {});
    }
  }

  private render(): void {
    if (this.disposed) return;
    const tabId = this.view?.page?.tabId ?? null;
    const model = buildTaskBarModel({
      view: this.view,
      draft: this.draft,
      sending: [...this.sent.values()],
      taskMaterials: this.taskMaterials,
      control: this.control,
      draftHasText: this.draftHasText,
      pageLabel: tabId != null ? this.pageCache.get(tabId)?.label ?? null : null,
      activeTabId: this.now() - this.activeTab.at < 30_000 ? this.activeTab.id : null,
      pageTabId: tabId,
      now: this.now(),
    });
    const changed = !this.model || !shallowEqualModel(this.model, model);
    this.model = model;
    this.el.hidden = !model.visible;
    if (!model.visible) {
      // 不可见就清空：不留旧任务文本给屏幕阅读器，也不让测试/检查读到过期事实。
      this.goalEl.textContent = "";
      this.revisionsEl.textContent = "";
      this.statusEl.textContent = "";
      this.waitingEl.hidden = true;
      this.waitingEl.textContent = "";
      this.pageEl.hidden = true;
      this.pageEl.textContent = "";
      this.controlEl.hidden = true;
      this.controlEl.replaceChildren();
      this.materialsEl.hidden = true;
      this.materialsEl.replaceChildren();
      this.el.removeAttribute("data-state");
      this.stopTick();
      return;
    }
    this.el.setAttribute("data-state", model.state);
    this.goalEl.textContent = model.goal ?? "（目标未记录）";
    this.goalEl.title = model.goalTitle ?? model.goal ?? "";
    this.revisionsEl.textContent = this.view?.revisions.length ? `+${this.view.revisions.length} 修订` : "";
    this.revisionsEl.title = this.view?.revisions.length ? this.view.revisions.join("\n") : "";
    const statusBits = [model.headline, model.activity, model.idleAge].filter(Boolean);
    this.statusEl.textContent = statusBits.join(" · ") || "准备中";
    this.waitingEl.hidden = !model.waiting;
    this.waitingEl.textContent = model.waiting ? `等待：${model.waiting.text}${model.waiting.detail ? `（${model.waiting.detail}）` : ""}` : "";
    this.pageEl.hidden = !model.page;
    this.pageEl.textContent = model.page ? `作用于：${model.page.label}${model.page.mismatch ? "（你现在看的是别的页，任务仍作用于上面这页）" : ""}` : "";
    this.renderMaterials(model.materials);
    this.renderControl(model.control);
    if (changed) this.resolvePages();
    this.scheduleTick();
  }

  private renderControl(control: ControlNote | null): void {
    if (!control) {
      this.controlEl.hidden = true;
      this.controlEl.replaceChildren();
      return;
    }
    const doc = this.doc;
    const label = doc.createElement("span");
    label.className = "tb-control-text";
    label.textContent = control.text;
    this.controlEl.replaceChildren(label);
    if (control.phase === "unconfirmed") {
      const retry = doc.createElement("button");
      retry.type = "button";
      retry.className = "tb-control-retry";
      retry.textContent = "再试";
      retry.setAttribute("data-retry-control", control.retry);
      retry.setAttribute("aria-label", `${control.retry === "stop" ? "停止" : "接管"}再试一次`);
      this.controlEl.appendChild(retry);
    }
    this.controlEl.hidden = false;
    this.controlEl.setAttribute("data-phase", control.phase);
    this.controlEl.setAttribute("data-tone", control.tone);
  }

  private renderMaterials(materials: TaskBarModel["materials"]): void {
    if (!materials || (!materials.rows.length && !materials.status)) {
      this.materialsEl.hidden = true;
      this.materialsEl.replaceChildren();
      return;
    }
    this.materialsEl.hidden = false;
    const doc = this.doc;
    const head = doc.createElement("div");
    head.className = "tb-mat-head";
    head.textContent = materials.head;
    const list = doc.createElement("ul");
    list.className = "tb-mat-list";
    for (const row of materials.rows) {
      const li = doc.createElement("li");
      li.className = "tb-mat";
      const kind = doc.createElement("span");
      kind.className = "tb-mat-kind";
      kind.textContent = row.kindLabel;
      const label = doc.createElement("span");
      label.className = "tb-mat-label";
      label.textContent = row.label;
      li.append(kind, label);
      if (row.removable) {
        const remove = doc.createElement("button");
        remove.type = "button";
        remove.className = "tb-remove";
        remove.textContent = "移除";
        remove.title = "发送前移除这项材料";
        remove.setAttribute("aria-label", `移除${row.kindLabel}：${row.label}`);
        remove.setAttribute("data-remove-key", row.key);
        li.appendChild(remove);
      }
      list.appendChild(li);
    }
    this.materialsEl.replaceChildren(head, list);
    if (materials.status) {
      const status = doc.createElement("div");
      status.className = "tb-mat-status";
      status.textContent = materials.status;
      this.materialsEl.appendChild(status);
    }
    if (materials.note) {
      const note = doc.createElement("div");
      note.className = "tb-mat-note";
      note.textContent = materials.note;
      this.materialsEl.appendChild(note);
    }
  }

  private scheduleTick(): void {
    const needTick = this.model?.state === "running";
    if (needTick && this.tickTimer === null) {
      this.tickTimer = setInterval(() => this.render(), 1_000);
    } else if (!needTick && this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private stopTick(): void {
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }
}

function shallowEqualModel(a: TaskBarModel, b: TaskBarModel): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
