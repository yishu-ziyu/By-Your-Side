import { plainError } from "./user-facing.js";
import type { TaskNextStep } from "./task-next-step.js";

type WaitingReason = Exclude<TaskNextStep["reason"], "in_flight" | "remaining" | "receipts_reviewed" | "open_task">;

const WAITING_TEXT: Record<WaitingReason, string> = {
  human_control: "页面现在归你，点「交还」后再接着做",
  restart_checkpoint: "任务中断了，说「继续」就接着做",
  cancelled: "你中止了任务，助手不会自己重新开始",
  failure_limit: "连续几步没做成，助手在等你决定",
  restricted_page: "浏览器不允许读取这一页，需要截图或文字",
  unknown_with_baseline: "有 1 步结果未知，助手先核验再继续",
  unknown_without_baseline: "有 1 步结果未知，助手没有改动前的记录，不会自己重做",
  readback_required: "做了，但助手还没核验",
  tool_failed: "上一步没做成，助手要换个做法",
  runtime_error: "出错了，助手只给你已确认的结果",
  condition_wait: "条件满足后自动继续",
  condition_invalid: "关注已暂停，需要核实原页面",
  deadline: "关注期限已到，已有结果保留",
  budget: "关注预算已用完，已有结果保留",
  continuation_stopped: "关注已中止，已有结果保留",
};

const INTERRUPTION_TEXT: Record<string, string> = {
  host_restart: "扩展后台重启了",
  connection_lost: "扩展后台断开了",
  manual_continuation: "你中止了任务",
};

export function waitingCopy(reason: WaitingReason, detail: string | null): { reason: WaitingReason; text: string; detail: string | null } {
  const shown = detail ? INTERRUPTION_TEXT[detail] ?? (plainError(detail, "") || null) : null;

  return { reason, text: WAITING_TEXT[reason], detail: shown };
}

const RESULT_TEXT: Record<string, string> = { pending: "还没做", blocked: "没做成", unknown: "结果未知", satisfied: "做完了" };

export function resultStatusText(status: string): string {
  return RESULT_TEXT[status] ?? "结果未知";
}
