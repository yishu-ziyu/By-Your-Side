/**
 * 观察（background 侧）：开关、注入、攒证据、挑出值得问用户的候选。
 *
 * 纪律（见 docs/devlog/20260911-01）：
 *   - 默认关；打开后才注入，关掉立刻停止并清掉未成的片断；
 *   - 证据有界：每个站点留最近常用的若干条，站点数有上限，整体字节有预算（配额教训）；
 *   - 不问就不跑：这里只产出候选，是否生成技能由用户在面板上点头。
 */
import { mergeRun, trimPatterns, candidates, type ObservedPattern, type ObservedRun } from "../../../shared/observe.js";

export const OBSERVE_KEY = "sideagent_observe";
const PATTERNS_KEY = "sideagent_observed_patterns";
/** 整体预算：观察不能变成第二个配额事故。 */
const MAX_BYTES = 16_000;

let cached: boolean | null = null;
let patterns: ObservedPattern[] | null = null;

export async function isObserving(): Promise<boolean> {
  if (cached !== null) return cached;
  try {
    const stored = await chrome.storage.local.get(OBSERVE_KEY);
    cached = stored[OBSERVE_KEY] === true;
  } catch {
    cached = false; // 读不到就当关着：观察必须显式开启
  }
  return cached;
}

export async function setObserving(on: boolean): Promise<void> {
  cached = on;
  try { await chrome.storage.local.set({ [OBSERVE_KEY]: on }); } catch { /* 存不下也不改变本次行为 */ }
  if (!on) await clearPatterns();
  else for (const tabId of await activeTabIds()) await injectObserver(tabId);
}

export function resetObserveForTests(): void {
  cached = null;
  patterns = null;
}

async function activeTabIds(): Promise<number[]> {
  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return active?.id == null ? [] : [active.id];
  } catch {
    return [];
  }
}

/** 只观察用户正在看的那一页；不注入、不轮询全部标签页。 */
export async function injectObserver(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content-observe.js"], world: "ISOLATED" });
    await chrome.scripting.executeScript({
      target: { tabId }, world: "ISOLATED",
      func: () => window.__sideagent?.observe?.start?.() ?? { ok: false },
    });
  } catch {
    /* chrome:// 之类注入不了：跳过 */
  }
}

export async function stopObserver(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId }, world: "ISOLATED",
      func: () => window.__sideagent?.observe?.stop?.() ?? { ok: false },
    });
  } catch {
    /* 页面已经没了 */
  }
}

/** 面板动作 → 状态变更（含开关、候选处置）。`accept` 必须消费候选，否则下次还会问同一件事。 */
export async function applyObserveAction(
  action: "on" | "off" | "list" | "dismiss" | "accept",
  signature?: string,
  hostname?: string,
): Promise<void> {
  if (action === "accept") {
    if (signature && hostname) await consumeCandidate(signature, hostname);
    return;
  }
  if (action === "dismiss") {
    if (signature && hostname) await dismissCandidate(signature, hostname);
    return;
  }
  if (action === "on") { await setObserving(true); return; }
  if (action === "off") {
    try {
      for (const tab of await chrome.tabs.query({ active: true })) if (tab.id != null) await stopObserver(tab.id);
    } catch {
      /* 受限环境：至少把开关落下去 */
    }
    await setObserving(false);
  }
}

async function load(): Promise<ObservedPattern[]> {
  if (patterns) return patterns;
  try {
    const stored = await chrome.storage.local.get(PATTERNS_KEY);
    const raw = stored[PATTERNS_KEY];
    patterns = Array.isArray(raw) ? (raw as ObservedPattern[]).filter(p => p && typeof p.signature === "string" && Array.isArray(p.anchors)) : [];
  } catch {
    patterns = [];
  }
  return patterns;
}

async function persist(next: ObservedPattern[]): Promise<void> {
  const trimmed = trimPatterns(next);
  let saved = trimmed;
  // 按 UTF-8 字节收敛（不是字符数）：中文一个字算三字节
  while (saved.length > 1 && new TextEncoder().encode(JSON.stringify(saved)).length > MAX_BYTES) saved = saved.slice(0, saved.length - 1);
  patterns = saved;
  try { await chrome.storage.local.set({ [PATTERNS_KEY]: saved }); } catch { /* 写不下就不写，内存里仍然可用 */ }
}

export async function recordRun(run: ObservedRun): Promise<void> {
  if (!(await isObserving())) return;
  const next = mergeRun(await load(), run);
  await persist(next);
}

export async function listCandidates(): Promise<ObservedPattern[]> {
  return candidates(await load());
}

export async function dismissCandidate(signature: string, hostname: string): Promise<void> {
  const next = (await load()).map(p => (p.signature === signature && p.hostname === hostname ? { ...p, dismissed: true as const } : p));
  await persist(next);
}

/** 生成技能后清掉候选：同一件事不再问第二遍。 */
export async function consumeCandidate(signature: string, hostname: string): Promise<void> {
  const next = (await load()).filter(p => !(p.signature === signature && p.hostname === hostname));
  await persist(next);
}

async function clearPatterns(): Promise<void> {
  patterns = [];
  try { await chrome.storage.local.remove(PATTERNS_KEY); } catch { /* 已经不在 */ }
}

/** 供测试与审计：当前模式条数。 */
export async function patternCount(): Promise<number> {
  return (await load()).length;
}
