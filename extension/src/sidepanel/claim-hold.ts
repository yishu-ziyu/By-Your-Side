/**
 * 改过网页的一轮：回答扣到目标核对出结论再显示（docs/evals/20261009-claim-after-check.md R1、R2）。
 * 这里只放规则；扣住与放出的界面在 main.ts。
 */
import type { FieldReadback } from "../../../shared/protocol.js";

/** 核对一直没结论时最多扣这么久，然后先给回答并标「结果还没确认」。 */
export const CLAIM_HOLD_CAP_MS = 6_000;

/** 会改网页内容的动作。打开、切换标签页和页面标注不算：只读的查找任务照旧马上回答。 */
const CLAIM_HOLD_TOOLS = new Set(["click", "double_click", "fill", "type_text", "press_key", "select_option", "upload_file", "drag", "js"]);

export function holdsClaim(name: string, params: Record<string, unknown>): boolean {
  if (name === "js" && params.readonly === true) return false;

  return CLAIM_HOLD_TOOLS.has(name);
}

/** 记账类工具（交付、记忆、目标记账）：写完回答再调它们不算「接着做」，扣住的正文不因此放进过程。 */
export const CLAIM_BOOKKEEPING_TOOLS: ReadonlySet<string> = new Set(["send_user_message", "user_memory", "task_goals", "record_task_results"]);

/** 侧栏最多列几栏、每栏最多显示几个字。 */
const EVIDENCE_LINES = 3;
const EVIDENCE_CLIP = 80;

/** 一栏的显示名与值；敏感栏、读不回的返回 null（不显示）。 */
export function evidenceLine(readback: FieldReadback): { field: string; value: string } | null {
  if (readback.sensitive || readback.observed === undefined) return null;
  const value = readback.observed.replace(/\s+/g, " ").trim();

  return { field: readback.name || "这一栏", value: value.length > EVIDENCE_CLIP || readback.truncated ? `${value.slice(0, EVIDENCE_CLIP)}…` : value };
}

/** 读回与要写的对不上（网页没留住或改成了别的）：核对判做完也不能当做完显示（代码核对只能把通过改成不通过）。 */
export function readbackFailed(readback: FieldReadback): boolean {
  return readback.match === "not_held" || readback.match === "different";
}

/** 同一栏只留最新的值，最多 EVIDENCE_LINES 栏（最近写的在后）。 */
export function mergeEvidence(lines: ReadonlyArray<{ field: string; value: string }>, next: { field: string; value: string }): Array<{ field: string; value: string }> {
  return [...lines.filter(line => line.field !== next.field), next].slice(-EVIDENCE_LINES);
}
