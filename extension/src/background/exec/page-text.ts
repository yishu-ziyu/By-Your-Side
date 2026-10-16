import { LEAD_SESSION_ID } from "../../../../shared/protocol.js";
import { assertNoPendingDialog } from "../page-events.js";
import { resolveReadableTab } from "../state.js";
import { pdfText, tabShowsPdf } from "./pdf-text.js";

/**
 * 发送前读页（#255、#260）：在隔离环境里取页面正文，不挂调试器。
 * 正文优先取 main / article，跳过导航、页眉页脚、侧栏和看不见的元素；没有元素编号，要动手时模型自己 snapshot。
 */
export async function pageText(params: { tabId?: number; max?: number }, sessionId: string = LEAD_SESSION_ID): Promise<{ text: string; totalChars: number; tabId: number; url?: string; title?: string }> {
  const tab = await resolveReadableTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");
  assertNoPendingDialog(tab.id);

  if (await tabShowsPdf(tab.id)) {
    const text = await pdfText(tab.id, tab.url ?? "");
    const max = params.max ?? 12_000;

    return { text: text.slice(0, max), totalChars: text.length, tabId: tab.id, url: tab.url, title: tab.title };
  }

  // 不等页面空闲：页面还在加载时默认注入会卡到加载完（见 snapshot.ts 的同一处说明）。
  const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, injectImmediately: true, world: "ISOLATED", func: readMainText, args: [params.max ?? 12_000] });
  const value = result?.result;

  if (!value) throw new Error("读不到这个页面的正文");

  return { ...value, tabId: tab.id };
}

/** 在页面里执行：只能用页面环境，不能引用外面的变量。 */
function readMainText(max: number): { text: string; totalChars: number; url: string; title: string } {
  const SKIP = new Set(["NAV", "HEADER", "FOOTER", "ASIDE", "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "IFRAME", "BUTTON", "SELECT", "FORM"]);
  const visible = (el: Element) => el.checkVisibility();
  const candidates = [...document.querySelectorAll<HTMLElement>("main, article, [role=main]")].filter(visible);
  const root = candidates.sort((a, b) => b.innerText.length - a.innerText.length)[0] ?? document.body;
  const out: string[] = [];

  const walk = (el: Element, inCell: boolean): void => {
    if (SKIP.has(el.tagName) || el.getAttribute("aria-hidden") === "true" || el.getAttribute("role") === "navigation" || !visible(el)) return;
    const display = getComputedStyle(el).display;
    // 表格一行一行：单元格之间空格，信息框不会一格一行。
    const cell = display === "table-cell";
    const block = !cell && !inCell && !display.startsWith("inline");
    const level = /^H([1-6])$/.exec(el.tagName)?.[1];

    out.push(cell ? " " : block ? "\n" : "");

    if (level) out.push(`${"#".repeat(Number(level))} `);

    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) out.push(node.textContent ?? "");
      else if (node.nodeType === Node.ELEMENT_NODE) walk(node as Element, inCell || cell);
    }

    out.push(cell ? " " : block ? "\n" : "");
  };

  if (root) walk(root, false);
  const text = out.join("").replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  return { text: text.slice(0, max), totalChars: text.length, url: location.href, title: document.title };
}
