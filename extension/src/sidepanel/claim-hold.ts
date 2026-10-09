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

/** 一栏的显示名与值；敏感栏、读不回的返回 null（不显示）。key 区分同名的两栏（见 readbackKey）。 */
export function evidenceLine(readback: FieldReadback, key: string): { key: string; field: string; value: string } | null {
  if (readback.sensitive || readback.observed === undefined) return null;
  const value = readback.observed.replace(/\s+/g, " ").trim();

  return { key, field: readback.name || "这一栏", value: value.length > EVIDENCE_CLIP || readback.truncated ? `${value.slice(0, EVIDENCE_CLIP)}…` : value };
}

/** 读回与要写的对不上（网页没留住或改成了别的）：核对判做完也不能当做完显示（代码核对只能把通过改成不通过）。 */
export function readbackFailed(readback: FieldReadback): boolean {
  return readback.match === "not_held" || readback.match === "different";
}

/**
 * 一次读回属于哪一栏：填写的目标（ref 按元素稳定）加标签页。两栏同名（或都没名字）时不互相覆盖。
 * 没有目标（输入、程序里的填写）才按显示名。
 */
export function readbackKey(target: unknown, tab: string, readback: FieldReadback): string {
  return typeof target === "string" && target ? `${tab}\u0000${target}` : `name\u0000${readback.name || "这一栏"}`;
}

/** 工作标签页的代号：切换用标签页 id，新开的用那次调用的 id；别的动作不变。 */
export function nextWorkingTab(current: string, name: string, params: Record<string, unknown>, toolCallId: string): string {
  if (name !== "tabs") return current;

  if (params.action === "switch" && typeof params.tabId === "number") return `tab-${params.tabId}`;

  return params.action === "open" ? `open-${toolCallId}` : current;
}

/** 同一栏只留最新的值，最多 EVIDENCE_LINES 栏（最近写的在后）。 */
export function mergeEvidence<Line extends { key: string }>(lines: ReadonlyArray<Line>, next: Line): Line[] {
  return [...lines.filter(line => line.key !== next.key), next].slice(-EVIDENCE_LINES);
}

/** 一栏读回的最新结果：同一栏后来读回一致，之前的对不上就不再算。key 见 readbackKey。 */
export function latestReadbackFailed(latest: ReadonlyMap<string, boolean>): boolean {
  return [...latest.values()].some(Boolean);
}

/** 「核对发现」后面那句：核对写给用户的诊断；没有就说还差什么，再没有就说还没做完。 */
export function findingForUser(finding: string | undefined, remaining: string | undefined): string {
  const said = (finding ?? "").trim().replace(/[。.]$/, "");

  if (said) return said;
  const left = (remaining ?? "").trim().replace(/[。.]$/, "");

  return left ? `还差：${left}` : "还没做完";
}
