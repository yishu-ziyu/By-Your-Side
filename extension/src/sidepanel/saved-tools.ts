import { SAVED_TOOLS_KEY, sanitizeSavedTools, siteOf, type SavedTool } from "../../../shared/saved-tools.js";
import { isMiniAppsOn, MINI_APPS_KEY } from "../shared/mini-apps.js";

let tools: SavedTool[] = [];
let enabled = false;
const listeners = new Set<() => void>();

const changed = () => { for (const listener of listeners) listener(); };

void chrome.storage.local.get([SAVED_TOOLS_KEY, MINI_APPS_KEY]).then(stored => {
  tools = sanitizeSavedTools(stored[SAVED_TOOLS_KEY]);
  enabled = isMiniAppsOn(stored[MINI_APPS_KEY]);
  changed();
}).catch(() => {});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;

  if (SAVED_TOOLS_KEY in changes) tools = sanitizeSavedTools(changes[SAVED_TOOLS_KEY].newValue);

  if (MINI_APPS_KEY in changes) enabled = isMiniAppsOn(changes[MINI_APPS_KEY].newValue);

  if (SAVED_TOOLS_KEY in changes || MINI_APPS_KEY in changes) changed();
});

export const onSavedToolsChange = (listener: () => void): void => { listeners.add(listener); };

export const allSavedTools = (): SavedTool[] => enabled ? tools : [];

export const savedToolsFor = (url: string | null): SavedTool[] => {
  const site = siteOf(url);

  return site ? allSavedTools().filter(tool => tool.site === site) : [];
};

export const savedToolWith = (html: string): SavedTool | undefined => tools.find(tool => tool.html === html);

async function write(next: (current: SavedTool[]) => SavedTool[]): Promise<void> {
  const stored = await chrome.storage.local.get(SAVED_TOOLS_KEY);

  await chrome.storage.local.set({ [SAVED_TOOLS_KEY]: next(sanitizeSavedTools(stored[SAVED_TOOLS_KEY])) });
}

export const saveTool = (tool: Omit<SavedTool, "id">): Promise<void> => write(current => [{ ...tool, id: crypto.randomUUID() }, ...current.filter(item => item.html !== tool.html)]);

export const removeTool = (html: string): Promise<void> => write(current => current.filter(item => item.html !== html));
