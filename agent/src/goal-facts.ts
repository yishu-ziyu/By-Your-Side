import { typedValuesOf } from "./site-notes.js";

/**
 * 核对用的宿主事实：这次请求里改页面的动作各落在哪一页，助手自己输入、搜索了什么。
 * 只记宿主执行时经手的调用和回执，不听模型怎么说：核对模型只看得到回答和几次读数，分不出「点的是自己搜出来的结果页，不是用户说话时那一页」。
 */
export interface GoalFacts {
  /**
   * 改页面的动作按页归并。page 为 null：那一页是点击后跳过去的，之后还没读到地址。onGoalPage：就是用户说这句话时所在的那一页。
   * openedByAssistant：这一页是助手自己打开、跳转或搜出来的（从这种页再点过去的、网址里带着用户没说过的搜索词的也算）；从用户那一页点过去的不算，那是照用户的话点出来的。
   */
  actions: Array<{ page: string | null; tools: string[]; onGoalPage: boolean; openedByAssistant: boolean }>;
  /** 助手往网页里输入、或放进搜索的文字里，用户原话和用户说话时那一页上都没有的。 */
  typedNotFromUser: string[];
  /** 其中作为搜索词用的（落到的网址里的搜索参数）。 */
  searchedNotFromUser: string[];
}

/** 会改页面内容的调用：点、写、按键、提交。读页、截图、换标签页、跳转本身不算（跳转落到哪页另记）。 */
const PAGE_WRITES: ReadonlySet<string> = new Set(["click", "double_click", "fill", "type_text", "press_key", "select_option", "upload_file", "accept_dialog"]);

/** 页面 JS 多数只是读；点、派发事件、提交、赋值才算动了页面。 */
const JS_WRITES = /\.click\(|dispatchEvent\(|\.submit\(|requestSubmit\(|\.value\s*=[^=]|\.checked\s*=[^=]/;

const SEARCH_KEYS = ["q", "query", "search", "search_query", "wd", "keyword"];

/** 同一页：同源同路径。查询串不比：站内切个标签页也会改它，搜索词另外从查询串里取。 */
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
  private actions: Array<{ tool: string } & Visit> = [];
  private typed: string[] = [];
  private searched: string[] = [];
  private startText = "";

  /** 一句新请求开始：用户说话时所在的标签页和地址。 */
  begin(page: { tabId?: number; url?: string } | null): void {
    this.urls = new Map();
    this.actions = [];
    this.typed = [];
    this.searched = [];
    this.startText = "";

    if (page?.url && typeof page.tabId === "number") this.urls.set(page.tabId, { url: page.url, byAssistant: false });
  }

  /** 用户说话时那一页的读数：输入的文字在这里出现过，就不算助手自己编的。 */
  noteStartPage(text: string): void {
    if (!this.startText) this.startText = text.slice(0, 100_000);
  }

  /** 一次浏览器调用执行完（直调的工具和程序里的每一步都走这里）。params 里的 tabId 已由宿主补成实际的标签页。 */
  observe(name: string, params: Record<string, unknown>, result: unknown): void {
    const tab = typeof params.tabId === "number" ? params.tabId : -1;
    const data = record(result);
    // 没见过的标签页（读了用户别的标签页、或开在别处的页）按助手自己找来的算。
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

    if (name === "navigate") landed(typeof data.workingTabId === "number" ? data.workingTabId : tab, data.url, true);
    else if (name === "open_tab" && typeof data.tabId === "number") landed(data.tabId, data.url, true);
    // 读页只补上地址，这一页是怎么到的不变。
    else if (name === "snapshot") landed(typeof data.tabId === "number" ? data.tabId : tab, data.url, (this.urls.get(typeof data.tabId === "number" ? data.tabId : tab) ?? before).byAssistant);
    else if (name === "click" || name === "double_click" || name === "press_key") {
      const newTab = record(data.newTab);

      if (typeof newTab.tabId === "number") {
        if (typeof newTab.url === "string") landed(newTab.tabId, newTab.url, before.byAssistant);
        else this.urls.set(newTab.tabId, { url: null, byAssistant: before.byAssistant });
      } else if (record(data.effect).documentChanged) this.urls.set(tab, { url: null, byAssistant: before.byAssistant });
    }
  }

  facts(goal: readonly string[], goalPage: { url: string } | null): GoalFacts {
    const known = plain([...goal, this.startText].join("\n"));
    // 西文和数字按整词比：「AI」不能因为页面上有 email、domain 就算用户那一页上有。中文没有词界，按片段比。
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
      // 在用户那一页的搜索框里输入自己想的词再回车，到的结果页也是助手自己搜出来的。
      const searchedOwn = !!action.url && searchTerms(action.url).some(term => !fromUser(term));
      const entry = pages.get(key) ?? { page: action.url ? shown(action.url) : null, tools: [], onGoalPage: !!home && !!action.url && pageKey(action.url) === home, openedByAssistant: action.byAssistant || searchedOwn };

      if (!entry.tools.includes(action.tool)) entry.tools.push(action.tool);
      pages.set(key, entry);
    }

    const foreign = (values: readonly string[]) => [...new Set(values.map(value => value.trim()))].filter(value => [...value].length >= 2 && !fromUser(value)).slice(0, 8).map(value => value.slice(0, 80));

    return { actions: [...pages.values()].slice(0, 12), typedNotFromUser: foreign([...this.typed, ...this.searched]), searchedNotFromUser: foreign(this.searched) };
  }
}
