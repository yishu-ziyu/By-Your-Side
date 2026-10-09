/**
 * 改过网页的一轮：侧栏摆出填写后这一栏的实际内容（docs/evals/20261009-claim-after-check.md R1），核对判继续时说发现了什么。
 * 回答不再扣到核对出结论（10-10 起，docs/evals/20261010-drop-blocking-labels.md）。界面在 main.ts。
 */
import type { FieldReadback } from "../../../shared/protocol.js";

/** 侧栏最多列几栏、每栏最多显示几个字。 */
const EVIDENCE_LINES = 3;
const EVIDENCE_CLIP = 80;

/** 一栏的显示名与值；敏感栏、读不回的返回 null（不显示）。key 区分同名的两栏（见 readbackKey）。 */
export function evidenceLine(readback: FieldReadback, key: string): { key: string; field: string; value: string } | null {
  if (readback.sensitive || readback.observed === undefined) return null;
  const value = readback.observed.replace(/\s+/g, " ").trim();

  return { key, field: readback.name || "这一栏", value: value.length > EVIDENCE_CLIP || readback.truncated ? `${value.slice(0, EVIDENCE_CLIP)}…` : value };
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

/** 「核对发现」后面那句：核对写给用户的诊断；没有就说还差什么，再没有就说还没做完。 */
export function findingForUser(finding: string | undefined, remaining: string | undefined): string {
  const said = (finding ?? "").trim().replace(/[。.]$/, "");

  if (said) return said;
  const left = (remaining ?? "").trim().replace(/[。.]$/, "");

  return left ? `还差：${left}` : "还没做完";
}
