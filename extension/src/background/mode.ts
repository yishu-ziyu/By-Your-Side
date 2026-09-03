/**
 * 教学模式状态：模块变量 + chrome.storage.session 持久化（SW 重启可恢复）。
 * teach = 教学倾向增强（prompt 层引导用户手动操作），执行层不再拦截任何工具。
 * 另含"有待完成教学标注"追踪：供步骤完成自动感知（tabs.onUpdated → page_event）判定。
 * 注意：模块顶层不触碰 chrome API，判定逻辑保持可单测。
 */
import type { AgentMode } from "../../../shared/protocol.js";

const STORAGE_KEY = "agentMode";

/** undefined = 尚未从 storage 加载 */
let cached: AgentMode | undefined;

export async function getMode(): Promise<AgentMode> {
  if (cached !== undefined) return cached;
  try {
    const got = await chrome.storage.session.get(STORAGE_KEY);
    cached = got[STORAGE_KEY] === "teach" ? "teach" : "act";
  } catch {
    cached = "act";
  }
  return cached;
}

export async function setMode(mode: AgentMode): Promise<void> {
  cached = mode;
  try {
    await chrome.storage.session.set({ [STORAGE_KEY]: mode });
  } catch {
    /* 存储失败不阻塞主流程 */
  }
}

// ── 有待完成教学标注追踪 ────────────────────────────────────────────
// mark 工具成功置 true；clear_marks / URL 变化（整页导航或 SPA pushState）置 false。
// 仅 teach 模式且有待完成标注时，URL 变化才视为"用户可能已完成步骤"并通知 agent。

let pendingTeachMarks = false;

export function hasPendingTeachMarks(): boolean {
  return pendingTeachMarks;
}

export function noteMarkDrawn(): void {
  pendingTeachMarks = true;
}

export function noteMarksCleared(): void {
  pendingTeachMarks = false;
}

/**
 * working tab URL 变化时判定是否应通知 agent：teach 模式 + 有待完成标注 → true。
 * 无论命中与否都重置标记（整页导航标注随页面销毁；SPA 跳转由调用方负责清标注）。
 */
export function consumeTeachUrlChange(mode: AgentMode): boolean {
  const hit = mode === "teach" && pendingTeachMarks;
  pendingTeachMarks = false;
  return hit;
}
