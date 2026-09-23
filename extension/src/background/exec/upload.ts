/**
 * `upload_file` 工具：给唯一 <input type=file> 设置文件（CDP DOM.setFileInputFiles），
 * 以读回的 files 列表为证；不点系统文件选择器、不给模型任意磁盘读取能力。
 * 路径授权在宿主侧共同 call 边界完成；扩展侧只做字符串防线并如实读回。
 *
 * 事件策略：先观察 Chrome 在 setFileInputFiles 后是否已派发 input/change；
 * 仅在缺失时补发一次，禁止无条件双发。
 *
 * CAP-02A：动态 chooser 复用 setFilesOnObjectId / setFilesOnBackendNodeId，
 * 仍走同一授权路径，禁止 raw cdp 绕过。
 */
import { assertObservedDocument, withObservedDocumentIdentity } from "../observation-document.js";
import { LEAD_SESSION_ID, type ToolContract } from "../../../../shared/protocol.js";
import { parseTarget, resolveArgs, resolveTargetSelector } from "../../shared/target.js";
import { isAxRef } from "../axstate.js";
import { sendCommand } from "../debugger.js";
import { resolveWorkingTab } from "../state.js";
import { beginEffect, collectEffect } from "./effect.js";
import { notExecuted } from "./input.js";

const MAX_FILES = 8;

/** 用对象 id 执行函数（this = 目标元素）；调用方负责释放对象。 */
async function callWithObject<T>(tabId: number, objectId: string, declaration: string, args: unknown[] = []): Promise<T> {
  const result = await sendCommand<{
    result?: { value?: T };
    exceptionDetails?: { exception?: { description?: string }; text?: string };
  }>(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: declaration,
    arguments: args.map((value) => ({ value })),
    returnByValue: true,
  });

  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "页面内执行失败");
  }

  return result.result?.value as T;
}

/** 已授权 paths → 对 objectId 设文件并读回；供 upload_file 与动态 chooser 共用。 */
export async function setFilesOnObjectId(
  tabId: number,
  objectId: string,
  paths: string[],
): Promise<Array<{ name: string; size: number }>> {
  const clearing = paths.length === 0;

  for (const raw of paths) {
    if (typeof raw !== "string" || !raw.startsWith("/") || raw.includes("..") || raw.includes("\0")) {
      throw notExecuted(new Error(`文件路径必须是不含 .. 的绝对路径（授权目录内）：${String(raw).slice(0, 200)}`));
    }
  }

  if (paths.length > MAX_FILES) {
    throw notExecuted(new Error(`最多 ${MAX_FILES} 个文件，未执行`));
  }

  await callWithObject<true>(tabId, objectId, `function(fileCount) {
    const el = this;
    if (!el || !el.isConnected) throw new Error("目标已失效，上传未执行。请重新 snapshot。");
    const tag = String(el.tagName || "").toLowerCase();
    const type = String((el.getAttribute && el.getAttribute("type")) || "").toLowerCase();
    if (tag !== "input" || type !== "file") throw new Error("目标不是 <input type=file>，上传未执行。请用唯一 CSS、xpath= 或 text= 定位文件输入框。");
    if (el.disabled) throw new Error("文件输入框不可用（disabled），上传未执行。");
    if (fileCount > 1 && !el.multiple) throw new Error("目标不支持 multiple，不能一次设置多个文件，上传未执行。");
    return true;
  }`, [paths.length]);

  await callWithObject<true>(tabId, objectId, `function() {
    const el = this;
    el.__bysUploadCounts = { input: 0, change: 0 };
    const counts = el.__bysUploadCounts;
    el.__bysUploadOnInput = function() { counts.input += 1; };
    el.__bysUploadOnChange = function() { counts.change += 1; };
    el.addEventListener("input", el.__bysUploadOnInput);
    el.addEventListener("change", el.__bysUploadOnChange);
    return true;
  }`);

  if (clearing) {
    await callWithObject<true>(tabId, objectId, `function() {
      const el = this;
      el.files = new DataTransfer().files;
      return true;
    }`);
  } else {
    await sendCommand(tabId, "DOM.setFileInputFiles", { files: paths, objectId });
  }

  return callWithObject<Array<{ name: string; size: number }>>(tabId, objectId, `function(expectClear) {
    const el = this;
    const counts = el.__bysUploadCounts || { input: 0, change: 0 };
    if (counts.input < 1) el.dispatchEvent(new Event("input", { bubbles: true }));
    if (counts.change < 1) el.dispatchEvent(new Event("change", { bubbles: true }));
    if (el.__bysUploadOnInput) el.removeEventListener("input", el.__bysUploadOnInput);
    if (el.__bysUploadOnChange) el.removeEventListener("change", el.__bysUploadOnChange);
    try { delete el.__bysUploadCounts; delete el.__bysUploadOnInput; delete el.__bysUploadOnChange; } catch (_) {}
    const list = [];
    const fileList = el.files;
    if (fileList) {
      for (let i = 0; i < fileList.length; i++) list.push({ name: String(fileList[i].name), size: Number(fileList[i].size) });
    }
    if (!expectClear && list.length === 0) {
      throw new Error("读回 0 个文件，上传未生效。请确认目标是 <input type=file> 且文件在授权目录内。");
    }
    if (expectClear && list.length !== 0) {
      throw new Error("清空后读回仍有文件，未生效。");
    }
    return list;
  }`, [clearing]);
}

