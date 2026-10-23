import { LEAD_SESSION_ID } from "../../../../shared/protocol.js";
import { ensureAttached } from "../debugger.js";
import { resolveWorkingTab, setWorkingTab } from "../state.js";
import { openTab } from "./tabs.js";

import {ERROR_PAGE_NOTE,downloadNote,readCurrentDocument,retryTransientErrorPage,settlesContent,waitForInteractive,waitForQuietDom,type PageReadiness} from "./page-readiness.js";

export async function navigate(
  params: {
    url: string;
    tabId?: number;
    timeout?: number;
    inPlace?: boolean;
  },
  sessionId: string = LEAD_SESSION_ID,
  beforeDispatch?: (() => Promise<void>) & {checkNow?: () => void},
  cancelled?: () => boolean,
): Promise<{ url: string; title: string; note?: string; retry?: string; workingTabId?: number } & PageReadiness> {
  // 没有完整网址时 Chrome 不会打开新文档，下面会白等到超时：立刻报错，并点明程序里常见的取错值。
  const url = typeof params.url === "string" ? params.url.trim() : "";

  if (!url) throw new Error("navigate 需要 url。在 browser_run 里 browser.js 返回 {value}：网址在 .value 里，先取出来再传给 navigate。");

  if (!URL.canParse(url)) throw new Error(`navigate 的 url 不是完整网址：${url.slice(0, 200)}。要写成 https://… 这样的完整地址。`);
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");

  const kept = params.inPlace === true ? null : await keepUserPage(tab, url, sessionId, beforeDispatch, cancelled);

  if (kept) return kept;
  const timeoutMs = Math.max(1, params.timeout ?? 30) * 1000;

  const before=await readCurrentDocument(tab.id);

  // 先 attach 再改地址，让加载期发出的请求也能被 Network 域记录；attach 失败不影响导航。
  try{await ensureAttached(tab.id);}catch{/* DevTools 占用或页面受限：本次导航无网络记录 */}

  await beforeDispatch?.();
  beforeDispatch?.checkNow?.();
  const tabId = tab.id;
  const {ready,retry}=await retryTransientErrorPage(tabId,url,await waitForInteractive(tabId,timeoutMs,{previousDocumentId:before?.documentId,requestedUrl:url,dispatch:()=>chrome.tabs.update(tabId, { url })}),timeoutMs,cancelled);

  // 等页面把内容画完，宿主附带的快照才不是半张空页；多等的时间算进 waitMs。
  if (settlesContent(ready.readiness)) { ready.quietMs = await waitForQuietDom(tabId); ready.waitMs += ready.quietMs; }

  const after = await chrome.tabs.get(tab.id);
  const data = { url: after.url ?? url, title: after.title ?? "" };

  const result: { url: string; title: string; note?: string; retry?: string } & PageReadiness = {...data,...ready,...(retry?{retry}:{})};

  // 超时不算失败：页面可能已部分可用
  if (ready.readiness==='timeout') result.note = "document readiness timeout; page may still be loading";

  if (ready.download) result.note = downloadNote(ready.download);

  if (ready.readiness==='error_page') result.note = ERROR_PAGE_NOTE;

  return result;
}

const isWebPage = (url: string | undefined): url is string => !!url && /^(https?|file):/.test(url) && URL.canParse(url);

/** 同一份文档：只差 # 片段的两个地址打开的是同一页。 */
function sameDocument(a: string, b: string): boolean {
  const x = new URL(a), y = new URL(b);

  return x.origin === y.origin && x.pathname === y.pathname && x.search === y.search;
}

/**
 * 用户眼前的页（工作标签页正是它所在窗口的前台页）装着用户自己的状态：读到哪、选中了什么、助手画的标注。
 * 原地换文档会把这些全部清掉，所以这里不靠模型自觉：
 * - 要去的页在同一窗口的另一个标签里已经开着：切过去当工作标签页，不再加载一份重复的；
 * - 用户眼前的页已经就是这一页：不重新加载；
 * - 用户眼前的页要换到别的网站：在它旁边开一个后台新页去，用户的页原样留着。
 * 同站跳转（翻页、站内搜索）照旧原地走；用户明说要在这页打开时模型传 inPlace。
 * 返回 null 表示照常原地导航。
 */
async function keepUserPage(
  tab: chrome.tabs.Tab,
  url: string,
  sessionId: string,
  beforeDispatch?: (() => Promise<void>) & {checkNow?: () => void},
  cancelled?: () => boolean,
): Promise<({ url: string; title: string; note?: string; retry?: string; workingTabId?: number } & PageReadiness) | null> {
  if (!/^(https?|file):/.test(url)) return null;
  const dispatch = async () => { await beforeDispatch?.(); beforeDispatch?.checkNow?.(); };

  // 只在工作标签页自己的窗口里找：两个窗口都开着侧栏时，不切到另一个窗口的页。
  const open = (await chrome.tabs.query({ windowId: tab.windowId })).find(other => other.id != null && other.id !== tab.id && isWebPage(other.url) && sameDocument(other.url, url));

  if (open?.id != null) {
    await dispatch();

    try {
      await setWorkingTab(open.id, sessionId);
    } catch {
      return null; // 那一页归别的会话：照常导航
    }

    // 工作标签页本来就在用户眼前时，原地导航用户会看到新页；换成切页也让用户看到它。后台工作页切过去不动前台。
    if (tab.active) await chrome.tabs.update(open.id, { active: true });

    return { url: open.url ?? url, title: open.title ?? "", readiness: "complete", waitMs: 0, workingTabId: open.id, note: `This address is already open in tab ${open.id} of the same window, so that tab is now the working tab instead of loading a duplicate; its reading position and marks are kept.` };
  }

  if (!tab.active || !isWebPage(tab.url)) return null;

  if (tab.url === url || tab.url === new URL(url).href) {
    await dispatch();

    return { url: tab.url, title: tab.title ?? "", readiness: "complete", waitMs: 0, note: "The user's page already shows this address; it was not reloaded, so their reading position and marks are kept." };
  }

  if (new URL(tab.url).origin === new URL(url).origin) return null;

  const opened = await openTab({ url }, sessionId, beforeDispatch, cancelled, tab);
  const { tabId, tabClosed: _closed, ...rest } = opened;

  return {
    ...rest,
    readiness: rest.readiness ?? "timeout",
    waitMs: rest.waitMs ?? 0,
    workingTabId: tabId,
    note: [rest.note, `Opened in new background tab ${tabId} beside the user's page (tab ${tab.id}), which stays as it is with its reading position and marks; tab ${tabId} is now the working tab. To act on the user's page again use tabs switch ${tab.id}. Load an address in the user's page itself only when they asked for that page to go there: navigate with inPlace:true.`].filter(Boolean).join("\n"),
  };
}
