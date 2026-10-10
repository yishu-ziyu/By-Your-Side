import { LEAD_SESSION_ID } from "../../../../shared/protocol.js";
import { ensureAttached } from "../debugger.js";
import { resolveWorkingTab } from "../state.js";

import {downloadNote,readCurrentDocument,waitForInteractive,type PageReadiness} from "./page-readiness.js";

export async function navigate(
  params: {
    url: string;
    tabId?: number;
    timeout?: number;
  },
  sessionId: string = LEAD_SESSION_ID,
  beforeDispatch?: (() => Promise<void>) & {checkNow?: () => void},
): Promise<{ url: string; title: string; note?: string } & PageReadiness> {
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");
  const timeoutMs = Math.max(1, params.timeout ?? 30) * 1000;

  const before=await readCurrentDocument(tab.id);

  // 先 attach 再改地址，让加载期发出的请求也能被 Network 域记录；attach 失败不影响导航。
  try{await ensureAttached(tab.id);}catch{/* DevTools 占用或页面受限：本次导航无网络记录 */}

  await beforeDispatch?.();
  beforeDispatch?.checkNow?.();
  const tabId = tab.id;
  const ready=await waitForInteractive(tabId,timeoutMs,{previousDocumentId:before?.documentId,requestedUrl:params.url,dispatch:()=>chrome.tabs.update(tabId, { url: params.url })});

  const after = await chrome.tabs.get(tab.id);
  const data = { url: after.url ?? params.url, title: after.title ?? "" };

  const result: { url: string; title: string; note?: string } & PageReadiness = {...data,...ready};

  // 超时不算失败：页面可能已部分可用
  if (ready.readiness==='timeout') result.note = "document readiness timeout; page may still be loading";

  if (ready.download) result.note = downloadNote(ready.download);

  if (ready.readiness==='error_page') result.note = "Chrome shows its own error page for this address (for example the site could not be reached); the page did not open.";

  return result;
}