/** 动态 chooser：backendNodeId → objectId → 同一设文件路径。 */
export async function setFilesOnBackendNodeId(
  tabId: number,
  backendNodeId: number,
  paths: string[],
): Promise<Array<{ name: string; size: number }>> {
  const resolved = await sendCommand<{ object?: { objectId?: string } }>(tabId, "DOM.resolveNode", { backendNodeId });
  const objectId = resolved.object?.objectId;

  if (!objectId) throw notExecuted(new Error("file chooser 目标无法解析，上传未执行"));

  try {
    return await setFilesOnObjectId(tabId, objectId, paths);
  } finally {
    await sendCommand(tabId, "Runtime.releaseObject", { objectId }).catch(() => { /* 已释放 */ });
  }
}

export async function uploadFile(
  params: ToolContract["upload_file"]["params"],
  sessionId: string = LEAD_SESSION_ID,
): Promise<ToolContract["upload_file"]["data"]> {
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");
  await assertObservedDocument(tab.id, sessionId);
  const tabId = tab.id;

  const paths = params.paths;

  if (!Array.isArray(paths) || paths.length > MAX_FILES) {
    throw notExecuted(new Error(`upload_file 需要 0–${MAX_FILES} 个 paths，未执行`));
  }

  for (const raw of paths) {
    if (typeof raw !== "string" || !raw.startsWith("/") || raw.includes("..") || raw.includes("\0")) {
      throw notExecuted(new Error(`文件路径必须是不含 .. 的绝对路径（授权目录内）：${String(raw).slice(0, 200)}`));
    }
  }

  const parsed = parseTarget(params.target);

  if (!parsed) throw notExecuted(new Error(`无效的 target: ${String(params.target).slice(0, 200)}`));

  const observed = await withObservedDocumentIdentity(tabId, sessionId, async () => {
    const effectToken = await beginEffect(tabId, {});
    let objectId: string | undefined;

    if (parsed.kind === "ref") {
      if (!isAxRef(tabId, parsed.n)) {
        throw notExecuted(new Error(
          "upload_file 的 @ref 只支持 full_page（AX）快照的 ref；视口 DOM ref 无法经 CDP 定位，请改用唯一 CSS、xpath= 或 text=。",
        ));
      }

      const resolved = await sendCommand<{ object?: { objectId?: string } }>(tabId, "DOM.resolveNode", { backendNodeId: parsed.n });
      objectId = resolved.object?.objectId;

      if (!objectId) throw notExecuted(new Error("ref 目标无法解析（页面可能已变化），上传未执行"));
    } else {
      const args = resolveArgs(parsed);
      const expression = `(${resolveTargetSelector.toString()})(${JSON.stringify(args.kind)}, ${JSON.stringify(args.selector)})`;

      const evaluated = await sendCommand<{
        result?: { objectId?: string };
        exceptionDetails?: { exception?: { description?: string }; text?: string };
      }>(tabId, "Runtime.evaluate", { expression, returnByValue: false });

      if (evaluated.exceptionDetails) {
        throw notExecuted(new Error(evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text ?? "目标解析失败"));
      }

      objectId = evaluated.result?.objectId;

      if (!objectId) throw notExecuted(new Error("目标不是元素，上传未执行"));
    }

    try {
      const files = await setFilesOnObjectId(tabId, objectId, paths);
      await collectEffect(tabId, effectToken);

      return files;
    } finally {
      await sendCommand(tabId, "Runtime.releaseObject", { objectId }).catch(() => { /* 已释放 */ });
    }
  });

  return {
    uploaded: true,
    files: observed.value,
    ...(observed.documentId ? { documentId: observed.documentId } : {}),
  };
}
