/**
 * T05 接续入口：由 T02 只读任务视图驱动的「回来时知道发生了什么、下一步能做什么」摘要。
 *
 * 诚实边界：
 * - 只消费 task_view 投影，不另造任务状态；不触发模型、页面或权限。
 * - 「继续原任务」按钮只在视图明确 resumable 且当前会话确有可恢复依据时出现；
 *   点击只提交一次现有 resume 任务动作（宿主会先重读当前页面、再处理剩余项），
 *   不携带也不重放任何旧工具参数。
 * - 摘要呈现时序：从收到视图（apply 调用）到下一帧可视为「可见摘要」，
 *   采样交给真实面板验收读取，50 次 P95 ≤200ms。
 */
import { canAutoResume, type TaskView } from "../../../shared/task-view.js";
import type { TaskActionRequest } from "../../../shared/task-actions.js";
import type { PageContext } from "../../../shared/protocol.js";
import { plainStep } from "../../../shared/user-facing.js";

const STATUS_LABEL: Record<string, string> = { pending: "还没做", blocked: "没做成", unknown: "结果未知", satisfied: "做完了" };

export const RESUME_TIMING_SAMPLE_MAX = 100;

export const RESUME_PENDING_TIMEOUT_MS = 15_000;

export function resultStatusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

const WAITING_TEXT: Record<string, string> = {
  human_control: "页面现在归你，点「交还」后再接着做",
  restart_checkpoint: "任务中断了，说「继续」就接着做",
  cancelled: "你中止了任务，助手不会自己重新开始",
  failure_limit: "连续几步没做成，助手在等你决定",
  unknown_with_baseline: "有 1 步结果未知，助手先核验再继续",
  unknown_without_baseline: "有 1 步结果未知，助手没有改动前的记录，不会自己重做",
  readback_required: "做了，但助手还没核验",
  tool_failed: "上一步没做成，助手要换个做法",
  runtime_error: "出错了，助手只给你已确认的结果",
};

/** 只是在复述某个结果未知、受阻的执行项的等待原因：目标核对判做完后不再为它出卡。 */
const CHECK_COVERS_WAITING = new Set(["tool_failed", "unknown_with_baseline", "unknown_without_baseline"]);

const INTERRUPTION_DETAIL: Record<string, string> = {
  host_restart: "扩展后台重启了",
  connection_lost: "扩展后台断开了",
  manual_continuation: "你中止了任务",
};

export function waitingText(reason: string, detail: string | null): string {
  const base = WAITING_TEXT[reason] ?? reason;

  if (reason === "restart_checkpoint" && detail) {
    const why = INTERRUPTION_DETAIL[detail] ?? detail;

    return `${base}（${why}）`;
  }

  return base;
}

export interface ResumeAvailability {
  available: boolean;
  reason: string | null;
}

/** 「继续」按钮的可用性：只以 T02 视图的 resumable（真实恢复依据）为准。 */
export function resumeAvailability(view: TaskView | null, checkpointUnavailable: boolean): ResumeAvailability {
  if (!view) return { available: false, reason: "还没有当前任务的状态" };

  if (checkpointUnavailable) return { available: false, reason: "原任务无法接着做。新任务要另开一个会话。" };

  if (view.state === "running") return { available: false, reason: "任务正在做" };

  if (view.state === "paused") return { available: false, reason: "页面现在归你。点「交还」后，我会继续原任务。" };

  if (view.state === "aborted") return { available: false, reason: "任务已中止。这里不能重新开始它。" };

  // 模型已在回答里说明哪些没做完：接下来要你补信息或换页面，直接在输入框回复，不给「继续」重跑。
  if (declaredUnfinished(view).length) return { available: false, reason: "回答里已说明没做完的部分，直接回复就行" };

  if (view.state === "interrupted" || ["idle", "error"].includes(view.state)) {
    if (!view.resumable) return { available: false, reason: "找不到原任务的记录，不会自己继续" };

    if (!view.runId) return { available: false, reason: "找不到原任务，不能接着做" };

    return { available: true, reason: null };
  }

  return { available: false, reason: "当前没有需要接续的原任务" };
}

