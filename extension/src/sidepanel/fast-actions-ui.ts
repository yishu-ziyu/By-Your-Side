import { rankFastActionsForSite, recordFastActionUse, type FastActionPayload, type FastActionRunResult, type LocalFastAction } from "../../../shared/fast-actions.js";

export const LOCAL_FAST_ACTIONS_KEY = "bys_local_fast_actions";

function hostOfUrl(rawUrl: string | null): string | null {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.host.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export async function loadLocalFastActions(): Promise<LocalFastAction[]> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return [];
  const stored = await chrome.storage.local.get(LOCAL_FAST_ACTIONS_KEY);
  const list = stored[LOCAL_FAST_ACTIONS_KEY];
  return Array.isArray(list) ? (list as LocalFastAction[]) : [];
}

export async function saveLocalFastAction(draft: { site: string; name: string; payload: FastActionPayload }): Promise<LocalFastAction> {
  const existing = await loadLocalFastActions();
  const now = Date.now();
  const next: LocalFastAction = {
    id: `fa_${now}_${Math.random().toString(36).slice(2, 7)}`,
    site: draft.site,
    name: draft.name,
    payload: draft.payload,
    runCount: 1,
    lastUsedAt: now,
  };
  const deduped = existing.filter((item) => !(item.site === draft.site && item.name === draft.name));
  await chrome.storage.local.set({ [LOCAL_FAST_ACTIONS_KEY]: [next, ...deduped].slice(0, 60) });
  return next;
}

export async function recordLocalFastActionRun(actionId: string): Promise<void> {
  const existing = await loadLocalFastActions();
  const updated = recordFastActionUse(existing, actionId, Date.now());
  await chrome.storage.local.set({ [LOCAL_FAST_ACTIONS_KEY]: updated });
}

export async function fastActionsForUrl(url: string | null, limit = 2): Promise<LocalFastAction[]> {
  const site = hostOfUrl(url);
  if (!site) return [];
  const all = await loadLocalFastActions();
  return rankFastActionsForSite(all, site, limit);
}

