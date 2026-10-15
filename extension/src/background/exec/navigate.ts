import { LEAD_SESSION_ID } from "../../../../shared/protocol.js";
import { ensureAttached } from "../debugger.js";
import { resolveWorkingTab } from "../state.js";

import {ERROR_PAGE_NOTE,downloadNote,readCurrentDocument,retryTransientErrorPage,settlesContent,waitForInteractive,waitForQuietDom,type PageReadiness} from "./page-readiness.js";

export async function navigate(
  params: {
    url: string;
    tabId?: number;
    timeout?: number;
  },
  sessionId: string = LEAD_SESSION_ID,
  beforeDispatch?: (() => Promise<void>) & {checkNow?: () => void},
): Promise<{ url: string; title: string; note?: string; retry?: string } & PageReadiness> {
  // 没有完整网址时 Chrome 不会打开新文档，下面会白等到超时（#256）：立刻报错，并点明程序里常见的取错值。
  const url = typeof params.url === "string" ? params.url.trim() : "";

  if (!url) throw new Error("navigate 需要 url。在 browser_run 里 browser.js 返回 {value}：网址在 .value 里，先取出来再传给 navigate。");

  if (!URL.canParse(url)) throw new Error(`navigate 的 url 不是完整网址：${url.slice(0, 200)}。要写成 https://… 这样的完整地址。`);
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");
  const timeoutMs = Math.max(1, params.timeout ?? 30) * 1000;

  const before=await readCurrentDocument(tab.id);

  // 先 attach 再改地址，让加载期发出的请求也能被 Network 域记录；attach 失败不影响导航。
  try{await ensureAttached(tab.id);}catch{/* DevTools 占用或页面受限：本次导航无网络记录 */}

  await beforeDispatch?.();
  beforeDispatch?.checkNow?.();
  const tabId = tab.id;
  const {ready,retry}=await retryTransientErrorPage(tabId,url,await waitForInteractive(tabId,timeoutMs,{previousDocumentId:before?.documentId,requestedUrl:url,dispatch:()=>chrome.tabs.update(tabId, { url })}),timeoutMs,beforeDispatch);

  // 等页面把内容画完，宿主附带的快照才不是半张空页；多等的时间算进 waitMs。
  if (settlesContent(ready.readiness)) ready.waitMs += await waitForQuietDom(tabId);

  const after = await chrome.tabs.get(tab.id);
  const data = { url: after.url ?? url, title: after.title ?? "" };

  const result: { url: string; title: string; note?: string; retry?: string } & PageReadiness = {...data,...ready,...(retry?{retry}:{})};

  // 超时不算失败：页面可能已部分可用
  if (ready.readiness==='timeout') result.note = "document readiness timeout; page may still be loading";

  if (ready.download) result.note = downloadNote(ready.download);

  if (ready.readiness==='error_page') result.note = ERROR_PAGE_NOTE;

  return result;
}
