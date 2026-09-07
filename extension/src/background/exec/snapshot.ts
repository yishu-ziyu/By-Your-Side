import { sendCommand } from "../debugger.js";
import { LEAD_SESSION_ID } from "../../../../shared/protocol.js";
import { resolveWorkingTab } from "../state.js";
import { oneLine } from "../util.js";
import { axTreeToText, type AxNodeLite } from "../axtree.js";
import { clearAxSnapshot, recordAxSnapshot } from "../axstate.js";
import { withTimeout } from "../timeout.js";

/**
 * snapshot 工具：scope=full_page（默认）走 CDP Accessibility 全量无障碍树；
 * scope=viewport 走已有 DOM 视口快照（真做视口过滤，明确声明降级）。
 * 任何一次返回 DOM 快照后都清掉该页 AX 登记：DOM ref 与 backendDOMNodeId
 * 同处数字空间，不清会导致后续 @N 经 isAxRef 误走 CDP。
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
  if (scope === "viewport") {
    const dom = await domSnapshot(tabId, scope);
    clearAxSnapshot(tabId);
    return {
      text: `[说明：scope=viewport 当前为简化 DOM 视口快照降级（仅覆盖当前视口，非全量 AX 树；视口内 iframe 仅占位未展开，不覆盖其内容）；以下 ref 为本次 DOM 快照编号，仅 domops 路径有效，旧 AX ref 已失效、请勿混用。如需全页 AX 树请用 scope=full_page]\n${dom.text}`,
    };
  }
  try {
    return await axSnapshot(tabId);
  } catch (e) {
    const dom = await domSnapshot(tabId, scope);
    clearAxSnapshot(tabId);
    return {
      text: `[回退：CDP 无障碍树快照不可用（${oneLine(e)}），以下为简化 DOM 快照；旧 AX ref 已失效，请用本次 ref]\n${dom.text}`,
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
