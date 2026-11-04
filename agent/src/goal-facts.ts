import { typedValuesOf } from "./site-notes.js";

export interface GoalFacts {
  navigation?: { originTabId: number | null; tabs: Array<{ tabId: number; url: string | null; created: boolean }>; truncated: boolean };
  actions: Array<{ page: string | null; tools: string[]; onGoalPage: boolean; openedByAssistant: boolean }>;
  typedNotFromUser: string[];
  searchedNotFromUser: string[];
}

const PAGE_WRITES: ReadonlySet<string> = new Set(["click", "double_click", "fill", "type_text", "press_key", "select_option", "upload_file", "accept_dialog"]);

const JS_WRITES = /\.click\(|dispatchEvent\(|\.submit\(|requestSubmit\(|\.value\s*=[^=]|\.checked\s*=[^=]/;

const SEARCH_KEYS = ["q", "query", "search", "search_query", "wd", "keyword"];

function pageKey(url: string): string | null {
  try {
    const parsed = new URL(url);

    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

function searchTerms(url: string): string[] {
  try {
    const params = new URL(url).searchParams;

    return SEARCH_KEYS.flatMap(key => params.getAll(key)).map(value => value.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

const plain = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[\s"'“”‘’「」『』]+/g, " ").trim();

const shown = (url: string) => url.replace(/#.*$/, "").slice(0, 200);

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? value as Record<string, unknown> : {});

type Visit = { url: string | null; byAssistant: boolean };

export class PageTrail {
  private urls = new Map<number, Visit>();
  private originTabId: number | null = null;
  private createdTabs = new Set<number>();
  private actions: Array<{ tool: string } & Visit> = [];
  private typed: string[] = [];
  private searched: string[] = [];
  private startText = "";

  begin(page: { tabId?: number; url?: string } | null): void {
    this.urls = new Map();
    this.originTabId = page?.tabId ?? null;
    this.createdTabs.clear();
    this.actions = [];
    this.typed = [];
    this.searched = [];
    this.startText = "";

    if (page?.url && typeof page.tabId === "number") this.urls.set(page.tabId, { url: page.url, byAssistant: false });
  }

  noteStartPage(text: string): void {
    if (!this.startText) this.startText = text.slice(0, 100_000);
  }

  observe(name: string, params: Record<string, unknown>, result: unknown): void {
    const tab = typeof params.tabId === "number" ? params.tabId : -1;
    const data = record(result);
    const before: Visit = this.urls.get(tab) ?? { url: null, byAssistant: true };
    const landed = (tabId: number, url: unknown, byAssistant: boolean) => {
      if (typeof url !== "string" || !/^https?:/i.test(url)) return;
      this.urls.set(tabId, { url, byAssistant });
      this.searched.push(...searchTerms(url));
    };

    if (PAGE_WRITES.has(name) || (name === "js" && typeof params.code === "string" && JS_WRITES.test(params.code))) {
      this.actions.push({ tool: name, ...before });
    }

    this.typed.push(...typedValuesOf(name, params));

    if (name === "open_tab" && typeof data.tabId === "number" && !data.tabClosed) this.createdTabs.add(data.tabId);
    if (name === "navigate" && tab >= 0 && typeof data.workingTabId === "number" && data.workingTabId !== tab) this.createdTabs.add(data.workingTabId);
    if (name === "navigate") landed(typeof data.workingTabId === "number" ? data.workingTabId : tab, data.url, true);
    else if (name === "open_tab" && typeof data.tabId === "number") landed(data.tabId, data.url, true);
    else if (name === "snapshot") landed(typeof data.tabId === "number" ? data.tabId : tab, data.url, (this.urls.get(typeof data.tabId === "number" ? data.tabId : tab) ?? before).byAssistant);
    else if (name === "click" || name === "double_click" || name === "press_key") {
      const newTab = record(data.newTab);

      if (typeof newTab.tabId === "number") {
        this.createdTabs.add(newTab.tabId);
        if (typeof newTab.url === "string") landed(newTab.tabId, newTab.url, before.byAssistant);
        else this.urls.set(newTab.tabId, { url: null, byAssistant: before.byAssistant });
      } else if (record(data.effect).documentChanged) {
        const pageUrl = record(data.page).url;

        if (typeof pageUrl === "string") landed(tab, pageUrl, before.byAssistant);
        else this.urls.set(tab, { url: null, byAssistant: before.byAssistant });
      }
    }
  }

  facts(goal: readonly string[], goalPage: { url: string } | null): GoalFacts {
    const known = plain([...goal, this.startText].join("\n"));
    const fromUser = (value: string) => {
      const term = plain(value);

      return /^[\p{Script=Latin}\p{N}\s'.+-]+$/u.test(term)
        ? new RegExp(`(?<![\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u").test(known)
        : known.includes(term);
    };
    const home = goalPage ? pageKey(goalPage.url) : null;
    const pages = new Map<string, GoalFacts["actions"][number]>();

    for (const action of this.actions) {
      const key = `${action.byAssistant ? "a" : "u"} ${action.url ? pageKey(action.url) ?? action.url : ""}`;
      const searchedOwn = !!action.url && searchTerms(action.url).some(term => !fromUser(term));
      const entry = pages.get(key) ?? { page: action.url ? shown(action.url) : null, tools: [], onGoalPage: !!home && !!action.url && pageKey(action.url) === home, openedByAssistant: action.byAssistant || searchedOwn };

      if (!entry.tools.includes(action.tool)) entry.tools.push(action.tool);
      pages.set(key, entry);
    }

    const foreign = (values: readonly string[]) => [...new Set(values.map(value => value.trim()))].filter(value => [...value].length >= 2 && !fromUser(value)).slice(0, 8).map(value => value.slice(0, 80));

    const visits = [...this.urls.entries()];
    const recent = visits.filter(([tabId]) => tabId !== this.originTabId).slice(-15);
    const tabs = [...visits.filter(([tabId]) => tabId === this.originTabId), ...recent]
      .map(([tabId, visit]) => ({ tabId, url: visit.url, created: this.createdTabs.has(tabId) }));
    return { navigation: { originTabId: this.originTabId, tabs, truncated: tabs.length < visits.length }, actions: [...pages.values()].slice(0, 12), typedNotFromUser: foreign([...this.typed, ...this.searched]), searchedNotFromUser: foreign(this.searched) };
  }
}
