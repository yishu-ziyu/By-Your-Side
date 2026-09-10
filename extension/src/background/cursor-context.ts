import {sendCommand} from './debugger.js';

// Keep the actual extension realm, so a backend node reaches the renderer as the
// same DOM object. Coordinates are geometry, not a substitute for node identity.
const contexts = new Map<number, Set<number>>();
let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId == null) return;
    const p = params as {context?: {id:number;auxData?:{isDefault?:boolean}};executionContextId?:number};
    if (method === 'Runtime.executionContextCreated' && p.context && !p.context.auxData?.isDefault) {
      const ids = contexts.get(source.tabId) ?? new Set<number>();
      ids.add(p.context.id); contexts.set(source.tabId, ids);
    } else if (method === 'Runtime.executionContextDestroyed') contexts.get(source.tabId)?.delete(p.executionContextId!);
    else if (method === 'Runtime.executionContextsCleared') contexts.delete(source.tabId);
  });
  chrome.debugger.onDetach.addListener(source => {if(source.tabId!=null)contexts.delete(source.tabId);});
}

export async function cursorContext(tabId: number): Promise<number> {
  listen();
  await sendCommand(tabId, 'Runtime.enable');
  for (const contextId of contexts.get(tabId) ?? []) {
    const result = await sendCommand<{result?:{value?:boolean}}>(tabId, 'Runtime.evaluate', {
      contextId, returnByValue:true,
      expression:`globalThis.chrome?.runtime?.id === ${JSON.stringify(chrome.runtime.id)} && !!globalThis.__sideagent?.cursor?.for`,
    }).catch(()=>null);
    if(result?.result?.value) return contextId;
  }
  throw new Error('标注执行环境已失效，操作未执行；请重新 snapshot 后重试');
}
