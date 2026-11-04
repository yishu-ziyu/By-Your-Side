import type { TaskView } from "../../../shared/task-view.js";
import type { TaskActionRequest } from "../../../shared/task-actions.js";
import type { PageContext } from "../../../shared/protocol.js";
import { plainStep } from "../../../shared/user-facing.js";
import { resultStatusText } from "../../../shared/task-status-copy.js";

const RESUME_PENDING_TIMEOUT_MS = 15_000;

const CHECK_COVERS_WAITING = new Set(["tool_failed", "unknown_with_baseline", "unknown_without_baseline"]);

interface ResumeAvailability {
  available: boolean;
  reason: string | null;
}

function resumeAvailability(view: TaskView | null, checkpointUnavailable: boolean): ResumeAvailability {
  if (!view) return { available: false, reason: "还没有当前任务的状态" };

  if (checkpointUnavailable) return { available: false, reason: "原任务无法接着做。新任务要另开一个会话。" };

  if (view.state === "running") return { available: false, reason: "任务正在做" };

  if (view.state === "paused") return { available: false, reason: "页面现在归你。点「交还」后，我会继续原任务。" };

  if (view.state === "aborted") return { available: false, reason: "任务已中止。这里不能重新开始它。" };

  if (declaredUnfinished(view).length) return { available: false, reason: "回答里已说明没做完的部分，直接回复就行" };

  if (view.state === "interrupted" || ["idle", "error"].includes(view.state)) {
    if (!view.resumable) return { available: false, reason: "找不到原任务的记录，不会自己继续" };

    if (!view.runId) return { available: false, reason: "找不到原任务，不能接着做" };

    return { available: true, reason: null };
  }

  return { available: false, reason: "当前没有需要接续的原任务" };
}

interface ResumeSummary {
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
  line: string;
  note: string | null;
}

function declaredUnfinished(view: TaskView): string[] {
  return view.state === "idle" ? view.latestDelivery?.unfinished ?? [] : [];
}

function checkedRemaining(view: TaskView): string[] | null {
  const status = view.goalStatus;

  if (!status) return null;

  if (status.status === "done") return [];

  return status.remaining ? [status.remaining] : null;
}

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

  const verb = view.state === "interrupted" || view.state === "aborted" ? "还没做" : view.goalStatus?.status === "waiting" ? "等你决定" : "没做成";
  const phrase = (head: string, items: string[]) => `${head}：${clipText(items[0]!, 24)}${items.length > 1 ? ` 等 ${items.length} 件` : ""}`;
  const notDone = (items: string[], reason?: string) => phrase(verb, reason && verb === "没做成" ? [reason, ...items.slice(1)] : items);

  const told = checkedRemaining(view) ?? (declared.length ? declared : view.latestDelivery?.unfinished?.length ? view.latestDelivery.unfinished : null);

  if (view.state === "idle" && told?.length) return notDone(told);
  const unverifiedOnly = remaining.length > 0 && remaining.every((r) => unverifiedGoal(view, r));
  const listed = remaining.map((r) => r.description);
  const reason = view.failureReason;
  const left = told ? (told.length ? notDone(told) : null) : listed.length ? (unverifiedOnly && !reason ? phrase("还没确认完成", listed) : notDone(listed, reason)) : null;

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

