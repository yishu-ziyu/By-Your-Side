import { sendCommand } from "../debugger.js";
import { assertSameDocument } from "../observation-document.js";
import type { ToolExecutionFact } from "../../../../shared/protocol.js";

export type DispatchGuard = (() => Promise<void>) & {checkNow?: () => void; noteEffect?: () => void};

export function notExecuted(error: unknown): Error {
  const err = error instanceof Error ? error : new Error(String(error));
  const reported = err as Error & { executionFact?: ToolExecutionFact };

  if (reported.executionFact !== "unknown" && reported.executionFact !== "executed") reported.executionFact = "not_executed";

  return err;
}

export class CdpObjectArg {
  constructor(readonly objectId: string) {}
}

export async function callOnBackendNode<T>(
  tabId: number,
  backendNodeId: number,
  functionDeclaration: string,
  args?: unknown[],
  executionContextId?: number,
  expectedDocumentId?: string,
  beforeDispatch?: DispatchGuard,
): Promise<T> {
  const resolved = await sendCommand<{ object?: { objectId?: string } }>(tabId, "DOM.resolveNode",
    executionContextId !== undefined ? { backendNodeId, executionContextId } : { backendNodeId });

  const objectId = resolved.object?.objectId;

  if (!objectId) throw new Error("节点无法解析（页面可能已变化）");

  if(expectedDocumentId) {
    try { await assertSameDocument(tabId,expectedDocumentId); }
    catch(error) { throw notExecuted(error); }
  }

  const result = await sendCommand<{
    result?: { value?: T };
    exceptionDetails?: { exception?: { description?: string }; text?: string };
  }>(tabId, "Runtime.callFunctionOn",
    args
      ? { objectId, functionDeclaration, arguments: args.map((value) => (value instanceof CdpObjectArg ? { objectId: value.objectId } : { value })), returnByValue: true }
      : { objectId, functionDeclaration, returnByValue: true }, beforeDispatch);

  beforeDispatch?.noteEffect?.();
  if (result.exceptionDetails) {
    throw Object.assign(new Error(
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "页面内执行失败",
    ), {executionFact: "unknown"});
  }

  return result.result?.value as T;
}

export async function ensureDomOps(tabId: number, beforeDispatch?: DispatchGuard): Promise<void> {
  await beforeDispatch?.();
  beforeDispatch?.checkNow?.();
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content-domops.js"],
    world: "ISOLATED",
  });
}

export async function ensureCursor(tabId: number, beforeDispatch?: DispatchGuard): Promise<void> {
  await beforeDispatch?.();
  beforeDispatch?.checkNow?.();
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content-cursor.js"],
    world: "ISOLATED",
  });
}

export async function callDom<Args extends unknown[], Result>(
  tabId: number,
  func: (...args: Args) => Result,
  args: Args,
  documentId?:string,
  beforeDispatch?: DispatchGuard,
): Promise<Awaited<Result>> {
  await beforeDispatch?.();
  beforeDispatch?.checkNow?.();
  beforeDispatch?.noteEffect?.();
  const results = await chrome.scripting.executeScript<Args, Result>({
    target: documentId ? { tabId, documentIds: [documentId] } : { tabId },
    world: "ISOLATED",
    func,
    args,
  });

  beforeDispatch?.noteEffect?.();
  const first = results[0];

  if (!first) throw new Error("页面脚本未返回结果");

  if (first.result == null) {
    const [thrown] = await chrome.scripting.executeScript({
      target: documentId ? { tabId, documentIds: [documentId] } : { tabId },
      world: "ISOLATED",
      func: () => { const ns = window.__sideagent; const error = ns?.lastDomError; if (ns) ns.lastDomError = undefined; return error ?? null; },
    });

    if (typeof thrown?.result === "string") throw new Error(thrown.result);
  }

  return first.result as Awaited<Result>;
}
