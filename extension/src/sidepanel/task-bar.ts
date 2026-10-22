/**
 * 轻量任务条：不展开工具日志也能知道「目标是什么、正在做什么、用的是哪些材料、现在该谁行动」。
 *
 * 事实来源与诚实边界：
 * - 状态/目标/作用页/等待原因全部消费只读的 task_view 投影，不另造状态机；
 * - 已接受材料由宿主 task_view 恢复；发送中与旧协议沿用实际发出的请求快照，作用页以 task_view.page 为准；
 * - 「发送中」不冒充「已接收」：只有 accepted 回执才把材料标为已随任务送入；
 * - 不显示百分比/剩余时间；接管与停止区分「请求中」与「已生效」，失败保留原状态可重试；
 * - 不新增任何动画：信息不依赖动效，prefers-reduced-motion 下完全等价。
 *
 * 纯逻辑（waitingCopy/buildTaskBarModel 等）与 DOM 装配同文件分层。
 */
import type { TaskView } from "../../../shared/task-view.js";
import type { TaskReceipt } from "../../../shared/task-actions.js";
import type { Attachment, PageContext } from "../../../shared/protocol.js";
import { displayNameFor } from "../../../shared/cast.js";
import { formatDuration } from "./steps.js";

// ── 纯逻辑：文案与展示模型 ─────────────────────────────────────────

/** 阻塞/等待原因 → 人话。直接取 task_view 的真实 reason，不合并成含糊「思考中」。 */
function waitingCopy(reason: string, detail: string | null): { text: string; detail: string | null } {
  const map: Record<string, string> = {
    human_control: "页面现在归你，助手在等你交还",
    restart_checkpoint: "上次会话断开了，任务停在中途",
    cancelled: "你中止了任务",
    failure_limit: "连续几步没做成，助手在等你决定",
    unknown_with_baseline: "有 1 步结果未知，助手要先核验",
    unknown_without_baseline: "有 1 步结果未知，助手没有改动前的记录，不会自己重做",
    readback_required: "助手还要核验页面",
    tool_failed: "上一步没做成",
    runtime_error: "出错了",
  };

  const detailMap: Record<string, string> = {
    host_restart: "扩展后台重启了",
    connection_lost: "扩展后台断开了",
    manual_continuation: "你中止了任务",
  };

  return {
    text: map[reason] ?? reason,
    detail: detail ? (detailMap[detail] ?? detail) : null,
  };
}

/** 状态层：一句话说清现在该谁行动。interrupted 必须区分有无真实恢复依据（与接续入口同口径）。 */
export function stateHeadline(state: TaskView["state"], resumable?: boolean): string {
  switch (state) {
    case "running": return "正在做";
    case "paused": return "已暂停 · 页面归你";
    case "interrupted": return resumable === false ? "已中断 · 没有可恢复的依据" : "已中断 · 可继续";
    case "aborted": return "已中止";
    case "error": return "出错";
    case "idle": return "本轮已结束";
    default: return "";
  }
}

