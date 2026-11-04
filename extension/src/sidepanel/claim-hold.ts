import type { FieldReadback } from "../../../shared/protocol.js";

const EVIDENCE_LINES = 3;
const EVIDENCE_CLIP = 80;

export function evidenceLine(readback: FieldReadback, key: string): { key: string; field: string; value: string } | null {
  if (readback.sensitive || readback.observed === undefined) return null;
  const value = readback.observed.replace(/\s+/g, " ").trim();

  return { key, field: readback.name || "这一栏", value: value.length > EVIDENCE_CLIP || readback.truncated ? `${value.slice(0, EVIDENCE_CLIP)}…` : value };
}

export function readbackKey(target: unknown, tab: string, readback: FieldReadback): string {
  return typeof target === "string" && target ? `${tab}\u0000${target}` : `name\u0000${readback.name || "这一栏"}`;
}

export function nextWorkingTab(current: string, name: string, params: Record<string, unknown>, toolCallId: string): string {
  if (name !== "tabs") return current;

  if (params.action === "switch" && typeof params.tabId === "number") return `tab-${params.tabId}`;

  return params.action === "open" ? `open-${toolCallId}` : current;
}

export function mergeEvidence<Line extends { key: string }>(lines: ReadonlyArray<Line>, next: Line): Line[] {
  return [...lines.filter(line => line.key !== next.key), next].slice(-EVIDENCE_LINES);
}

export function checkNoteForUser(finding: string | undefined, remaining: string | undefined): string {
  const said = (finding ?? "").trim().replace(/[。.]$/, "");

  if (said) return `核对发现：${said}`;
  const left = (remaining ?? "").trim().replace(/[。.]$/, "");

  return left ? `还差：${left}` : "核对发现还没做完";
}
