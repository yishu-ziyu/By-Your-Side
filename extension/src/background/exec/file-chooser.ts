/**
 * CAP-02A：动态 file chooser 设文件。
 * 必须走 TaskUploadLedger / authorizeUploadPaths（宿主侧）；扩展只收已授权绝对路径。
 */
import { LEAD_SESSION_ID, type ToolContract } from "../../../../shared/protocol.js";
import { ensureAttached } from "../debugger.js";
import { getChooserArmById, readDialogInfo } from "../page-events.js";
import { resolveWorkingTab } from "../state.js";
import { setFilesOnBackendNodeId } from "./upload.js";

export async function fileChooserSetFiles(
  params: ToolContract["file_chooser_set_files"]["params"],
  sessionId: string = LEAD_SESSION_ID,
): Promise<ToolContract["file_chooser_set_files"]["data"]> {
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");
  await ensureAttached(tab.id);

  const arm = getChooserArmById(params.chooserId);

  if (arm.tabId !== tab.id) {
    throw new Error("INVALID_ARGUMENT: file chooser does not belong to the working tab");
  }

  if (typeof arm.backendNodeId !== "number") {
    throw new Error("INVALID_ARGUMENT: file chooser has no backendNodeId");
  }

  const paths = Array.isArray(params.paths) ? params.paths : [];
  const files = await setFilesOnBackendNodeId(tab.id, arm.backendNodeId, paths);
  const dialog = readDialogInfo(tab.id).dialog;

  const data: ToolContract["file_chooser_set_files"]["data"] = {
    set: true,
    multiple: Boolean(arm.multiple),
    files,
  };

  if (dialog) data.dialog = dialog;

  return data;
}