export interface ResumeSummary {
  visible: boolean;
  tone: "running" | "waiting" | "unknown" | "blocked" | "stopped";
  headline: string;
  goal: string | null;
  revisions: string[];
  done: { id: string; description: string }[];
  remaining: { id: string; description: string; status: string; statusLabel: string }[];
  blocking: string | null;
  interruptionDetail: string | null;
  nextStep: string;
  resume: ResumeAvailability;
  gaps: string[];
  /** 侧栏上唯一的一行：这一轮还要用户处理什么。细节留在回答正文里。 */
  line: string;
  /** 这次「继续」被拒或未确认的原因；需要用户知道，所以单独一行。 */
  note: string | null;
}

/** 回合正常结束时，模型自己列出的未完成项；中断、出错、停止仍按宿主账本说。 */
function declaredUnfinished(view: TaskView): string[] {
  return view.state === "idle" ? view.latestDelivery?.unfinished ?? [] : [];
}

/**
 * 最近一次目标核对的结论（标准 8）：判做完 → 没有剩余；说了还差什么 → 就是它；没核对过或没说 → null，交给后面的来源。
 * 来源顺序与过往任务摘要相同：核对的「还差」→ 模型自己交代的未完成项 → 计划目标。
 */
function checkedRemaining(view: TaskView): string[] | null {
  const status = view.goalStatus;

  if (!status) return null;

  if (status.status === "done") return [];

  return status.remaining ? [status.remaining] : null;
}

/** 列了计划、但宿主从没核对过的目标：只能说没确认，不能说没做。 */
function unverifiedGoal(view: TaskView, item: { status: string }): boolean {
  return view.goalsListed === true && item.status === "pending";
}

function clipText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function compactLine(view: TaskView, checkpointUnavailable: boolean, remaining: ResumeSummary["remaining"], blocking: string | null): string {
  if (checkpointUnavailable) return "原任务无法接着做，不会自己重做";

  if (view.state === "paused") return "页面现在归你，点「交还」后接着做";
  const declared = declaredUnfinished(view);

  // 用户要的哪件事没做成，比中途哪个工具失败更有用；中途失败留在步骤清单里。
  // 只说是哪件事，不报账本的计数口吻；多于一件时补「等 N 件」。
  // 中断或停下的任务不是「没做成」，只是还没做到。
  const verb = view.state === "interrupted" || view.state === "aborted" ? "还没做" : "没做成";
  const phrase = (head: string, items: string[]) => `${head}：${clipText(items[0]!, 24)}${items.length > 1 ? ` 等 ${items.length} 件` : ""}`;
  // 失败的人话原因（「目标现在不可用」，#304）比只说步骤名更有用：说「没做成」时有它就顶替行内的步骤名；「还没做」时仍说是哪件事。
  const notDone = (items: string[], reason?: string) => phrase(verb, reason && verb === "没做成" ? [reason, ...items.slice(1)] : items);

  const told = checkedRemaining(view) ?? (declared.length ? declared : view.latestDelivery?.unfinished?.length ? view.latestDelivery.unfinished : null);

  if (view.state === "idle" && told?.length) return notDone(told);
  // 描述已在 buildResumeSummary 里翻成人话（不带工具名、元素编号）。
  const unverifiedOnly = remaining.length > 0 && remaining.every((r) => unverifiedGoal(view, r));
  const listed = remaining.map((r) => r.description);
  // 按计划列目标时，没核验的目标旁边有一步真没做成：说没做成和原因，不说「还没确认完成」。
  const reason = view.failureReason;
  const left = told ? (told.length ? notDone(told) : null) : listed.length ? (unverifiedOnly && !reason ? phrase("还没确认完成", listed) : notDone(listed, reason)) : null;

  // 停在一步中间（结果未知）不是「还没做」：页面上可能已经留下了部分结果（#103，整页翻译停下时已翻好几百段）。
  const midway = !told && remaining.length > 0 && remaining.every((r) => r.status === "unknown");

  if (view.state === "aborted" && midway) return `已中止，${clipText(listed[0]!, 24)}${listed.length > 1 ? ` 等 ${listed.length} 件` : ""}停在中途，不会自己继续`;

  if (view.state === "aborted") return left ? `已中止，${left}，不会自己继续` : "已中止";

  if (view.state === "interrupted") return left ? `任务中断了，${left}` : "任务中断了";

  if (view.state === "error") return left ? `出错了，${left}` : "出错了";

  if (left) return remaining.some(r => r.status === "unknown") ? `${left}（结果未知）` : left;

  return blocking ?? "这一轮还需要你看一下";
}

