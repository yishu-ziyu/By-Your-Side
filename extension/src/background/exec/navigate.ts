import { LEAD_SESSION_ID } from "../../../../shared/protocol.js";
import { resolveWorkingTab } from "../state.js";

import {readCurrentDocument,waitForInteractive,type PageReadiness} from "./page-readiness.js";

export async function navigate(
  params: {
    url: string;
    timeout?: number;
  },
  sessionId: string = LEAD_SESSION_ID,
): Promise<{ url: string; title: string; note?: string } & PageReadiness> {
  const tab = await resolveWorkingTab(undefined, sessionId);
  if (tab.id == null) throw new Error("工作标签页无效");
  const timeoutMs = Math.max(1, params.timeout ?? 30) * 1000;

  const before=await readCurrentDocument(tab.id);
  await chrome.tabs.update(tab.id, { url: params.url });
  const ready=await waitForInteractive(tab.id,timeoutMs,before?.documentId);

  const after = await chrome.tabs.get(tab.id);
  const data = { url: after.url ?? params.url, title: after.title ?? "" };
  // 超时不算失败：页面可能已部分可用
  return {...data,...ready,...(ready.readiness==='timeout'?{note:"document readiness timeout; page may still be loading"}:{})};
}
