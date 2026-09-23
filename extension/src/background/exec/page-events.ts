/**
 * CAP-02A RPC：arm / wait / disarm / consume_events。
 */
import { LEAD_SESSION_ID, type ToolContract } from "../../../../shared/protocol.js";
import { resolveWorkingTab } from "../state.js";
import { ensureAttached, holdAttach, releaseAttachHold } from "../debugger.js";
import {
  armEventForTab,
  bindAttachHolds,
  consumeTabEvents,
  disarmArmedEvent,
  waitArmedEvent,
} from "../page-events.js";

bindAttachHolds(holdAttach, releaseAttachHold);

export async function armEvent(
  params: ToolContract["arm_event"]["params"],
  sessionId: string = LEAD_SESSION_ID,
): Promise<ToolContract["arm_event"]["data"]> {
  const tab = await resolveWorkingTab(params.tabId, sessionId);
  if (tab.id == null) throw new Error("工作标签页无效");
  const type = params.type;
  if (type !== "popup" && type !== "download" && type !== "filechooser") {
    throw new Error("INVALID_ARGUMENT: arm_event.type must be popup|download|filechooser");
  }
  await ensureAttached(tab.id);
  const arm = await armEventForTab({
    tabId: tab.id,
    sessionKey: sessionId,
    type,
    timeoutMs: params.timeoutMs,
    downloadPath: params.downloadPath,
  });
  return {
    token: arm.token,
    type,
    tabId: arm.tabId,
    timeoutMs: arm.timeoutMs,
    ...(arm.downloadPath ? { downloadPath: arm.downloadPath } : {}),
  };
}

export async function waitEvent(
  params: ToolContract["wait_event"]["params"],
  _sessionId: string = LEAD_SESSION_ID,
): Promise<ToolContract["wait_event"]["data"]> {
  const payload = await waitArmedEvent(params.token, params.timeoutMs);
  const type = payload.kind as "popup" | "download" | "filechooser";
  const tabId = Number(payload.tabId);
  const base = { token: String(payload.token), type, tabId };
  if (type === "popup") {
    const popupTabId = Number(payload.popupTabId);
    return {
      ...base,
      popup: {
        tabId: popupTabId,
        url: typeof payload.url === "string" ? payload.url : undefined,
        targetId: typeof payload.targetId === "string" ? payload.targetId : undefined,
        label: `tab:${popupTabId}`,
      },
    };
  }
  if (type === "download") {
    return {
      ...base,
      download: {
        downloadId: String(payload.downloadId),
        url: String(payload.url ?? ""),
        suggestedFilename: String(payload.suggestedFilename ?? ""),
        tabId,
        failure: (payload.failure as string | null) ?? null,
        completed: Boolean(payload.completed),
      },
    };
  }
  return {
    ...base,
    fileChooser: {
      chooserId: String(payload.chooserId),
      multiple: Boolean(payload.multiple),
      backendNodeId: Number(payload.backendNodeId),
    },
  };
}

export async function disarmEvent(
  params: ToolContract["disarm_event"]["params"],
  _sessionId: string = LEAD_SESSION_ID,
): Promise<ToolContract["disarm_event"]["data"]> {
  const arm = await disarmArmedEvent(params.token);
  return { disarmed: true, token: arm.token, status: arm.status };
}

export async function consumeEvents(
  params: ToolContract["consume_events"]["params"],
  sessionId: string = LEAD_SESSION_ID,
): Promise<ToolContract["consume_events"]["data"]> {
  const tab = await resolveWorkingTab(params.tabId, sessionId);
  if (tab.id == null) throw new Error("工作标签页无效");
  return consumeTabEvents(tab.id, params.clear !== false);
}