function headlineFor(view: TaskView, checkpointUnavailable: boolean, remainingCount: number): { tone: ResumeSummary["tone"]; headline: string } {
  if (checkpointUnavailable) return { tone: "stopped", headline: "原任务无法接着做" };

  switch (view.state) {
    case "running": return { tone: "running", headline: "正在做" };
    case "paused": return { tone: "waiting", headline: "已暂停 · 页面归你" };
    case "interrupted": return { tone: "waiting", headline: "已中断 · 可继续" };
    case "aborted": return { tone: "stopped", headline: "已中止" };
    case "error": return { tone: "blocked", headline: "出错了" };
    case "idle": return remainingCount || view.waiting || view.resumable
      ? { tone: "waiting", headline: "任务已结束 · 仍需处理" }
      : { tone: "running", headline: "任务已结束" };
    default: return { tone: "running", headline: "当前会话" };
  }
}

/**
 * 纯投影：视图 → 用户能读的摘要（目标、已完成、剩余、阻塞原因、合法下一步、缺口）。
 * 不推断视图里没有的事实；缺字段时如实少说。
 */
export function buildResumeSummary(view: TaskView | null, checkpointUnavailable = false, resumeNote: string | null = null): ResumeSummary {
  if (!view) {
    return { visible: false, tone: "running", headline: "", goal: null, revisions: [], done: [], remaining: [], blocking: null, interruptionDetail: null, nextStep: "", resume: { available: false, reason: null }, gaps: [], line: "", note: null };
  }

  const done = view.results.filter((r) => r.status === "satisfied").map((r) => ({ id: r.id, description: plainStep(r.description) }));
  // 核对判做完：没核对过的计划目标不再算剩余。结果未知、受阻的执行项仍列在摘要里，但结束后的卡片不再为它们出现（见下方 visible）。
  const checkedDone = checkedRemaining(view)?.length === 0;

  const remaining = view.outstanding.filter((r) => !(checkedDone && unverifiedGoal(view, r)))
    .map((r) => ({ id: r.id, description: plainStep(r.description), status: r.status, statusLabel: unverifiedGoal(view, r) ? "还没核验" : resultStatusLabel(r.status) }));

  const tone = headlineFor(view, checkpointUnavailable, remaining.length);
  const unknown = remaining.filter((r) => r.status === "unknown").length;
  const blocked = remaining.filter((r) => r.status === "blocked").length;
  const interruptionDetail = view.waiting?.reason === "restart_checkpoint" && view.waiting.detail ? (INTERRUPTION_DETAIL[view.waiting.detail] ?? view.waiting.detail) : null;
  const blocking = view.waiting ? waitingText(view.waiting.reason, view.waiting.detail) : unknown ? "有 1 步结果未知，不会自己重做" : blocked ? "有 1 步没做成" : null;
  const resume = resumeAvailability(view, checkpointUnavailable);

  const nextStep = (() => {
    if (checkpointUnavailable) return "原任务无法接着做。原来的记录还在。新任务要另开一个会话。";

    // 后台自动续做只在原标签页还在时发生（extension/src/background/auto-resume.ts），侧栏看不到标签页，按两种情况都说清。
    if (resume.available && view.state === "interrupted" && canAutoResume(view)) return "扩展后台刚重启。如果原页面还开着，我会自动接着做。做完的步骤不会重做。如果一直没有变化，就点「继续原任务」。";

    if (resume.available) {
      return unknown || blocked
        ? "点「继续原任务」，助手先重读当前页面，再核验。结果未知的步骤，要等你决定。助手不会重复提交。"
        : "点「继续原任务」，助手先重读当前页面，再做剩下的步骤。做完的步骤不会重做。";
    }

    if (view.state === "running") return remaining.length ? `正在做剩下的 ${remaining.length} 步。` : "正在做。做完后，你会看到能核对的结果。";

    if (view.state === "paused") return "点「交还」后，我会先重读页面，再做原任务剩下的部分。";

    if (view.state === "aborted") return "你中止了任务。会话记录还在。要做新任务，就重新说一遍。";

    if (unknown) return "结果未知的步骤，要等你决定。助手不会重复提交。";

    if (blocked) return "助手会看当前页面，换个做法继续。做不到的部分，助手会告诉你。";

    if (remaining.length) return "还有步骤没做完。点「继续原任务」，从剩下的部分接着做。";

    if (view.waiting || view.resumable) return "这一轮结束了。还有事要你看一下。";

    return "这一轮结束了。列出的步骤都做完了。这不代表每个要求都核验过。";
  })();

  const gaps: string[] = [];

  if (checkpointUnavailable) gaps.push("原任务无法接着做。原来的记录还在。新任务要另开一个会话");
  else if (view.state !== "interrupted" && view.state !== "running" && view.state !== "aborted" && view.state !== "paused") gaps.push(resume.reason ?? "");

  if (unknown) gaps.push(`${unknown} 步结果未知。助手不会重复提交，要等你决定`);

  if (blocked) gaps.push(`${blocked} 步没做成，助手要换个做法`);

  // 运行中由顶部任务条负责；这张卡只在需要用户处理时出现（页面归你、中断、出错、停止或结束后仍有剩余）。
  // 结束后目标核对判做完（#334，主会话 10-13 定）：结果未知、受阻的执行项不再出卡，那一步的状态只留在展开的过程里
  // （它的 chip 已写「没做成」）；发送类动作另有发送前确认把关。只是复述这些执行项的等待原因同样不出卡，其他等待照旧出卡。
  const coveredByCheck = checkedDone && view.state === "idle";
  const waitingShows = !!view.waiting && !(coveredByCheck && CHECK_COVERS_WAITING.has(view.waiting.reason));

  const visible = checkpointUnavailable
    || ["paused", "interrupted", "error"].includes(view.state)
    || (view.state === "aborted" && (remaining.length > 0 || !!view.waiting))
    // 模型在回答里自己交代的没做完（declaredUnfinished）不另出卡：回答已经说了，「继续」也不提供（#103）。
    || (view.state === "idle" && (remaining.some((r) => !(coveredByCheck && (r.status === "unknown" || r.status === "blocked"))) || waitingShows));

  return {
    visible,
    tone: tone.tone,
    headline: tone.headline,
    goal: view.goal,
    revisions: view.revisions,
    done,
    remaining,
    blocking,
    interruptionDetail,
    nextStep,
    resume,
    gaps: [...new Set([...gaps, ...(resumeNote ? [resumeNote] : [])].filter(Boolean))],
    line: compactLine(view, checkpointUnavailable, remaining, blocking),
    note: resumeNote,
  };
}

