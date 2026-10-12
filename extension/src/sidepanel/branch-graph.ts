/**
 * 过程块分叉：同一模型轮里同时做的几件事画成一组，做完再折成一行。
 * 只判断该不该画、画哪种；DOM 在 branch-view.ts。
 * 规格：#263 2026-10-12 评论（B1 竖向 + B3 扇形 + 你的泳道）。
 */

export const FORK_MS = 450;
export const FORK_STAGGER_MS = 70;
export const MERGE_MS = 450;
export const FOLD_HOLD_MS = 700;
export const FOLD_MS = 550;
export const MAX_LANES = 5;
export const MAX_TABS = 6;
export const PROCESS_MAX_PX = 176;
export const ROW_PX = 22;

export type GraphKind = "b1" | "b3" | "you";
export type LaneState = "running" | "done" | "dead";

export type GraphTool = {
  id: string;
  name: string;
  params: Record<string, unknown>;
  label: string;
  url?: string;
  host?: string;
  failed?: boolean;
  reason?: string;
  result?: string;
};

export function isLocalHost(host: string): boolean {
  const name = host.replace(/:\d+$/, "").toLowerCase();

  return name === "localhost" || name === "0.0.0.0" || name === "::1" || name.startsWith("127.") || /^(\d{1,3}\.){3}\d{1,3}$/.test(name);
}

export function hostOfUrl(url: unknown): string | null {
  if (typeof url !== "string" || !url) return null;

  try {
    const host = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).host.replace(/^www\./, "");

    return isLocalHost(host) ? null : host;
  } catch {
    return null;
  }
}

export function isTabFanTool(name: string, params: Record<string, unknown>): boolean {
  if (name === "open_tab") return true;
  if (name === "tabs") return params.action === "open" || params.action === "switch";
  if (name === "snapshot" || name === "read_element" || name === "read_elements") return typeof params.tabId === "number";

  return false;
}

export function classifyKind(tools: readonly GraphTool[]): GraphKind | null {
  if (tools.length < 2) return null;
  if (tools.every((tool) => isTabFanTool(tool.name, tool.params))) return "b3";

  return "b1";
}

export function clipReason(reason: string): string {
  const text = reason.replace(/\s+/g, " ").trim();

  return text.length <= 16 ? text : `${text.slice(0, 15)}…`;
}

/** 汇合后那一行：查了几路、几路没成。 */
export function groupSummary(kind: GraphKind, tools: readonly GraphTool[]): string {
  if (kind === "you") return "你交还了";
  const dead = tools.filter((tool) => tool.failed).length;
  const live = tools.length - dead;

  if (kind === "b3") {
    const tail = dead ? ` · ${dead} 页没打开` : "";

    return `开了 ${live} 个标签页${tail}`;
  }

  const tail = dead ? ` · ${dead} 个接口没回` : "";

  return `查了 ${live} 路${tail}`;
}

export function reducedMotion(): boolean {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}