async function resolveTargetHttpTabId(preferredUrl?: string | null): Promise<number | null> {
  if (typeof chrome === "undefined" || !chrome.tabs?.query) return null;
  const tabs = await chrome.tabs.query({ currentWindow: true });
  if (preferredUrl) {
    const exact = tabs.find((tab) => typeof tab.id === "number" && tab.url === preferredUrl);
    if (exact?.id !== undefined) return exact.id;
  }
  const activeHttp = tabs.find((tab) => tab.active && typeof tab.id === "number" && typeof tab.url === "string" && /^https?:\/\//i.test(tab.url));
  if (activeHttp?.id !== undefined) return activeHttp.id;
  const recentHttp = tabs.find((tab) => typeof tab.id === "number" && typeof tab.url === "string" && /^https?:\/\//i.test(tab.url));
  return recentHttp?.id ?? null;
}

export async function runFastActionNow(action: LocalFastAction, preferredUrl?: string | null): Promise<FastActionRunResult> {
  const started = performance.now();
  const tabId = await resolveTargetHttpTabId(preferredUrl);
  if (tabId == null) {
    return { ok: false, elapsedMs: 0, summary: "没有找到可执行的网页标签页" };
  }

  if (action.payload.kind === "page_transform") {
    const res = (await chrome.tabs.sendMessage(tabId, {
      type: "bys_page_transform_apply",
      actions: action.payload.actions,
    })) as { ok?: boolean; affected?: number } | undefined;
    await recordLocalFastActionRun(action.id);
    const affected = res?.affected ?? 0;
    return {
      ok: affected > 0,
      elapsedMs: Math.round(performance.now() - started),
      summary: affected > 0 ? `已秒跑「${action.name}」（${Math.round(performance.now() - started)}ms）` : "当前页面未匹配到目标区域",
    };
  }

  const res = (await chrome.tabs.sendMessage(tabId, {
    type: "bys_selector_extract",
    fields: action.payload.fields,
  })) as { ok?: boolean; data?: Record<string, string> } | undefined;
  await recordLocalFastActionRun(action.id);
  const data = res?.data ?? {};
  const filled = Object.values(data).filter(Boolean).length;
  return {
    ok: filled > 0,
    elapsedMs: Math.round(performance.now() - started),
    summary: `已抓取 ${filled}/${action.payload.fields.length} 项（${Math.round(performance.now() - started)}ms）`,
    data,
  };
}

export interface FastActionBannerHandle {
  offerSave: (draft: { url: string; name: string; payload: FastActionPayload }) => void;
  showRunResult: (result: FastActionRunResult, preferredUrl?: string | null) => void;
  clear: () => void;
}

export function mountFastActionBanner(opts: {
  composerEl: HTMLElement;
  onChanged: () => void;
}): FastActionBannerHandle {
  const bar = document.createElement("div");
  bar.id = "fast-action-bar";
  bar.className = "bys-fast-bar";
  bar.hidden = true;
  opts.composerEl.parentElement!.insertBefore(bar, opts.composerEl);

  const clear = (): void => {
    bar.hidden = true;
    bar.replaceChildren();
  };

  const restoreButton = (text: HTMLElement, preferredUrl: string | null | undefined, forget: boolean): HTMLButtonElement => {
    const restoreBtn = document.createElement("button");
    restoreBtn.type = "button";
    restoreBtn.className = "bys-tray-btn";
    restoreBtn.textContent = "恢复原页";
    restoreBtn.addEventListener("click", async () => {
      const tabId = await resolveTargetHttpTabId(preferredUrl);
      if (tabId != null) {
        await chrome.tabs.sendMessage(tabId, { type: "bys_page_transform_restore" }).catch(() => {});
      }
      text.textContent = "已恢复原页";
      restoreBtn.remove();
      if (forget) void chrome.storage.local.remove("bys_last_page_transform").catch(() => {});
    });
    return restoreBtn;
  };

  const offerSave = (draft: { url: string; name: string; payload: FastActionPayload }): void => {
    const site = hostOfUrl(draft.url);
    if (!site) return;

    const text = document.createElement("span");
    text.className = "bys-fast-text";
    text.textContent = "这页已在本地改动";

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "bys-tray-btn primary";
    saveBtn.textContent = "存成这页快捷动作";
    saveBtn.addEventListener("click", async () => {
      await saveLocalFastAction({ site, name: draft.name, payload: draft.payload });
      text.textContent = `已保存「${draft.name}」，下次同站可直接秒开`;
      saveBtn.remove();
      opts.onChanged();
    });

    const dismissBtn = document.createElement("button");
    dismissBtn.type = "button";
    dismissBtn.className = "bys-tray-btn";
    dismissBtn.textContent = "忽略";
    dismissBtn.addEventListener("click", clear);

    bar.replaceChildren(text, saveBtn, restoreButton(text, draft.url, true), dismissBtn);
    bar.hidden = false;
  };

  const showRunResult = (result: FastActionRunResult, preferredUrl?: string | null): void => {
    const text = document.createElement("span");
    text.className = "bys-fast-text";
    text.textContent = result.summary;

    const dismissBtn = document.createElement("button");
    dismissBtn.type = "button";
    dismissBtn.className = "bys-tray-btn";
    dismissBtn.textContent = "关闭";
    dismissBtn.addEventListener("click", clear);

    bar.replaceChildren(text, ...(result.ok ? [restoreButton(text, preferredUrl, false)] : []), dismissBtn);
    bar.hidden = false;
  };

  if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !("bys_last_page_transform" in changes)) return;
      const val = changes.bys_last_page_transform?.newValue as { url?: string; name?: string; payload?: FastActionPayload } | undefined;
      const draft = val?.url && val.name && val.payload ? { url: val.url, name: val.name, payload: val.payload } : null;
      if (!draft) { clear(); return; }
      void chrome.tabs.query({ currentWindow: true }).then((tabs) => {
        if (tabs.some((tab) => tab.url === draft.url)) offerSave(draft);
      }).catch(() => {});
    });
  }

  return { offerSave, showRunResult, clear };
}
