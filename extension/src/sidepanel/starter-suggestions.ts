/**
 * 新对话的起点建议跟着当前页面变（参照 shapeof.ai「Suggestions」里按页面内容给建议的做法）。
 * 只看页面结构，不调用模型；点了只写进草稿，发送仍由用户决定。
 */

export interface PageProfile {
  title?: string;
  headings?: number;
  /** 有实际文字的段落数 */
  paragraphs: number;
  /** 可填写的输入控件数（文本框、下拉、多行文本） */
  inputs: number;
  /** 表格数 */
  tables: number;
  /** 列表项数 */
  listItems: number;
  /** 正文里中文字符占比 0–1 */
  cjkRatio: number;
}

export interface StarterSuggestion {
  label: string;
  prompt: string;
}

export const DEFAULT_SUGGESTIONS: StarterSuggestion[] = [
  { label: "概括这一页", prompt: "请概括当前页面的要点。" },
];

const MAX_SUGGESTIONS = 3;

// 模块级状态：面板启动早期就可能读到，放在这里避免主脚本里声明顺序带来的问题。
let probeSeq = 0;

let lastTabId: number | null = null;

export function noteStarterTab(tabId: number): void { lastTabId = tabId; }

export function starterTab(): number | null { return lastTabId; }

export function beginStarterProbe(): number { return ++probeSeq; }

export function isLatestStarterProbe(probe: number): boolean { return probe === probeSeq; }

export function suggestionsFor(profile: PageProfile | null): StarterSuggestion[] {
  if (!profile) return DEFAULT_SUGGESTIONS;
  const out: StarterSuggestion[] = [];
  // 以正文为准：很多网站的 <html lang> 写错，不能拿它判断要不要翻译。
  const foreign = profile.cjkRatio < 0.2;
  const title = profile.title ?? "";
  const list = profile.tables >= 1 || profile.listItems >= 8 || (profile.paragraphs < 3 && (profile.headings ?? 0) >= 3);

  if (list && /供应商|suppliers?|vendors?/i.test(title)) {
    out.push({ label: "整理供应商", prompt: "把当前页面的供应商和已显示的联系方式整理成表格。" });
    out.push({ label: "对比供应商", prompt: "比较当前页面的供应商，区分已有信息和需要进一步确认的内容。" });
  } else if (list && /招聘|职位|careers?|jobs?|vacanc/i.test(title)) {
    out.push({ label: "整理招聘职位", prompt: "把当前页面的职位、地区和要求整理成表格。" });
    out.push({ label: "比较职位要求", prompt: "比较当前页面的职位要求，并指出有待确认的差异。" });
  } else {

    if (profile.inputs >= 2) out.push({ label: "帮我填写表单", prompt: "请帮我填写当前页面的表单，提交前让我确认。" });

    if (profile.paragraphs >= 3 && foreign) out.push({ label: "翻译成中文", prompt: "把这个页面翻译成中文。" });

    if (profile.paragraphs >= 3) out.push({ label: "提炼文章要点", prompt: "提炼当前文章的关键观点，并附对应原文。" });

    if (list) out.push({ label: "整理成表格", prompt: "把这一页的主要条目整理成表格。" });
  }

  return [...out.slice(0, MAX_SUGGESTIONS - 1), ...DEFAULT_SUGGESTIONS];
}

/** 在页面里执行：只数结构，不读取输入框里的值。 */
export function probePageProfile(): PageProfile {
  const text = (el: Element) => (el.textContent ?? "").trim();
  const visible = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const paragraphs = Array.from(document.querySelectorAll("p, article li")).filter((el) => visible(el) && text(el).length >= 40).length;

  const inputs = Array.from(document.querySelectorAll("input, textarea, select")).filter((el) => {
    const type = (el.getAttribute("type") ?? "text").toLowerCase();

    return visible(el) && !["hidden", "submit", "button", "reset", "image", "checkbox", "radio", "search"].includes(type);
  }).length;

  const body = (document.body?.innerText ?? "").slice(0, 4000);
  const letters = body.replace(/\s/g, "");
  const cjk = (letters.match(/[一-鿿]/g) ?? []).length;

  return {
    title: document.title,
    headings: Array.from(document.querySelectorAll("h2,h3")).filter(visible).length,
    paragraphs,
    inputs,
    tables: Array.from(document.querySelectorAll("table")).filter(visible).length,
    listItems: Array.from(document.querySelectorAll("li")).filter(visible).length,
    cjkRatio: letters.length ? cjk / letters.length : 0,
  };
}
