import { axBackendNodeFor, moveAxRef } from "./axstate.js";
import { sendCommand } from "./debugger.js";
import { isolatedReadContext } from "./isolated-read-context.js";

export async function refindDetachedRef(tabId: number, target: string | undefined): Promise<boolean> {
  const ref = target?.startsWith("@") ? Number(target.slice(1)) : NaN;

  if (!Number.isInteger(ref) || ref <= 0) return false;
  const objectGroup = `bys-refind-${crypto.randomUUID()}`;

  try {
    const backendNodeId = axBackendNodeFor(tabId, ref);

    if (backendNodeId === undefined) return false;
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
    return false;
  } finally {
    void sendCommand(tabId, "Runtime.releaseObjectGroup", { objectGroup }).catch(() => {});
  }
}

function refindInPage(this: Node): Element | null {
  if (this.isConnected || this.nodeType !== 1) return null;
  const old = this as Element;

  if (!["INPUT", "TEXTAREA", "SELECT"].includes(old.tagName) || old.getRootNode() instanceof ShadowRoot) return null;
  const names = ["name", "aria-label", "placeholder", "title"];
  const wanted = names.map(key => old.getAttribute(key) ?? "");
  const wantedType = old.getAttribute("type") ?? "";

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
