import { sendCommand } from "../debugger.js";
import { LEAD_SESSION_ID } from "../../../../shared/protocol.js";
import { resolveWorkingTab } from "../state.js";
import { oneLine } from "../util.js";
import { axTreeToText, type AxNodeLite } from "../axtree.js";
import { recordAxSnapshot } from "../axstate.js";
import { withTimeout } from "../timeout.js";

/**
 * snapshot 工具：优先 CDP Accessibility 全量无障碍树（跨 shadow DOM、节点带稳定
 * backendDOMNodeId）；debugger 不可用（如被 DevTools 占用）或 AX 命令失败时，
 * 回退 content script 的简化 DOM 快照，并在输出首行标注回退原因。
 */
export async function snapshot(
  params: { scope?: "full_page" | "viewport" },
  sessionId: string = LEAD_SESSION_ID,
): Promise<{ text: string }> {
  const tab = await resolveWorkingTab(undefined, sessionId);
  if (tab.id == null) throw new Error("工作标签页无效");
  return snapshotTab(tab.id, params.scope);
}

/** 对指定标签做 snapshot，不改工作标签认领。交还时读用户当前页用。 */
export async function snapshotTab(
  tabId: number,
  scope: "full_page" | "viewport" = "full_page",
): Promise<{ text: string }> {
  try {
    return await axSnapshot(tabId);
  } catch (e) {
    const dom = await domSnapshot(tabId, scope);
    return {
      text: `[回退：CDP 无障碍树快照不可用（${oneLine(e)}），以下为简化 DOM 快照]\n${dom.text}`,
    };
  }
}

async function axSnapshot(tabId: number): Promise<{ text: string }> {
  const result = await withTimeout(
    sendCommand<{ nodes?: AxNodeLite[] }>(tabId, "Accessibility.getFullAXTree"),
    8_000,
    "Accessibility.getFullAXTree 8 秒内没有返回",
  );
  const nodes = result.nodes ?? [];
  if (nodes.length === 0) throw new Error("Accessibility.getFullAXTree 返回空树");
  const { text, backendIds } = axTreeToText(nodes);
  recordAxSnapshot(tabId, backendIds);
  return { text };
}

/** 旧实现：注入 content-snapshot.js（幂等）后调用 window.__sideagent.snapshot(scope)。 */
async function domSnapshot(tabId: number, scope: "full_page" | "viewport"): Promise<{ text: string }> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content-snapshot.js"],
    world: "ISOLATED",
  });

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    func: (s: string) => {
      const snap = window.__sideagent?.snapshot;
      if (!snap) throw new Error("snapshot 脚本未注入");
      return snap(s);
    },
    args: [scope],
  });

  const text = results[0]?.result;
  if (typeof text !== "string") throw new Error("snapshot 未返回文本");
  return { text };
}
