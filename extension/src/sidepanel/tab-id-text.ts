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

const TRAILING = new RegExp(`\\s*[·•|｜]\\s*${TAB_WORD}\\s*#?\\s*\\d{6,}`, "g");

const PAREN = new RegExp(`\\s*[（(]\\s*${TAB_WORD}\\s*[:：#]?\\s*\\d{6,}\\s*[)）]`, "g");

const BARE_PAREN = /\s*[（(]\s*(?:编号\s*[:：]?\s*)?(\d{6,12})\s*[)）]/g;

const AFTER_WORD = new RegExp(`(${TAB_WORD})\\s*#?\\s*\\d{6,}(?:\\s+(?=[\\u4e00-\\u9fff，。、；：）]))?`, "g");

export function hideTabIdText(text: string): string {
  const cleaned = text.replace(TRAILING, "").replace(PAREN, "").replace(AFTER_WORD, "$1");

  return cleaned.replace(BARE_PAREN, (all: string, n: string) => (openTabIds.has(n) ? "" : all)).replace(/\b\d{6,12}\b/g, n => (openTabIds.has(n) ? "" : n)).replace(/（\s*，/g, "（").replace(/[ \t]{2,}/g, " ");
}

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
