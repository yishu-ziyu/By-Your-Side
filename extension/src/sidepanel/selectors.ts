/**
 * Panel selectors: conversation state labels and the result card copy.
 */
import type { ConversationSummary } from '../../../shared/protocol.js';
import type { TaskHistoryEntry } from '../../../shared/task-history.js';

type ConversationOutcomeKind = "done" | "waiting" | "stopped" | "error" | "running" | "new";

interface ConversationOutcome {
  kind: ConversationOutcomeKind;
  icon: string;
  line: string;
}

/** 会话列表一行的结局：先说状态，不写「空闲」。 */
export function conversationOutcome(
  c: Pick<ConversationSummary, "state" | "checkpoint" | "ending" | "title">,
  extra?: { completed?: boolean; task?: Pick<TaskHistoryEntry, "outcome" | "done" | "unfinished" | "next"> },
): ConversationOutcome {
  if (c.checkpoint === "unavailable") return { kind: "error", icon: "!", line: c.ending || "恢复失败" };
  if (c.checkpoint === "interrupted") return { kind: "stopped", icon: "‖", line: c.ending || "任务中断了" };
  // ending 是上一轮的结局，新一轮开始时不清；进行中照它写，会把正在做的事说成做完了。
  if (c.state === "running") return { kind: "running", icon: "·", line: "正在做" };
  if (c.state === "user") return { kind: "waiting", icon: "●", line: extra?.task?.next || c.ending || "页面现在归你" };

  const task = extra?.task;
  if (task?.outcome === "error") return { kind: "error", icon: "!", line: c.ending || "上次出错" };
  if (task?.outcome === "stopped") return { kind: "stopped", icon: "‖", line: c.ending || "你中止了任务" };
  if (task?.outcome === "partial") return { kind: "stopped", icon: "‖", line: c.ending || task.unfinished[0] || "上次没做完" };
  if (c.ending) {
    if (/出错|失败/.test(c.ending)) return { kind: "error", icon: "!", line: c.ending };
    if (/中止|中断|没做完/.test(c.ending)) return { kind: "stopped", icon: "‖", line: c.ending };

    return { kind: "done", icon: "✓", line: c.ending };
  }
  if (task?.outcome === "complete") return { kind: "done", icon: "✓", line: task.done || "做完了" };
  if (extra?.completed) return { kind: "done", icon: "✓", line: "做完了" };
  if (c.title) return { kind: "new", icon: "", line: "" };

  return { kind: "new", icon: "", line: "" };
}

export function conversationDayGroup(at: number, now: number): "今天" | "昨天" | "更早" {
  const day = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const days = Math.round((day(now) - day(at)) / 86_400_000);

  return days <= 0 ? "今天" : days === 1 ? "昨天" : "更早";
}

export function conversationRelativeTime(at: number, now: number): string {
  const sec = Math.max(0, Math.round((now - at) / 1000));

  if (sec < 60) return "刚才";
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`;

  return conversationDayGroup(at, now);
}

export function conversationBackgroundLabel(c: Pick<ConversationSummary, 'state' | 'checkpoint'>): string {
  if (c.checkpoint === 'unavailable') {
    return '恢复失败，未执行';
  }

  if (c.checkpoint === 'interrupted') {
    return '已中断，可继续';
  }

  if (c.state === 'running') {
    return '正在运行';
  }

  if (c.state === 'user') {
    return '现在归你';
  }

  return '另一个会话的任务结束了';
}

/** 会话切换器里：说清这是别的任务，不要写成当前对话断了。 */
export function otherTaskCopy(count: number, title: string): { line: string; action: string } {
  const name = title.trim() || "未命名任务";
  return {
    line: count > 1 ? `另有 ${count} 个任务还没做完，最近一件：「${name}」` : `另有 1 个任务还没做完：「${name}」`,
    action: "继续",
  };
}

/** 结果卡：摘要是主信息，剩余项和声音失败弱化。没有摘要时整张卡不出现。 */
export function resultCardCopy(opts: {
  summary: string | null;
  remaining?: string[];
  unknown?: boolean;
  speechFailed?: boolean;
}): {
  visible: boolean;
  primary: string;
  secondary: string;
} {
  const summary = (opts.summary ?? "").trim();
  const remaining = (opts.remaining ?? []).map((item) => item.trim()).filter(Boolean);

  if (!summary && !remaining.length && !opts.unknown && !opts.speechFailed) {
    return { visible: false, primary: "", secondary: "" };
  }

  let primary: string;

  if (summary) {
    primary = summary;
  } else if (opts.unknown) {
    primary = "这次结果未知";
  } else if (remaining.length) {
    primary = `还剩${remaining.join("、")}`;
  } else {
    primary = "";
  }

  const extra: string[] = [];

  if (summary && remaining.length) {
    extra.push(`还剩${remaining.join("、")}`);
  }

  if (opts.speechFailed) {
    extra.push("声音未完成，文字仍可查看");
  }

  return { visible: primary.length > 0 || extra.length > 0, primary, secondary: extra.join(" · ") };
}
