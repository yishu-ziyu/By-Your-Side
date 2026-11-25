import type { FastActionRunResult, LocalFastAction } from "../../../shared/fast-actions.js";
import { detectComparableCluster, type OpenTabSummary, type TabCluster } from "../../../shared/tab-cluster.js";
import { fastActionsForUrl, LOCAL_FAST_ACTIONS_KEY, runFastActionNow } from "./fast-actions-ui.js";
import { onSavedToolsChange } from "./saved-tools.js";
import { onSkillOperationsChange } from "./skill-operations.js";
import type { PageAction } from "./slash-skills.js";

const MAX_OFFERS = 2;

interface PageOffersOptions {
  composerEl: HTMLElement;
  inputEl: HTMLTextAreaElement;
  actions: (url: string | null) => PageAction[];
  ready: () => boolean;
  onFastActionRun?: (result: FastActionRunResult, url: string | null) => void;
  onOpenCollector?: () => void;
}

export function mountPageOffers({ composerEl, inputEl, actions, ready, onFastActionRun, onOpenCollector }: PageOffersOptions): { setPage: (url: string | null) => void; sync: () => void } {
  const root = document.createElement("div");
  root.id = "page-offers";
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", "这页可以");
  root.hidden = true;
  composerEl.parentElement!.insertBefore(root, composerEl);
  let pageUrl: string | null = null;
  let shown = "";
  let cluster: TabCluster | null = null;
  let savedFast: LocalFastAction[] = [];

  const clusterAction = (): PageAction | null => {
    if (!cluster) return null;
    return {
      key: `${cluster.key}:${cluster.tabs.length}`,
      label: cluster.label,
      note: "跨标签页",
      run: () => {
        const current = cluster;
        if (!current) return;
        const titles = current.tabs.map((tab) => `「${tab.title || tab.url}」`).join("、");
        inputEl.value = `请对比当前窗口里这 ${current.tabs.length} 个同类标签页（${titles}），列出核心差异表并标出每项出处。`;
        inputEl.dispatchEvent(new Event("input", { bubbles: true }));
        inputEl.focus();
      },
    };
  };

  const fastOfferActions = (): PageAction[] => savedFast.map((action) => ({
    key: `fast:${action.id}`,
    label: action.name,
    note: "本地秒开",
    run: () => {
      void runFastActionNow(action, pageUrl).then((result) => {
        onFastActionRun?.(result, pageUrl);
      });
    },
  }));

  const collectorOfferAction = (): PageAction | null => {
    if (!onOpenCollector || !cluster) return null;
    return {
      key: "collector:open",
      label: "边逛边吸",
      note: "收集表",
      run: () => onOpenCollector(),
    };
  };

  const render = (): void => {
    const visible = ready() && !inputEl.value.trim();
    const base = visible ? actions(pageUrl) : [];
    const fast = visible ? fastOfferActions() : [];
    const cmp = visible ? clusterAction() : null;
    const col = visible ? collectorOfferAction() : null;
    const list = [...(cmp ? [cmp] : []), ...(col ? [col] : []), ...fast, ...base].slice(0, MAX_OFFERS);
    const signature = list.map((action) => action.key).join("|");

    if (signature === shown) return;
    shown = signature;
    root.replaceChildren(...list.map((action) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "page-offer";
      button.dataset.offer = action.key;
      const note = document.createElement("small");
      note.textContent = action.note;
      button.append(action.label, note);
      button.addEventListener("click", () => { root.hidden = true; shown = ""; action.run(); });

      return button;
    }));
    root.hidden = list.length === 0;
  };

  const refreshAsync = (): void => {
    if (typeof chrome !== "undefined" && chrome.tabs?.query) {
      void chrome.tabs.query({ currentWindow: true }).then((tabs) => {
        const summaries: OpenTabSummary[] = tabs
          .filter((tab): tab is chrome.tabs.Tab & { id: number; url: string } => typeof tab.id === "number" && typeof tab.url === "string")
          .map((tab) => ({ tabId: tab.id, url: tab.url, title: tab.title ?? "" }));
        cluster = detectComparableCluster(summaries);
        const fallbackUrl = (pageUrl && /^https?:\/\//i.test(pageUrl) ? pageUrl : null) ?? summaries.find((t) => /^https?:\/\//i.test(t.url))?.url ?? null;
        return fastActionsForUrl(fallbackUrl, MAX_OFFERS).then((list) => {
          savedFast = list;
          render();
        });
      }).catch(() => {});
    }
  };

  const sync = (): void => {
    render();
    refreshAsync();
  };

  onSavedToolsChange(sync);
  onSkillOperationsChange(sync);
  inputEl.addEventListener("input", render);
  if (typeof chrome !== "undefined") {
    chrome.tabs?.onCreated?.addListener(refreshAsync);
    chrome.tabs?.onRemoved?.addListener(refreshAsync);
    chrome.tabs?.onUpdated?.addListener(refreshAsync);
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area === "local" && LOCAL_FAST_ACTIONS_KEY in changes) refreshAsync();
    });
  }
  refreshAsync();

  return { setPage: (url) => { pageUrl = url; sync(); }, sync };
}
