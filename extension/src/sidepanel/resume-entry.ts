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
import type { TaskView } from "../../../shared/task-view.js";
import type { TaskActionRequest } from "../../../shared/task-actions.js";
import type { PageContext } from "../../../shared/protocol.js";

const STATUS_LABEL: Record<string, string> = { pending: "未完成", blocked: "执行受阻", unknown: "结果未知", satisfied: "已完成" };

export const RESUME_TIMING_SAMPLE_MAX = 100;

export const RESUME_PENDING_TIMEOUT_MS = 15_000;

export function resultStatusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

const WAITING_TEXT: Record<string, string> = {
  human_control: "页面已交给你，继续前先交还",
  restart_checkpoint: "任务中断在检查点，等你说继续",
  cancelled: "已按你的要求停止，不会自动复活",
  failure_limit: "连续失败达到上限，已停住等你决定",
  unknown_with_baseline: "有操作结果未知，先核对再继续",
  unknown_without_baseline: "有操作结果未知且缺少可对比基线，不会自动重做",
  readback_required: "执行过了，但还没读回核对",
  tool_failed: "上一步执行失败，需要换方法",
  runtime_error: "运行出错，只能如实交付已有事实",
};

const INTERRUPTION_DETAIL: Record<string, string> = {
  host_restart: "本地进程重启",
  connection_lost: "与伴随进程的连接断开",
  manual_continuation: "按你的要求停在这里",
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

  if (checkpointUnavailable) return { available: false, reason: "原任务检查点无法恢复，不会自动重做；其他任务可另开会话" };

  if (view.state === "running") return { available: false, reason: "任务正在执行" };

  if (view.state === "paused") return { available: false, reason: "页面已交给你；在页面上点「交还」后我会继续原任务" };

  if (view.state === "aborted") return { available: false, reason: "任务已停止，这个入口不会把它复活" };

  if (view.state === "interrupted" || ["idle", "error"].includes(view.state)) {
    if (!view.resumable) return { available: false, reason: "没有可恢复的原始依据，不会自动继续" };

    if (!view.runId) return { available: false, reason: "缺少原任务身份，不能续接" };

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
}

function headlineFor(view: TaskView, checkpointUnavailable: boolean): { tone: ResumeSummary["tone"]; headline: string } {
  if (checkpointUnavailable) return { tone: "stopped", headline: "原任务检查点无法恢复" };

  switch (view.state) {
    case "running": return { tone: "running", headline: "正在执行" };
    case "paused": return { tone: "waiting", headline: "已暂停 · 页面归你" };
    case "interrupted": return { tone: "waiting", headline: "已中断 · 可继续" };
    case "aborted": return { tone: "stopped", headline: "已停止" };
    case "error": return { tone: "blocked", headline: "运行出错" };
    case "idle": return view.outstanding.length || view.waiting || view.resumable
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
    return { visible: false, tone: "running", headline: "", goal: null, revisions: [], done: [], remaining: [], blocking: null, interruptionDetail: null, nextStep: "", resume: { available: false, reason: null }, gaps: [] };
  }

  const tone = headlineFor(view, checkpointUnavailable);
  const done = view.results.filter((r) => r.status === "satisfied").map((r) => ({ id: r.id, description: r.description }));
  const remaining = view.outstanding.map((r) => ({ id: r.id, description: r.description, status: r.status, statusLabel: resultStatusLabel(r.status) }));
  const unknown = remaining.filter((r) => r.status === "unknown").length;
  const blocked = remaining.filter((r) => r.status === "blocked").length;
  const interruptionDetail = view.waiting?.reason === "restart_checkpoint" && view.waiting.detail ? (INTERRUPTION_DETAIL[view.waiting.detail] ?? view.waiting.detail) : null;
  const blocking = view.waiting ? waitingText(view.waiting.reason, view.waiting.detail) : unknown ? "有操作结果未知，不会自动重做" : blocked ? "有步骤执行受阻" : null;
  const resume = resumeAvailability(view, checkpointUnavailable);

  const nextStep = (() => {
    if (checkpointUnavailable) return "不会自动重做原任务；没有覆盖原记录，其他独立任务可以另开会话。";

    if (resume.available) {
      return unknown || blocked
        ? "可以点「继续原任务」重新读取当前页面并核对；未知项需要可靠依据或你的决定，不会重复提交。"
        : "点「继续原任务」：先重新读取当前页面，再完成剩余项；已完成的步骤不会重做。";
    }

    if (view.state === "running") return remaining.length ? `正在处理剩余 ${remaining.length} 项。` : "正在执行；完成后会交给你可核对的结果。";

    if (view.state === "paused") return "在页面上点「交还」后，我会继续原任务剩余部分。";

    if (view.state === "aborted") return "已按你的要求停止；历史保留，需要的话请重新说明新任务。";

    if (unknown) return "未知项需要核对可靠回执或由你决定；在得到依据前不会重复提交。";

    if (blocked) return "按当前页面新观察换方法继续；无法恢复的部分会如实说明。";

    if (remaining.length) return "还有未完成项；可以用「继续原任务」从剩余部分继续（如果原依据仍在）。";

    if (view.waiting || view.resumable) return "这一轮已经结束，仍需核对或处理；请按阻塞说明继续。";

    return "这一轮已经结束；登记的步骤没有待办，不代表所有要求都已核验。";
  })();

  const gaps: string[] = [];

  if (checkpointUnavailable) gaps.push("原任务检查点无法恢复；原记录未被覆盖，本会话不会执行它，其他独立任务可以另开会话");
  else if (view.state !== "interrupted" && view.state !== "running" && view.state !== "aborted" && view.state !== "paused") gaps.push(resume.reason ?? "");

  if (unknown) gaps.push(`${unknown} 项操作结果未知；不会重复提交，需要可靠回执或你的决定`);

  if (blocked) gaps.push(`${blocked} 项执行受阻，需要换方法`);

  const visible = checkpointUnavailable
    || ["running", "paused", "interrupted", "error"].includes(view.state)
    || (view.state === "aborted" && (remaining.length > 0 || !!view.waiting))
    || (view.state === "idle" && (remaining.length > 0 || !!view.waiting));

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

    if (summary.goal) {
      const goal = document.createElement("p");
      goal.className = "resume-goal";
      goal.textContent = summary.revisions.length ? `${summary.goal}（另 ${summary.revisions.length} 条修改）` : summary.goal;
      section.append(goal);
    }

    const head = document.createElement("p");
    head.className = "resume-headline";
    head.textContent = summary.headline;
    section.append(head);

    if (summary.done.length) {
      const line = document.createElement("p");
      line.className = "resume-line resume-done";
      line.textContent = `已完成 ${summary.done.length} 项：${summary.done.slice(0, 3).map((d) => d.description).join("、")}${summary.done.length > 3 ? "…" : ""}`;
      section.append(line);
    }

    if (summary.remaining.length) {
      const line = document.createElement("p");
      line.className = "resume-line resume-remaining";
      line.textContent = `剩余 ${summary.remaining.length} 项：${summary.remaining.slice(0, 3).map((r) => `${r.description}（${r.statusLabel}）`).join("、")}${summary.remaining.length > 3 ? "…" : ""}`;
      section.append(line);
    }

    if (summary.blocking) {
      const line = document.createElement("p");
      line.className = "resume-line resume-blocking";
      line.textContent = summary.blocking;
      section.append(line);
    }

    const next = document.createElement("p");
    next.className = "resume-next";
    next.textContent = summary.nextStep;
    section.append(next);

    if (summary.gaps.length) {
      const gap = document.createElement("p");
      gap.className = "resume-gap";
      gap.textContent = summary.gaps.join("；");
      section.append(gap);
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

/** 侧栏样式已含同名规则时不再注入；面板验收与单测环境都能独立工作。 */
function ensureStyles(): void {
  if (stylesInjected || typeof document === "undefined") return;

  if (document.getElementById("resume-entry-styles")) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = "resume-entry-styles";
  style.textContent = [
    "resume-entry{display:flex;flex-direction:column;margin:10px 0 8px;padding:12px 14px;border:1px solid var(--content-border,#ded8cd);border-radius:14px;background:var(--content-bg,#fcfaf5);box-shadow:0 2px 8px rgba(0,0,0,.02);font-size:12px;line-height:1.5;color:var(--text-secondary,#686459);align-self:stretch;box-sizing:border-box}",
    "resume-entry .resume-headline{display:inline-flex;align-items:center;align-self:flex-start;font-size:11px;font-weight:600;padding:2px 8px;border-radius:6px;background:var(--warn-soft,rgba(155,104,43,.1));color:var(--warn,#9b682b);margin:0 0 6px}",
    "resume-entry[data-tone=running] .resume-headline{background:var(--apple-blue-soft,rgba(121,82,59,.08));color:var(--accent,#79523b)}",
    "resume-entry[data-tone=blocked] .resume-headline{background:var(--err-soft,rgba(183,69,54,.08));color:var(--err,#b74536)}",
    "resume-entry[data-tone=stopped] .resume-headline{background:var(--content-subtle,#ece7de);color:var(--text-tertiary,#807b70)}",
    "resume-entry .resume-goal{margin:0 0 8px;color:var(--text-primary,#292821);font-size:13.5px;font-weight:600;line-height:1.45}",
    "resume-entry .resume-line{margin:3px 0;padding:6px 10px;border-radius:8px;background:var(--content-subtle,#ece7de);color:var(--text-primary,#292821);display:flex;align-items:flex-start;gap:6px;line-height:1.45}",
    "resume-entry .resume-line.resume-done{color:var(--text-secondary,#686459)}",
    "resume-entry .resume-line.resume-done::before{content:'✓';color:var(--ok,#438558);font-weight:bold;flex-shrink:0}",
    "resume-entry .resume-line.resume-remaining::before{content:'○';color:var(--warn,#9b682b);font-weight:bold;flex-shrink:0}",
    "resume-entry .resume-line.resume-blocking{background:var(--warn-soft,rgba(155,104,43,.1));color:var(--warn,#9b682b)}",
    "resume-entry .resume-line.resume-blocking::before{content:'!';font-weight:bold;flex-shrink:0}",
    "resume-entry .resume-next,resume-entry .resume-gap{margin:8px 0 0;font-size:11.5px;color:var(--text-tertiary,#807b70);line-height:1.4}",
    "resume-entry .resume-action{align-self:flex-end;margin-top:10px;padding:6px 14px;border-radius:8px;border:none;background:var(--accent,#79523b);color:#fff;font:inherit;font-size:12px;font-weight:500;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.08);transition:background .15s ease,transform .1s ease}",
    "resume-entry .resume-action:hover:not([disabled]){background:var(--accent-hover,#62412e)}",
    "resume-entry .resume-action:active:not([disabled]){transform:scale(.98)}",
    "resume-entry .resume-action[disabled]{opacity:.6;cursor:default}",
  ].join("");
  document.head.append(style);
}
