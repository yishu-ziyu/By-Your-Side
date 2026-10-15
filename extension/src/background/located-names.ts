/**
 * 读页时拿到过位置的控件：名字 → ref（backendDOMNodeId），按标签页记。
 * 侧栏用它给回答里提到的按钮加虚线、点了在页面上指出来（answer-page-refs 验收）。
 * 只认读页结果里真的出现过的控件，不按回答里的字去页面上现找：现找会把同名的别处元素当成助手说的那个。
 * 同名出现两次以上就不记：说不清是哪一个，宁可不画线。
 */

const CONTROL_ROLES = new Set(["button", "link", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "checkbox", "radio", "combobox", "textbox", "searchbox", "switch", "option", "slider", "spinbutton", "popupbutton"]);

const LINE = /\[ref=(\d+)\]\s+([A-Za-z]+)\s+"((?:[^"\\]|\\.){1,40})"/g;

const byTab = new Map<number, Map<string, number | null>>();

/** 名字的比较口径：去掉空白，回答里写「导出」、页面上是「 导出 」也算同一个。 */
export function nameKey(name: string): string {
  return name.replace(/\s+/g, "").trim();
}

/** 一次读页的正文：并入这一页已记下的控件。 */
export function recordLocatedNames(tabId: number, snapshotText: string): void {
  const known = byTab.get(tabId) ?? new Map<string, number | null>();

  for (const match of snapshotText.matchAll(LINE)) {
    const ref = Number(match[1]);
    const role = match[2]!.toLowerCase();
    const key = nameKey(match[3]!.replace(/\\(.)/g, "$1"));

    if (!CONTROL_ROLES.has(role) || !key || !Number.isSafeInteger(ref)) continue;
    const had = known.get(key);
    known.set(key, had === undefined || had === ref ? ref : null);
  }

  byTab.set(tabId, known);
}

export function locatedRef(tabId: number, name: string): number | undefined {
  return byTab.get(tabId)?.get(nameKey(name)) ?? undefined;
}

// 导航后 backendDOMNodeId 全部失效。
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") byTab.delete(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => { byTab.delete(tabId); });
