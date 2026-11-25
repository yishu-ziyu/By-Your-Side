import type { PageTransformAction, SkimPoint } from "../../../../shared/page-phase2.js";
import { LEAD_SESSION_ID } from "../../../../shared/protocol.js";
import { cssPathOf } from "../../shared/css-path.js";
import { parseTarget } from "../../shared/target.js";
import { axBackendNodeFor } from "../axstate.js";
import { resolveWorkingTab } from "../state.js";
import { callOnBackendNode, notExecuted, type DispatchGuard } from "./page-call.js";

const LAST_PAGE_TRANSFORM_KEY = "bys_last_page_transform";

async function cssSelectorOf(tabId: number, target: string): Promise<string> {
  const parsed = parseTarget(target);
  if (parsed?.kind === "loc") return parsed.sel;
  if (parsed?.kind !== "ref") return target;
  const backendNodeId = axBackendNodeFor(tabId, parsed.n);
  if (backendNodeId === undefined) throw notExecuted(new Error(`ref @${parsed.n} 不在这一页最新的快照里，未执行。请先 snapshot 再用新的 ref，或改传 CSS 选择器。`));
  return callOnBackendNode<string>(tabId, backendNodeId, `function() { return (${cssPathOf.toString()})(this); }`);
}

async function rememberTransform(url: string, actions: PageTransformAction[]): Promise<void> {
  const stored = await chrome.storage.local.get(LAST_PAGE_TRANSFORM_KEY);
  const last = stored[LAST_PAGE_TRANSFORM_KEY] as { url?: string; payload?: { actions?: PageTransformAction[] } } | undefined;
  const earlier = last?.url === url && Array.isArray(last.payload?.actions) ? last.payload.actions : [];
  const seen = new Set<string>();
  const merged = [...earlier, ...actions].filter((action) => {
    const key = JSON.stringify(action);
    return seen.has(key) ? false : (seen.add(key), true);
  });
  await chrome.storage.local.set({
    [LAST_PAGE_TRANSFORM_KEY]: { url, name: "整理当前页", payload: { kind: "page_transform", actions: merged }, at: Date.now() },
  });
}

export async function pageSkimTool(
  params: { tabId?: number; points?: SkimPoint[]; clear?: boolean },
  sessionId: string = LEAD_SESSION_ID,
  beforeDispatch?: DispatchGuard,
): Promise<{ ok: boolean; matched?: number; missed?: string[]; cleared?: boolean }> {
  await beforeDispatch?.();
  const tab = await resolveWorkingTab(params.tabId, sessionId);
  if (tab.id == null) throw new Error("工作标签页无效");
  if (params.clear === true) {
    await chrome.tabs.sendMessage(tab.id, { type: "bys_page_skim_clear" });
    return { ok: true, cleared: true };
  }
  const points = Array.isArray(params.points) ? params.points : [];
  const res = (await chrome.tabs.sendMessage(tab.id, { type: "bys_page_skim", points })) as { ok?: boolean; matched?: number; missed?: string[] } | undefined;
  return { ok: Boolean(res?.ok), matched: res?.matched ?? 0, missed: Array.isArray(res?.missed) ? res.missed : [] };
}

export async function pageTransformTool(
  params: { tabId?: number; actions?: PageTransformAction[]; restore?: boolean },
  sessionId: string = LEAD_SESSION_ID,
  beforeDispatch?: DispatchGuard,
): Promise<{ ok: boolean; affected?: number; report?: string[]; count?: number; restored?: number }> {
  await beforeDispatch?.();
  const tab = await resolveWorkingTab(params.tabId, sessionId);
  if (tab.id == null) throw new Error("工作标签页无效");
  const tabId = tab.id;
  if (params.restore === true) {
    const res = (await chrome.tabs.sendMessage(tabId, { type: "bys_page_transform_restore" })) as { ok?: boolean; restored?: number } | undefined;
    void chrome.storage.local.remove(LAST_PAGE_TRANSFORM_KEY).catch(() => {});
    return { ok: Boolean(res?.ok), restored: res?.restored ?? 0 };
  }
  const actions = await Promise.all((Array.isArray(params.actions) ? params.actions : []).map(async (action) => ({ ...action, selector: await cssSelectorOf(tabId, action.selector) })));
  const res = (await chrome.tabs.sendMessage(tabId, { type: "bys_page_transform_apply", actions })) as { ok?: boolean; affected?: number; counts?: number[]; report?: string[]; count?: number } | undefined;
  const counts = Array.isArray(res?.counts) ? res.counts : [];
  const effective = actions.filter((_, i) => (counts[i] ?? 0) > 0);
  if (effective.length > 0 && tab.url) void rememberTransform(tab.url, effective).catch(() => {});
  return { ok: Boolean(res?.ok), affected: res?.affected ?? 0, report: Array.isArray(res?.report) ? res.report : [], count: res?.count ?? 0 };
}