export interface ResumeEntryOptions {
  root: HTMLElement;
  /** 提交一次 resume 任务动作；返回是否真正交给了上行通道。 */
  sendResume: (request: TaskActionRequest) => boolean;
  /** 恢复前核对用：当前活动页；拿不到时不发送，交由用户打开原页面。 */
  getContext: () => Promise<PageContext | null>;
  newRequestId?: () => string;
  now?: () => number;
  scheduleFrame?: (callback: () => void) => void;
  pendingTimeoutMs?: number;
}

const ELEMENT_TAG = "resume-entry";

/** 一个任务视图一份摘要；不保存历史视图，不跨会话复用。 */
export class ResumeEntry {
  private view: TaskView | null = null;
  private checkpointUnavailable = false;
  private note: string | null = null;
  private noteRunId: string | null = null;
  private pendingRequestId: string | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly samples: number[] = [];
  private readonly now: () => number;
  private readonly scheduleFrame: (callback: () => void) => void;
  private disposed = false;

  constructor(private readonly opts: ResumeEntryOptions) {
    this.now = opts.now ?? (() => performance.now());
    this.scheduleFrame = opts.scheduleFrame ?? ((cb) => requestAnimationFrame(() => cb()));
  }

  /** 收到权威 task_view（实时或重连补取）→ 重建摘要，并记录一帧呈现时序。 */
  apply(view: TaskView | null, options: { checkpointUnavailable?: boolean } = {}): void {
    if (this.disposed) return;
    const started = this.now();
    this.view = view;
    this.checkpointUnavailable = options.checkpointUnavailable === true;

    // 视图进入 running 才说明这次继续真的生效；idle/error/partial 等状态不得提前清掉等待，
    // 否则晚到的拒绝回执会被静默丢弃，用户看不到原因（超时由 pendingTimer 兜底）。
    if (this.pendingRequestId && view?.state === "running") this.clearPending();

    if (this.note && view && (view.runId !== this.noteRunId || view.state === "running")) this.note = null;
    const summary = buildResumeSummary(this.view, this.checkpointUnavailable, this.note);
    this.render(summary);
    this.scheduleFrame(() => {
      if (this.disposed) return;
      this.samples.push(this.now() - started);

      if (this.samples.length > RESUME_TIMING_SAMPLE_MAX) this.samples.shift();
    });
  }

