/**
 * CAP-02A：网页 JavaScript dialog（alert/confirm/prompt/beforeunload）。
 * 不处理浏览器自己的权限/设备提示。
 */
import { LEAD_SESSION_ID, type ToolContract } from "../../../../shared/protocol.js";
import { ensureAttached } from "../debugger.js";
import { handleJsDialog, readDialogInfo } from "../page-events.js";
import { resolveWorkingTab } from "../state.js";

export async function acceptDialog(
  params: ToolContract["accept_dialog"]["params"],
  sessionId: string = LEAD_SESSION_ID,
): Promise<ToolContract["accept_dialog"]["data"]> {
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");
  await ensureAttached(tab.id);
  const result = await handleJsDialog(tab.id, true, params.promptText);

  const data: ToolContract["accept_dialog"]["data"] = { accepted: result.ok };

  if (result.dialog) data.dialog = result.dialog;

  return data;
}

export async function dismissDialog(
  params: ToolContract["dismiss_dialog"]["params"],
  sessionId: string = LEAD_SESSION_ID,
): Promise<ToolContract["dismiss_dialog"]["data"]> {
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");
  await ensureAttached(tab.id);
  const result = await handleJsDialog(tab.id, false);

  const data: ToolContract["dismiss_dialog"]["data"] = { dismissed: result.ok };

  if (result.dialog) data.dialog = result.dialog;

  return data;
}

export async function dialogInfo(
  params: ToolContract["dialog_info"]["params"],
  sessionId: string = LEAD_SESSION_ID,
): Promise<ToolContract["dialog_info"]["data"]> {
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");

  return readDialogInfo(tab.id);
}