function buildResumeSummary(view: TaskView | null, checkpointUnavailable = false, resumeNote: string | null = null): ResumeSummary {
  if (!view) {
    return { visible: false, tone: "running", headline: "", goal: null, revisions: [], done: [], remaining: [], blocking: null, interruptionDetail: null, nextStep: "", resume: { available: false, reason: null }, gaps: [], line: "", note: null };
  }

  const done = view.results.filter((r) => r.status === "satisfied").map((r) => ({ id: r.id, description: plainStep(r.description) }));
  const checkedDone = checkedRemaining(view)?.length === 0;

  const remaining = view.outstanding.filter((r) => !(checkedDone && unverifiedGoal(view, r)))
    .map((r) => ({ id: r.id, description: plainStep(r.description), status: r.status, statusLabel: unverifiedGoal(view, r) ? "还没核验" : resultStatusText(r.status) }));

  const tone = headlineFor(view, checkpointUnavailable, remaining.length);
  const unknown = remaining.filter((r) => r.status === "unknown").length;
  const blocked = remaining.filter((r) => r.status === "blocked").length;
  const interruptionDetail = view.waiting?.reason === "restart_checkpoint" ? view.waiting.detail : null;
  const blocking = view.waiting ? (interruptionDetail ? `${view.waiting.text}（${interruptionDetail}）` : view.waiting.text) : unknown ? "有 1 步结果未知，不会自己重做" : blocked ? "有 1 步没做成" : null;
  const resume = resumeAvailability(view, checkpointUnavailable);

  const nextStep = (() => {
    if (checkpointUnavailable) return "原任务无法接着做。原来的记录还在。新任务要另开一个会话。";

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

  const coveredByCheck = checkedDone && view.state === "idle";
  const waitingShows = !!view.waiting && !(coveredByCheck && CHECK_COVERS_WAITING.has(view.waiting.reason));

  const visible = checkpointUnavailable
    || ["interrupted", "error"].includes(view.state)
    || (view.state === "aborted" && (remaining.length > 0 || !!view.waiting))
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

interface ResumeEntryOptions {
  root: HTMLElement;
  sendResume: (request: TaskActionRequest) => boolean;
  getContext: () => Promise<PageContext | null>;
  newRequestId?: () => string;
  pendingTimeoutMs?: number;
}

const ELEMENT_TAG = "resume-entry";

const CHECK_HOLD_MS = 25_000;

export class ResumeEntry {
  private view: TaskView | null = null;
  private checkpointUnavailable = false;
  private note: string | null = null;
  private noteRunId: string | null = null;
  private pendingRequestId: string | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private checkHold: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: ResumeEntryOptions) {}

  apply(view: TaskView | null, options: { checkpointUnavailable?: boolean } = {}): void {
    if (this.disposed) return;
    this.view = view;
    this.checkpointUnavailable = options.checkpointUnavailable === true;

    if (this.pendingRequestId && view?.state === "running") this.clearPending();

    if (this.note && view && (view.runId !== this.noteRunId || view.state === "running")) this.note = null;
    this.rerender();
  }

  holdForCheck(on: boolean): void {
    if (this.checkHold) clearTimeout(this.checkHold);
    this.checkHold = on ? setTimeout(() => { this.checkHold = null; this.rerender(); }, CHECK_HOLD_MS) : null;
    this.rerender();
  }

  private rerender(): void {
    if (this.disposed) return;
    const summary = buildResumeSummary(this.view, this.checkpointUnavailable, this.note);
    this.render(this.checkHold && this.view?.state === "idle" ? { ...summary, visible: false } : summary);
  }

  clear(): void {
    this.clearPending();
    if (this.checkHold) clearTimeout(this.checkHold);
    this.checkHold = null;
    this.view = null;
    this.note = null;
    this.noteRunId = null;
    this.checkpointUnavailable = false;
    this.opts.root.hidden = true;
    this.opts.root.replaceChildren();
  }

  noteReceipt(receipt: { requestId: string; status: string; message?: string }): void {
    if (!this.pendingRequestId || receipt.requestId !== this.pendingRequestId) return;

    if (receipt.status === "accepted" || receipt.status === "applied" || receipt.status === "queued") {
      return;
    }

    this.clearPending();
    this.note = receipt.message?.trim() || (receipt.status === "rejected" ? "这次继续没有执行。" : "这次继续没有得到确认。");
    this.noteRunId = this.view?.runId ?? null;
    this.render(buildResumeSummary(this.view, this.checkpointUnavailable, this.note));
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
    "resume-entry .resume-action{flex:none;padding:3px 12px;border-radius:999px;border:1px solid var(--content-border,#ded8cd);background:transparent;color:var(--text-primary,#292821);font:inherit;font-size:12px;cursor:pointer;transition:background var(--d-micro) var(--e-enter),border-color var(--d-micro) var(--e-enter)}",
    "resume-entry .resume-action:hover:not([disabled]){background:var(--content-subtle,#ece7de)}",
    "resume-entry .resume-action:focus-visible{outline:2px solid var(--accent,#79523b);outline-offset:2px}",
    "resume-entry .resume-action[disabled]{opacity:.6;cursor:default}",
  ].join("");
  document.head.append(style);
}
