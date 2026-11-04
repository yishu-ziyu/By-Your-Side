const CONTROL_ROLES = new Set(["button", "link", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "checkbox", "radio", "combobox", "textbox", "searchbox", "switch", "option", "slider", "spinbutton", "popupbutton"]);

const LINE = /\[ref=(\d+)\]\s+([A-Za-z]+)\s+"((?:[^"\\]|\\.){1,40})"/g;

const byTab = new Map<number, Map<string, number | null>>();

const namesByTab = new Map<number, Map<number, string>>();

const circledByTab = new Map<number, Map<string, number>>();

function nameKey(name: string): string {
  return name.replace(/\s+/g, "").trim();
}

export function recordLocatedNames(tabId: number, snapshotText: string): void {
  const known = byTab.get(tabId) ?? new Map<string, number | null>();

  for (const match of snapshotText.matchAll(LINE)) {
    const ref = Number(match[1]);
    const role = match[2]!.toLowerCase();
    const key = nameKey(match[3]!.replace(/\\(.)/g, "$1"));

    if (!CONTROL_ROLES.has(role) || !key || !Number.isSafeInteger(ref)) continue;
    const refNames = namesByTab.get(tabId) ?? new Map<number, string>();
    refNames.set(ref, match[3]!.replace(/\\(.)/g, "$1").replace(/\s+/g, " ").trim());
    namesByTab.set(tabId, refNames);
    const had = known.get(key);
    known.set(key, had === undefined || had === ref ? ref : null);
  }

  byTab.set(tabId, known);
}

export function locatedRef(tabId: number, name: string): number | undefined {
  return circledByTab.get(tabId)?.get(nameKey(name)) ?? byTab.get(tabId)?.get(nameKey(name)) ?? undefined;
}

export function recordCircled(tabId: number, ref: number): void {
  const name = namesByTab.get(tabId)?.get(ref);

  if (!name) return;
  const circled = circledByTab.get(tabId) ?? new Map<string, number>();
  circled.set(nameKey(name), ref);
  circledByTab.set(tabId, circled);
}

export function circledNames(tabId: number): string[] {
  const refNames = namesByTab.get(tabId);

  return [...(circledByTab.get(tabId)?.values() ?? [])].flatMap(ref => refNames?.get(ref) ?? []);
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") { byTab.delete(tabId); namesByTab.delete(tabId); circledByTab.delete(tabId); }
});

chrome.tabs.onRemoved.addListener((tabId) => { byTab.delete(tabId); namesByTab.delete(tabId); circledByTab.delete(tabId); });
