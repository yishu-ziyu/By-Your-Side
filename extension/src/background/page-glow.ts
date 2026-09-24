/**
 * 页面边缘光（background 侧）：某个成员这一轮动过哪一页，那一页四周就亮一圈它的颜色，
 * 这一轮结束、被停止或被接管时淡出。只是呈现，不是执行证据，画不上不影响任务。
 */
import { callDom, ensureCursor } from "./exec/input.js";
import { parseExecutionKey } from "./tab-bindings.js";

/** 执行键 → 这个成员正在操作的标签页。 */
const lit = new Map<string, number>();

const paints = new Map<number, Promise<void>>();

function paint(tabId: number, key: string): Promise<void> {
  const next = (paints.get(tabId) ?? Promise.resolve()).then(async () => {
    try {
      // 注入之后再读意图：晚到的点亮不能盖掉已经发生的熄灭。
      if (lit.get(key) === tabId) await ensureCursor(tabId);
      await callDom(tabId, (id: string, on: boolean) => {
        window.__sideagent?.cursor?.for(id)?.setGlow?.(on);
      }, [parseExecutionKey(key).sessionId, lit.get(key) === tabId]);
    } catch { /* 关闭或受限的页面画不上，不影响任务。 */ }
  });

  paints.set(tabId, next);
  void next.finally(() => { if (paints.get(tabId) === next) paints.delete(tabId); });

  return next;
}

let watching = false;

export function glowPage(key: string, tabId: number | null): Promise<void> {
  if (!watching) {
    watching = true;

    try { chrome.tabs.onRemoved.addListener(forgetGlowTab); } catch { /* 测试环境没有标签页事件 */ }
  }

  const previous = lit.get(key);

  if (tabId == null || previous === tabId) return Promise.resolve();
  lit.set(key, tabId);

  return Promise.all([previous != null ? paint(previous, key) : null, paint(tabId, key)]).then(() => {});
}

export function dimPage(key: string): Promise<void> {
  const previous = lit.get(key);

  if (previous == null) return Promise.resolve();
  lit.delete(key);

  return paint(previous, key);
}

export function forgetGlowTab(tabId: number): void {
  for (const [key, litTab] of lit) if (litTab === tabId) lit.delete(key);
}
