import { axBackendNodeFor, moveAxRef } from "./axstate.js";
import { sendCommand } from "./debugger.js";
import { isolatedReadContext } from "./isolated-read-context.js";

/**
 * 填写、选择前核对 @N：节点还在文档里就什么都不做。页面重渲染把输入框换掉了（维基百科展开搜索框后立刻换成新的），
 * 就按旧节点自己身上的名字在同一文档里找替身；恰好一个在文档里、看得见的元素对得上才换过去，
 * 否则保持原样，动作照旧报「已失效」。
 * 只找输入框、文本框、下拉框：按钮和链接同名的常有好几个（每行一个「删除」），找错了就点在别的行上。
 * 只能在 assertObservedDocument 之后调用：文档换了，旧 ref 一律不找替身。
 * 返回 true 表示这个 ref 已指向新节点。
 */
export async function refindDetachedRef(tabId: number, target: string | undefined): Promise<boolean> {
  const ref = target?.startsWith("@") ? Number(target.slice(1)) : NaN;

  if (!Number.isInteger(ref) || ref <= 0) return false;
  const objectGroup = `bys-refind-${crypto.randomUUID()}`;

  try {
    const backendNodeId = axBackendNodeFor(tabId, ref);

    if (backendNodeId === undefined) return false;
    // 页面自己的环境里内置方法可能被改写；比对放在隔离环境里做（同 read_element）。
    const executionContextId = await isolatedReadContext(tabId);
    const old = await sendCommand<{ object?: { objectId?: string } }>(tabId, "DOM.resolveNode", { backendNodeId, objectGroup, executionContextId });

    if (!old.object?.objectId) return false;

    const found = await sendCommand<{ result?: { objectId?: string }; exceptionDetails?: unknown }>(tabId, "Runtime.callFunctionOn", {
      objectId: old.object.objectId,
      functionDeclaration: refindInPage.toString(),
      objectGroup,
    });

    if (found.exceptionDetails || !found.result?.objectId) return false;
    const { node } = await sendCommand<{ node: { backendNodeId: number } }>(tabId, "DOM.describeNode", { objectId: found.result.objectId });

    if (node.backendNodeId === backendNodeId) return false;
    moveAxRef(tabId, ref, node.backendNodeId);

    return true;
  } catch {
    // 找不到替身就按原来的路径走，由动作自己报错。
    return false;
  } finally {
    void sendCommand(tabId, "Runtime.releaseObjectGroup", { objectGroup }).catch(() => {});
  }
}

/**
 * 在隔离环境里执行，保持自包含。旧节点还在文档里返回 null。
 * 被换掉时用旧节点自己的标签、type 和名字（name、aria-label、placeholder、title）去对；
 * id、class、role 不对，框架重新挂载时常改它们（维基百科新输入框没有 id，role 变成 combobox）。
 * 只有一个在文档里、宽高都不为 0、CSS 上可见的元素对得上才返回它，否则返回 null。
 * 旧节点在 shadow root 里时不找：替身多半也在 shadow root 里，按文档查只会找错。
 */
function refindInPage(this: Node): Element | null {
  if (this.isConnected || this.nodeType !== 1) return null;
  const old = this as Element;

  if (!["INPUT", "TEXTAREA", "SELECT"].includes(old.tagName) || old.getRootNode() instanceof ShadowRoot) return null;
  const names = ["name", "aria-label", "placeholder", "title"];
  const wanted = names.map(key => old.getAttribute(key) ?? "");
  const wantedType = old.getAttribute("type") ?? "";

  // 一个名字都没有时不找：同类输入框太多，对上了也说不上是同一个。
  if (wanted.every(value => !value)) return null;

  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();

    return r.width > 0 && r.height > 0 && (typeof el.checkVisibility !== "function" || el.checkVisibility({ checkVisibilityCSS: true }));
  };

  const found = Array.from(old.ownerDocument.getElementsByTagName(old.localName)).filter(el => el.isConnected
    && (el.getAttribute("type") ?? "") === wantedType
    && names.every((key, i) => (el.getAttribute(key) ?? "") === wanted[i])
    && visible(el));

  return found.length === 1 ? found[0]! : null;
}