  clear(): void {
    this.clearPending();
    this.view = null;
    this.note = null;
    this.noteRunId = null;
    this.checkpointUnavailable = false;
    this.opts.root.hidden = true;
    this.opts.root.replaceChildren();
  }

  /** 恢复请求的真实回执：只处理本轮请求；失败原因原样显示，不伪造成功。 */
  noteReceipt(receipt: { requestId: string; status: string; message?: string }): void {
    if (!this.pendingRequestId || receipt.requestId !== this.pendingRequestId) return;

    if (receipt.status === "accepted" || receipt.status === "applied" || receipt.status === "queued") {
      // 已受理：等状态真的变成 running；超时仍给可重试提示，不宣布已继续。
      return;
    }

    this.clearPending();
    this.note = receipt.message?.trim() || (receipt.status === "rejected" ? "这次继续没有执行。" : "这次继续没有得到确认。");
    this.noteRunId = this.view?.runId ?? null;
    this.render(buildResumeSummary(this.view, this.checkpointUnavailable, this.note));
  }

  timing(): { count: number; p95: number | null; samples: number[] } {
    const sorted = [...this.samples].sort((a, b) => a - b);
    const p95 = sorted.length ? sorted[Math.ceil(0.95 * sorted.length) - 1]! : null;

    return { count: sorted.length, p95, samples: sorted };
  }

  dispose(): void {
    this.disposed = true;
    this.clearPending();
  }

  private clearPending(): void {
    this.pendingRequestId = null;

    if (this.pendingTimer !== null) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
  }