function clip(text: string, max: number): string {
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

/** 任务条摘要行上的网站名：只要主机名，标题留给展开后的「作用于」。 */
function pageHostOf(info: { url?: string }): string | null {
  return info.url ? hostOf(info.url) || null : null;
}

function pageLabelOf(info: { title?: string; url?: string }): string {
  const host = info.url ? hostOf(info.url) : "";
  const title = clip(info.title ?? "", 24);

  if (host && title) return `${title}（${host}）`;

  return host || title || "页面";
}

/** 当前活动行：lead 不带名字，worker 带名字；无活动时为 null。 */
function activityText(view: TaskView): string | null {
  if (!view.active.length) return null;

  return view.active
    .map((a) => (a.member === "main" ? a.action : `${displayNameFor(a.member)}：${a.action}`))
    .join("；");
}

/** 与 background 的 CONTROL_TIMEOUT_MS 同值：超过这个时间仍未见到权威结果，就如实说「还没得到确认」。 */
const CONTROL_PENDING_TIMEOUT_MS = 10_000;

interface ControlState {
  takeover: { pending: boolean; since: number | null; failReason: string | null };
  stop: { pending: boolean; since: number | null; accepted: boolean; failReason: string | null };
}

interface ControlNote {
  /** requested=请求中；unconfirmed=还没得到确认（可再试） */
  phase: "requested" | "unconfirmed";
  text: string;
  tone: "pending" | "fail";
  retry: "takeover" | "stop";
}

/** 控制请求的文案：区分「请求中」与「已生效」（已生效由状态层表达），失败不宣布已停手。 */
function controlCopy(control: ControlState, state: TaskView["state"] | null, now: number): ControlNote | null {
  if (control.takeover.failReason) {
    return { phase: "unconfirmed", tone: "fail", retry: "takeover", text: `接管未生效：${clip(control.takeover.failReason, 40)}` };
  }

  // 已生效由状态层（state=paused + headline）表达，这里只讲请求还没落地。
  if (control.takeover.pending && state !== "paused" && state !== "idle" && state !== "aborted") {
    const waited = control.takeover.since != null ? now - control.takeover.since : 0;

    return waited > CONTROL_PENDING_TIMEOUT_MS
      ? { phase: "unconfirmed", tone: "fail", retry: "takeover", text: "接管还没生效。助手可能还在操作页面。" }
      : { phase: "requested", tone: "pending", retry: "takeover", text: "正在接管，等助手暂停…" };
  }

  if (control.stop.failReason) {
    return { phase: "unconfirmed", tone: "fail", retry: "stop", text: `中止没有生效：${clip(control.stop.failReason, 40)}` };
  }

  if (control.stop.pending && state === "running") {
    const waited = control.stop.since != null ? now - control.stop.since : 0;

    if (waited > CONTROL_PENDING_TIMEOUT_MS) {
      return { phase: "unconfirmed", tone: "fail", retry: "stop", text: "还没确认中止。任务可能还在运行。" };
    }

    return {
      phase: "requested",
      tone: "pending",
      retry: "stop",
      text: "正在中止任务…",
    };
  }

  return null;
}

interface SentRequestMaterials {
  requestId: string;
  action: "start" | "steer";
  status: "sending" | "accepted" | "rejected" | "failed" | "unknown";
  /** 发出的时刻：回执通常不到一秒就回来，这段时间不亮「正在发送」，免得材料区闪一下就没。 */
  sentAt: number;
  runId: string | null;
  page: PageContext | null;
  selection: string | null;
  attachments: Array<{ id: string; name: string }>;
  note: string | null;
}

interface TaskMaterialItem {
  key: string;
  kind: "page" | "selection" | "attachment";
  label: string;
}

interface TaskMaterialSet {
  runId: string | null;
  items: TaskMaterialItem[];
}

interface MaterialRow {
  key: string;
  kind: TaskMaterialItem["kind"];
  kindLabel: string;
  label: string;
}

interface TaskBarModel {
  visible: boolean;
  state: TaskView["state"] | "draft";
  /** 已结束的任务：open = 还差一些、接着说就行；done = 做完了。进行中和纯聊天为 null。 */
  outcome?: "open" | "done" | null;
  goal: string | null;
  goalTitle: string | null;
  headline: string;
  activity: string | null;
  /** 距上次真实动作的时长（长时间无进展时的诚实信号）；无依据为 null。 */
  idleAge: string | null;
  waiting: { text: string; detail: string | null } | null;
  page: { label: string; host: string | null } | null;
  materials: {
    rows: MaterialRow[];
    head: string;
    /** 发送中/未接收等状态行，已随任务送入时为 null。 */
    status: string | null;
  } | null;
  control: ControlNote | null;
}

interface TaskBarInputs {
  view: TaskView | null;
  /** 已发出但还没有 accepted/终态回执的请求（一般 0–1 条）。 */
  sending: SentRequestMaterials[];
  /** 当前 run 已确认送入的材料。 */
  taskMaterials: TaskMaterialSet | null;
  control: ControlState;
  pageLabel: string | null;
  /** 任务页的主机名，摘要行只显示它；还没查到为 null。 */
  pageHost?: string | null;
  pageTabId: number | null;
  now: number;
}

const KIND_LABEL: Record<TaskMaterialItem["kind"], string> = { page: "页面", selection: "选区", attachment: "附件" };

/** 已发出、还没确认接收的材料行（发送中/接收未知）。 */
function sentRows(entry: SentRequestMaterials): MaterialRow[] {
  const rows: MaterialRow[] = [];

  if (entry.page) rows.push({ key: `sent:${entry.requestId}:page`, kind: "page", kindLabel: KIND_LABEL.page, label: pageLabelOf({ title: entry.page.title, url: entry.page.url }) });

  if (entry.selection) rows.push({ key: `sent:${entry.requestId}:sel`, kind: "selection", kindLabel: KIND_LABEL.selection, label: `「${clip(entry.selection, 20)}」` });

  for (const att of entry.attachments) rows.push({ key: `sent:${entry.requestId}:att:${att.id}`, kind: "attachment", kindLabel: KIND_LABEL.attachment, label: clip(att.name, 18) });

  return rows;
}

function taskRows(set: TaskMaterialSet, resolvedPageLabel: string | null): MaterialRow[] {
  const rows: MaterialRow[] = [];

  for (const item of set.items) {
    if (item.kind === "page") {
      rows.push({ key: item.key, kind: "page", kindLabel: KIND_LABEL.page, label: item.key === 'task:page' ? resolvedPageLabel ?? item.label : item.label });
    } else {
      rows.push({ key: item.key, kind: item.kind, kindLabel: KIND_LABEL[item.kind], label: item.label });
    }
  }

  if (!rows.some((r) => r.kind === "page") && resolvedPageLabel) {
    rows.unshift({ key: "task:page", kind: "page", kindLabel: KIND_LABEL.page, label: resolvedPageLabel });
  }

  return rows;
}

/** 发出后这么久还没回执，才在材料区写「正在发送」。用户的话已经立刻出现在对话里，回执快的时候不需要第二处反馈。 */
const SENDING_QUIET_MS = 800;

/** 组装展示模型：纯函数，同一输入必得同一输出。 */
function buildTaskBarModel(input: TaskBarInputs): TaskBarModel {
  const { view, sending, taskMaterials, control, now } = input;
  const newest = sending.at(-1);
  // 刚发出的这一条还在安静期：连更早那条“没确认收到”也先不讲，免得先亮旧的那条、0.8 秒后又换成这一条。
  const quiet = newest?.status === "sending" && now - newest.sentAt < SENDING_QUIET_MS;
  const unresolved = quiet ? [] : sending.filter((s) => s.status === "unknown" || (s.status === "sending" && now - s.sentAt >= SENDING_QUIET_MS));
  const pageTabId = input.pageTabId ?? view?.page?.tabId ?? null;

  const page = pageTabId != null
    ? {
        label: input.pageLabel ?? `标签页 ${pageTabId}`,
        host: input.pageHost ?? null,
      }
    : null;

  const controlNote = controlCopy(control, view?.state ?? null, now);
  // 已结束(idle/aborted/error)的任务不在顶部留痕：结论在回答里，要用户处理的事由接续入口负责。
  const isOngoing = !!view && (view.state === "running" || view.state === "paused" || view.state === "interrupted");

  // ── 材料区：已确认送入的任务材料 + 这一条还没确认接收的材料。还没发出的草稿由输入框里的文件卡和引用条讲，这里不重复 ──
  let materials: TaskBarModel["materials"] = null;
  const pendingEntry = unresolved.length ? unresolved[unresolved.length - 1]! : null;
  const liveTaskMaterials = isOngoing ? taskMaterials : null;
  const confirmedRows = liveTaskMaterials ? taskRows(liveTaskMaterials, view?.page ? page?.label ?? null : null) : [];
  const pendingRows = pendingEntry ? sentRows(pendingEntry) : [];

  if (liveTaskMaterials || pendingEntry || confirmedRows.length || pendingRows.length) {
    const rows = [...confirmedRows, ...pendingRows];
    // 普通发送的页面材料要等页面快照回来才认识；回执过了安静期还没到时，这段时间也必须先有「发送中」，
    // 不能因为还没行就整块不显示（本地反馈不能靠异步查页面来决定有没有）。
    const head = confirmedRows.length ? `已发给助手的材料 · ${confirmedRows.length} 项` : rows.length ? `要一起发送的材料 · ${rows.length} 项` : "正在发送";
    materials = {
      rows,
      head: pendingRows.length && confirmedRows.length ? `${head}（另有 ${pendingRows.length} 项材料待确认）` : head,
      status: pendingEntry ? (pendingEntry.status === "unknown" ? "助手还没确认收到这一条" : "正在发送，助手还没确认收到") : null,
    };
  }

  // 没被接收的消息不在顶部另起一张卡：原因已经在消息流里（如「还没有配置模型」），卡上只会剩下空的目标和占位。

  // ── 任务不随一轮结束：没做完的任务留在输入框上方写「还差：…」，做完后让出输入区；
  // 纯聊天、读页问答（没列目标）结束后照旧不留痕。
  // 目标核对的结论优先：宿主判断「做完了 / 还差」，不靠模型自己列没列目标。
  const openTask = view?.state === "idle" && (view.goalStatus ? view.goalStatus.status !== "done" : view.resumable);
  const waitingOnUser = openTask && view?.goalStatus?.status === "waiting";
  // 受阻（网站连不上等）：那一句就是原因，前面写「没做成」，与停下那行同口径。
  const blocked = openTask && view?.goalStatus?.status === "blocked";
  const stillOpen = view?.goalStatus?.remaining ?? view?.latestDelivery?.unfinished?.[0] ?? view?.outstanding[0]?.description ?? null;

  // ── 可见性：没有任何可说的事就整条隐藏 ──
  const hasViewStory = isOngoing || openTask;
  const visible = !!materials || hasViewStory || !!controlNote;

  if (!visible) {
    return { visible: false, state: "draft", goal: null, goalTitle: null, headline: "", activity: null, idleAge: null, waiting: null, page: null, materials: null, control: null };
  }

  const goal = view?.goal ?? null;

  const headline = openTask ? (stillOpen ? `${waitingOnUser ? "等你" : blocked ? "没做成" : "还差"}：${clip(stillOpen, 28)}` : "还没做完 · 接着说就行")
    : view?.state === "idle" ? ""
        : view ? stateHeadline(view.state, view.resumable) : "";

  let activity: string | null = null;

  if (view?.state === "running") {
    activity = activityText(view);

    if (activity && view.active.length) {
      const since = view.active[view.active.length - 1]!.since;

      if (Number.isFinite(since) && now >= since) activity = `${activity} · ${formatDuration(now - since)}`;
    }

    if (!activity && view.lastAction && Number.isFinite(view.lastAction.at) && now >= view.lastAction.at) {
      activity = view.lastAction.failed ? "上一步没做成" : null;
    }
  }

  // 长时间没动作才提示：短任务不该被多余数字包住（依据是真实 lastAction.at）。
  let idleAge: string | null = null;

  if (view?.state === "running" && !view.active.length && view.lastAction && Number.isFinite(view.lastAction.at) && now - view.lastAction.at >= 15_000) {
    idleAge = `上一步在 ${formatDuration(now - view.lastAction.at)}前`;
  }

  const waiting = view?.waiting ? waitingCopy(view.waiting.reason, view.waiting.detail) : null;

  return {
    visible: true,
    state: view?.state ?? "draft",
    outcome: openTask ? "open" : null,
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

interface TaskBarOptions {
  /** 挂载点；TaskBar 拥有其内容（replaceChildren）。 */
  root: HTMLElement;
  resolvePage(tabId: number): Promise<{ title?: string; url?: string } | null>;
  /** 控制失败后的重试入口（复用真实控制按钮，不是新权限）。 */
  onRetryControl?(action: "takeover" | "stop"): void;
  /** 当前选中的会话：不属于它的视图不得改写任务条（切会话/旧 run 重放都不能串）。 */
  currentConversationId?(): string;
  now?(): number;
  /** 文档工厂，单测注入假 DOM；缺省用全局 document。 */
  doc?: Document;
}

/**
 * 任务条组件。main.ts 只调用 updateView/noteRequestSent/noteReceipt/noteControl*；
 * 渲染幂等：同一状态重复渲染不产生重复节点或重复控件。
 */
export class TaskBar {
  private view: TaskView | null = null;
  private handoffShown = false;
  private readonly sent = new Map<string, SentRequestMaterials>();
  private taskMaterials: TaskMaterialSet | null = null;
  private control: ControlState = { takeover: { pending: false, since: null, failReason: null }, stop: { pending: false, since: null, accepted: false, failReason: null } };
  private readonly pageCache = new Map<number, { label: string | null; host: string | null; at: number }>();
  private model: TaskBarModel | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  /** 还在「不亮发送中」那段时间的请求：到点重画一次，回执还没来就亮出来。 */
  private quietTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly el: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly waitingEl: HTMLElement;
  private readonly pageEl: HTMLElement;
  private readonly materialsEl: HTMLElement;
  private readonly controlEl: HTMLElement;
  private readonly goalEl: HTMLElement;
  private readonly headEl: HTMLElement;
  private readonly revisionsEl: HTMLElement;
  private readonly expandEl: HTMLButtonElement;
  /** 目标、作用页全名与已送入材料默认收起，摘要行只留状态、耗时与网站名。 */
  private expanded = false;
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
    const summary = doc.createElement("div");
    summary.className = "tb-summary";
    const dot = doc.createElement("span");
    dot.className = "tb-dot";
    this.statusEl = doc.createElement("p");
    this.statusEl.className = "tb-status";
    this.statusEl.setAttribute("role", "status");
    this.statusEl.setAttribute("aria-live", "polite");
    this.expandEl = doc.createElement("button");
    this.expandEl.type = "button";
    this.expandEl.className = "tb-expand";
    this.expandEl.setAttribute("aria-expanded", "false");
    this.expandEl.setAttribute("aria-label", "展开任务详情");
    this.expandEl.title = "展开任务详情";
    summary.append(dot, this.statusEl, this.expandEl);
    this.headEl = doc.createElement("div");
    this.headEl.className = "tb-head";
    this.goalEl = doc.createElement("span");
    this.goalEl.className = "tb-goal";
    this.revisionsEl = doc.createElement("span");
    this.revisionsEl.className = "tb-revisions";
    this.headEl.append(this.goalEl, this.revisionsEl);
    this.waitingEl = doc.createElement("p");
    this.waitingEl.className = "tb-waiting";
    this.pageEl = doc.createElement("p");
    this.pageEl.className = "tb-page";
    this.materialsEl = doc.createElement("div");
    this.materialsEl.className = "tb-materials";
    this.controlEl = doc.createElement("p");
    this.controlEl.className = "tb-control";
    this.el.append(summary, this.headEl, this.waitingEl, this.pageEl, this.materialsEl, this.controlEl);
    this.el.addEventListener("click", (event) => this.onClick(event));
    opts.root.replaceChildren(this.el);
    this.render();
  }

  dispose(): void {
    this.disposed = true;

    if (this.tickTimer !== null) clearInterval(this.tickTimer);
    this.tickTimer = null;

    if (this.quietTimer !== null) clearTimeout(this.quietTimer);
    this.quietTimer = null;
  }

  setHandoffShown(shown: boolean): void {
    if (this.handoffShown === shown) return;
    this.handoffShown = shown;
    this.render();
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

    if (view.materials !== undefined) {
      this.taskMaterials = view.runId && view.state !== 'none'
        ? { runId: view.runId, items: view.materials.map(item => ({ ...item })) }
        : null;
    }

    this.render();
  }

  /** 切会话 / 重置渲染：全部清空。 */
  reset(): void {
    this.view = null;
    this.sent.clear();
    this.taskMaterials = null;
    this.pageCache.clear();
    this.control = { takeover: { pending: false, since: null, failReason: null }, stop: { pending: false, since: null, accepted: false, failReason: null } };
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
      sentAt: this.now(),
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

  /** 标签页切换/关闭后调用：重解析作用页身份。 */
  noteTabsChanged(): void {
    if (this.disposed) return;
    const tabId = this.view?.page?.tabId;

    if (tabId != null) this.pageCache.delete(tabId);
    this.render();
  }

  getModel(): TaskBarModel | null {
    return this.model;
  }

  private absorbMaterials(entry: SentRequestMaterials): void {
    // 新宿主的接受事实是唯一权威；晚到回执或旧请求缓存不得覆盖它。
    if (this.view?.materials !== undefined) return;
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
    if (target.closest(".tb-expand")) {
      this.expanded = !this.expanded;
      const label = this.expanded ? "收起任务详情" : "展开任务详情";
      this.expandEl.setAttribute("aria-label", label);
      this.expandEl.title = label;
      this.render();

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
        this.pageCache.set(tabId, { label, host: info ? pageHostOf(info) : null, at: this.now() });

        if (before !== label) this.render();
      }).catch(() => {
        if (this.disposed) return;
        this.pageCache.set(tabId, { label: null, host: null, at: this.now() });
      });
    }
  }

  private render(): void {
    if (this.disposed) return;
    const tabId = this.view?.page?.tabId ?? null;
    this.scheduleQuietEnd();

    const model = buildTaskBarModel({
      view: this.view,
      sending: [...this.sent.values()],
      taskMaterials: this.taskMaterials,
      control: this.control,
      pageLabel: tabId != null ? this.pageCache.get(tabId)?.label ?? null : null,
      pageHost: tabId != null ? this.pageCache.get(tabId)?.host ?? null : null,
      pageTabId: tabId,
      now: this.now(),
    });

    const changed = !this.model || !shallowEqualModel(this.model, model);
    this.model = model;

    // 进行中、已结束由对话里那一行过程灰字讲；任务条只在有它独有的事时出现：
    // 页面归你、停止/接管回执、还没送入的材料。任务页不是你在看的页时不提醒：过程行和回答已说明。
    // 页面归你时，输入框上方的「你在操作」已经说了；侧栏重开、没有那一行时，任务条照旧说。
    const own = model.state === "paused" && !this.handoffShown || !!model.control
      || !!model.materials?.status;

    this.el.hidden = !model.visible || !own;

    if (this.el.hidden) {
      // 不可见就清空：不留旧任务文本给屏幕阅读器，也不让测试/检查读到过期事实。
      this.goalEl.textContent = "";
      this.revisionsEl.textContent = "";
      this.statusEl.textContent = "";
      this.expandEl.hidden = true;
      this.expanded = false;
      this.el.removeAttribute("data-expanded");
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

    if (model.outcome) this.el.setAttribute("data-outcome", model.outcome);
    else this.el.removeAttribute("data-outcome");
    // 还没有任务（只是发送中）时没有目标可说，整行不显示，不放占位字。
    this.headEl.hidden = !model.goal && !this.view?.revisions.length;
    this.goalEl.textContent = model.goal ?? "";
    this.goalEl.title = model.goalTitle ?? model.goal ?? "";
    this.revisionsEl.textContent = this.view?.revisions.length ? `改过 ${this.view.revisions.length} 次` : "";
    this.revisionsEl.title = this.view?.revisions.length ? this.view.revisions.join("\n") : "";
    const statusBits = [model.headline, model.activity, model.idleAge].filter(Boolean);
    // 还没有任务状态（发送中）时，摘要行说材料那一句，材料区不再重复这句标题。
    const materialsHead = statusBits.length ? null : model.materials?.head ?? null;
    this.statusEl.textContent = materialsHead ?? statusBits.join(" · ");
    this.statusEl.hidden = !this.statusEl.textContent;
    flag(this.el, "data-head-in-summary", materialsHead !== null);
    this.waitingEl.hidden = !model.waiting;
    this.waitingEl.textContent = model.waiting ? `等待：${model.waiting.text}${model.waiting.detail ? `（${model.waiting.detail}）` : ""}` : "";
    this.pageEl.hidden = !model.page;
    this.pageEl.textContent = model.page ? `页面：${model.page.label}` : "";
    this.renderMaterials(model.materials);
    // 只有已送入的材料才收进详情；发送中的材料要一直看得见。
    const settledMaterials = !!model.materials && !model.materials.status;
    flag(this.materialsEl, "data-settled", settledMaterials);
    // 材料里已经列出这一页时，展开后不再另写一行「作用于」。
    flag(this.el, "data-page-in-materials", !!model.materials?.rows.some((row) => row.kind === "page"));
    const hasDetail = !this.headEl.hidden || !!model.page || (settledMaterials && !this.materialsEl.hidden);
    this.expandEl.hidden = !hasDetail;
    flag(this.el, "data-expanded", this.expanded && hasDetail);
    this.expandEl.setAttribute("aria-expanded", String(this.expanded && hasDetail));
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
      retry.setAttribute("aria-label", `${control.retry === "stop" ? "中止" : "接管"}再试一次`);
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

      list.appendChild(li);
    }

    this.materialsEl.replaceChildren(head, list);

    if (materials.status) {
      const status = doc.createElement("div");
      status.className = "tb-mat-status";
      status.textContent = materials.status;
      this.materialsEl.appendChild(status);
    }
  }

  private scheduleQuietEnd(): void {
    if (this.quietTimer !== null) clearTimeout(this.quietTimer);
    this.quietTimer = null;
    const now = this.now();
    const waits = [...this.sent.values()].filter((s) => s.status === "sending" && now - s.sentAt < SENDING_QUIET_MS).map((s) => SENDING_QUIET_MS - (now - s.sentAt));

    if (waits.length) this.quietTimer = setTimeout(() => { this.quietTimer = null; this.render(); }, Math.min(...waits) + 20);
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

/** 布尔属性开关：只用 set/removeAttribute，单测注入的简化 DOM 也能跑。 */
function flag(el: Element, name: string, on: boolean): void {
  if (on) el.setAttribute(name, "");
  else el.removeAttribute(name);
}

function shallowEqualModel(a: TaskBarModel, b: TaskBarModel): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
