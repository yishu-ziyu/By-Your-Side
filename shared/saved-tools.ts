export const SAVED_TOOLS_KEY = "sideagent_saved_tools";

export const TOOL_PAGE_MESSAGE = "TOOL_PAGE";

export interface SavedTool { id: string; name: string; site: string; html: string; canSeek: boolean }

export type ToolCaptionStatus = "ok" | "none" | "login" | "unavailable";

export interface ToolCaptionsReply { status: ToolCaptionStatus; message: string; title: string; language: string; automatic: boolean; cues: Array<{ start: number; end: number; text: string }> }

export type ToolPageRequest =
  | { type: typeof TOOL_PAGE_MESSAGE; action: "captions"; tabId: number }
  | { type: typeof TOOL_PAGE_MESSAGE; action: "seek"; tabId: number; url: string; seconds: number };

export const appMarkup = (tool: Pick<SavedTool, "name" | "html">): string => `<app title="${tool.name.replace(/["<>]/g, "")}">${tool.html}</app>`;

export function siteOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);

    return ["http:", "https:"].includes(parsed.protocol) ? parsed.origin : null;
  } catch { return null; }
}

export function sanitizeSavedTools(raw: unknown): SavedTool[] {
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((item): SavedTool[] => {
    const tool = item && typeof item === "object" ? item as Record<string, unknown> : null;

    if (!tool || typeof tool.id !== "string" || !tool.id || typeof tool.name !== "string" || !tool.name.trim() || tool.name.length > 80) return [];

    if (typeof tool.site !== "string" || siteOf(tool.site) !== tool.site || typeof tool.html !== "string" || !tool.html || tool.html.length > 60_000) return [];

    return [{ id: tool.id, name: tool.name, site: tool.site, html: tool.html, canSeek: tool.canSeek === true }];
  }).slice(0, 50);
}