  private async requestResume(): Promise<void> {
    if (this.pendingRequestId || !this.view) return;
    const check = resumeAvailability(this.view, this.checkpointUnavailable);

    if (!check.available) return;
    const requestId = this.opts.newRequestId?.() ?? globalThis.crypto.randomUUID();
    this.pendingRequestId = requestId;
    this.note = null;
    this.noteRunId = null;
    this.render(buildResumeSummary(this.view, this.checkpointUnavailable, "正在继续原任务…"));
    let context: PageContext | null;

    try {
      context = await this.opts.getContext();
    } catch {
      context = null;
    }

    if (this.pendingRequestId !== requestId) return;

    if (!context) {
      this.clearPending();
      this.note = "看不到当前浏览器页面，未发送继续请求；请先打开原任务的页面。";
      this.noteRunId = this.view?.runId ?? null;
      this.render(buildResumeSummary(this.view, this.checkpointUnavailable, this.note));

      return;
    }

    const request: TaskActionRequest = {
      requestId,
      conversationId: this.view.conversationId,
      source: "text",
      action: "resume",
      expectedRunId: this.view.runId ?? null,
      expectedControlVersion: this.view.controlVersion,
      text: "继续原任务",
      context,
    };

    if (!this.opts.sendResume(request)) {
      this.clearPending();
      this.note = "连接不可用，继续请求没有发出去；原任务记录不变。";
      this.noteRunId = this.view?.runId ?? null;
      this.render(buildResumeSummary(this.view, this.checkpointUnavailable, this.note));

      return;
    }

    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;

      if (!this.pendingRequestId) return;
      this.pendingRequestId = null;
      this.note = "继续请求还没有得到确认，可以再试一次；不会重复执行已确认的步骤。";
      this.noteRunId = this.view?.runId ?? null;
      this.render(buildResumeSummary(this.view, this.checkpointUnavailable, this.note));
    }, this.opts.pendingTimeoutMs ?? RESUME_PENDING_TIMEOUT_MS);
  }

  private render(summary: ResumeSummary): void {
    const root = this.opts.root;

    if (!summary.visible) {
      root.hidden = true;
      root.replaceChildren();

      return;
    }

    root.hidden = false;
    ensureStyles();
    const section = document.createElement(ELEMENT_TAG);
    section.dataset.tone = summary.tone;
    const line = document.createElement("p");
    line.className = "resume-line";
    line.textContent = summary.line;
    // 完整说明（下一步、缺口）只在悬停时给，默认一行。
    line.title = [summary.nextStep, ...summary.gaps.filter(gap => gap !== summary.note)].filter(Boolean).join("\n");
    section.append(line);

    if (summary.note) {
      const note = document.createElement("p");
      note.className = "resume-note";
      note.textContent = summary.note;
      section.append(note);
    }

    if (summary.resume.available) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "resume-action";
      button.dataset.pending = String(!!this.pendingRequestId);
      button.disabled = !!this.pendingRequestId;
      button.textContent = this.pendingRequestId ? "正在继续…" : "继续原任务";
      button.onclick = () => void this.requestResume();
      section.append(button);
    }

    root.replaceChildren(section);
  }
}

let stylesInjected = false;

/** 侧栏样式已含同名规则时不再注入；面板验收环境也能独立工作。 */
function ensureStyles(): void {
  if (stylesInjected || typeof document === "undefined") return;

  if (document.getElementById("resume-entry-styles")) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = "resume-entry-styles";
  style.textContent = [
    "resume-entry{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;margin:6px 0 8px;font-size:12.5px;line-height:1.5;color:var(--text-secondary,#686459)}",
    "resume-entry .resume-line{margin:0;flex:1 1 auto;min-width:0}",
    "resume-entry[data-tone=blocked] .resume-line{color:var(--err,#b74536)}",
    "resume-entry .resume-note{margin:0;flex-basis:100%;order:3;font-size:11.5px;color:var(--warn,#9b682b)}",
    "resume-entry .resume-action{flex:none;padding:3px 12px;border-radius:999px;border:1px solid var(--content-border,#ded8cd);background:transparent;color:var(--text-primary,#292821);font:inherit;font-size:12px;cursor:pointer;transition:background .15s ease,border-color .15s ease}",
    "resume-entry .resume-action:hover:not([disabled]){background:var(--content-subtle,#ece7de)}",
    "resume-entry .resume-action:focus-visible{outline:2px solid var(--accent,#79523b);outline-offset:2px}",
    "resume-entry .resume-action[disabled]{opacity:.6;cursor:default}",
  ].join("");
  document.head.append(style);
}
