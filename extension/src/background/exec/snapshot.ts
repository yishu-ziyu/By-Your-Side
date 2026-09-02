import { resolveWorkingTab } from "../state.js";

/**
 * 注入 content-snapshot.js（幂等）后调用 window.__sideagent.snapshot(scope)。
 * 两者都在 ISOLATED world，共享同一隔离环境。
 */
export async function snapshot(params: { scope?: "full_page" | "viewport" }): Promise<{ text: string }> {
  const tab = await resolveWorkingTab();
  if (tab.id == null) throw new Error("工作标签页无效");

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["content-snapshot.js"],
    world: "ISOLATED",
  });

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "ISOLATED",
    func: (scope: string) => {
      const snap = window.__sideagent?.snapshot;
      if (!snap) throw new Error("snapshot 脚本未注入");
      return snap(scope);
    },
    args: [params.scope ?? "full_page"],
  });

  const text = results[0]?.result;
  if (typeof text !== "string") throw new Error("snapshot 未返回文本");
  return { text };
}
