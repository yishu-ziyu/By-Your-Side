/**
 * 回答里不给用户看标签页编号：工具结果里带着「tab 29979739」，模型常把它抄进回答和卡片出处，用户看不懂也用不上。
 * 只改看得见的文字，不动属性：卡片按钮靠 data-card-tab 这类属性里的编号切到那一页。
 */

/** 现在开着的标签页编号：回答里单独出现、又恰好是其中之一的数，也是标签页编号。 */
const openTabIds = new Set<string>();

function refresh(): void {
  chrome.tabs?.query({}).then(tabs => {
    openTabIds.clear();

    for (const tab of tabs) if (tab.id !== undefined) openTabIds.add(String(tab.id));
  }, () => {});
}

refresh();
chrome.tabs?.onCreated.addListener(tab => { if (tab.id !== undefined) openTabIds.add(String(tab.id)); });
chrome.tabs?.onRemoved.addListener(id => { openTabIds.delete(String(id)); });

const TAB_WORD = "(?:tab|Tab|TAB|标签页|标签)";

/** 「· tab 29979739」这种接在后面的出处：连同分隔符一起去掉。 */
const TRAILING = new RegExp(`\\s*[·•|｜]\\s*${TAB_WORD}\\s*#?\\s*\\d{6,}`, "g");

/** 「新标签页 29979731」「tab 29979739」：留下「新标签页」，去掉编号。 */
const AFTER_WORD = new RegExp(`(${TAB_WORD})\\s*#?\\s*\\d{6,}`, "g");

export function hideTabIdText(text: string): string {
  const cleaned = text.replace(TRAILING, "").replace(AFTER_WORD, "$1");

  return cleaned.replace(/\b\d{6,12}\b/g, n => (openTabIds.has(n) ? "" : n)).replace(/（\s*，/g, "（").replace(/[ \t]{2,}/g, " ");
}

/** 渲染好的回答 HTML：逐个文字节点处理。 */
export function hideTabIdsInHtml(html: string): string {
  if (!/\d{6,}/.test(html)) return html;
  const template = document.createElement("template");
  template.innerHTML = html;
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const before = node.textContent ?? "";

    if (!/\d{6,}/.test(before)) continue;
    const after = hideTabIdText(before);

    if (after !== before) node.textContent = after;
  }

  return template.innerHTML;
}
