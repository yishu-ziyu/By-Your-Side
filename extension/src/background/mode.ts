/**
 * 教学模式状态：模块变量 + chrome.storage.session 持久化（SW 重启可恢复）。
 * teach = 教学倾向增强（prompt 层引导用户手动操作），执行层不再拦截任何工具。
 * 另含"有待完成教学标注"追踪：供步骤完成自动感知（tabs.onUpdated → page_event）判定。
 * 注意：模块顶层不触碰 chrome API，判定逻辑保持可单测。
 */
import type { AgentMode } from "../../../shared/protocol.js";

const STORAGE_KEY = "agentMode";

const modes = new Map<string, AgentMode>();
export async function getMode(conversationId = "default"): Promise<AgentMode> {
 const cached = modes.get(conversationId);
 if (cached) return cached;
 const storageKey = conversationId === "default" ? STORAGE_KEY : `${STORAGE_KEY}:${conversationId}`;
 let stored: Record<string, unknown> = {};
 try { stored = await chrome.storage.session.get(storageKey); } catch { /* Chrome session API may be unavailable. */ }
 // A runtime summary or explicit user change may arrive while storage is loading.
 const latest = modes.get(conversationId);
 if (latest) return latest;
 const mode = stored[storageKey] === "teach" ? "teach" : "act";
 modes.set(conversationId, mode);
 return mode;
}
export async function setMode(mode: AgentMode, conversationId = "default"): Promise<void> {
 modes.set(conversationId, mode);
 const storageKey = conversationId === "default" ? STORAGE_KEY : `${STORAGE_KEY}:${conversationId}`;
 try { await chrome.storage.session.set({[storageKey]:mode}); } catch { /* Keep local mode. */ }
}

// ── 手绘标注动效偏好（grow = 420ms 生长后定格；boil = 1200ms 持续微动） ──
export type MarkMotion = "grow" | "boil";
export const MARK_MOTION_KEY = "sideagent_mark_motion";

let cachedMotion: MarkMotion | undefined;

export async function getMarkMotion(): Promise<MarkMotion> {
  if (cachedMotion !== undefined) return cachedMotion;
  try {
    const got = await chrome.storage.local.get(MARK_MOTION_KEY);
    cachedMotion = got[MARK_MOTION_KEY] === "grow" ? "grow" : "boil";
  } catch {
    cachedMotion = "boil";
  }
  return cachedMotion;
}

export async function setMarkMotion(motion: MarkMotion): Promise<void> {
  cachedMotion = motion;
  try {
    await chrome.storage.local.set({ [MARK_MOTION_KEY]: motion });
  } catch {
    /* 存储失败不阻塞主流程 */
  }
}

// ── 有待完成教学标注追踪 ────────────────────────────────────────────
// mark 工具成功置 true；clear_marks / URL 变化（整页导航或 SPA pushState）置 false。
// 仅 teach 模式且有待完成标注时，URL 变化才视为"用户可能已完成步骤"并通知 agent。

const pendingTeachMarks = new Set<string>();

export function hasPendingTeachMarks(conversationId = "default"): boolean {
  return pendingTeachMarks.has(conversationId);
}

export function noteMarkDrawn(conversationId = "default"): void {
  pendingTeachMarks.add(conversationId);
}

export function noteMarksCleared(conversationId = "default"): void {
  pendingTeachMarks.delete(conversationId);
}

/**
 * working tab URL 变化时判定是否应通知 agent：teach 模式 + 有待完成标注 → true。
 * 无论命中与否都重置标记（整页导航标注随页面销毁；SPA 跳转由调用方负责清标注）。
 */
export function consumeTeachUrlChange(mode: AgentMode, conversationId = "default"): boolean {
  const hit = mode === "teach" && pendingTeachMarks.has(conversationId);
  pendingTeachMarks.delete(conversationId);
  return hit;
}
