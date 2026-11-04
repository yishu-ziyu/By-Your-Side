import { redactUrlCredentials } from "./network.js";
import { extractSearchQuery } from "./request-confirm.js";
import { SENSITIVE_FIELD_NAME } from "./trace-sanitize.js";
import { redactCredentialText } from "./untrusted.js";

export const REF_ONLY = /^@?[a-z]?\d+$|^[#.][\w-]|^loc=|^\[[^\]]*\]$/i;

export const isStepName = (label: string): boolean => !!label.trim() && !REF_ONLY.test(label.trim());

export interface StepDetail { text: string; href?: string }

const UI_PARAMS = ["action", "ask", "kind", "options", "method", "target", "url", "label", "tabId", "filename", "fontSize", "key", "mode", "purpose", "say", "step", "to", "from", "type", "clear", "id", "selector"] as const;

const text = (value: unknown): string | null => typeof value === "string" && value ? value : null;
const clip = (value: string): string => value.length > 200 ? `${value.slice(0, 199)}…` : value;

function typedDetail(params: Record<string, unknown>, value: string | null): StepDetail | null {
  const label = text(params.label)?.trim();

  if (!value || !label || REF_ONLY.test(label) || SENSITIVE_FIELD_NAME.test(label) || /token|secret|api.?key|密钥/i.test(label) || redactCredentialText(value) !== value) return null;

  return { text: `填入：${clip(value)}` };
}

function stepDetail(name: string, params: Record<string, unknown>, query: string | null): StepDetail | null {
  switch (name) {
    case "navigate":
    case "open_tab": {
      const url = text(params.url);

      return url && /^https?:/i.test(url) ? { text: redactUrlCredentials(url), href: redactUrlCredentials(url) } : null;
    }
    case "fetch":
      return query ? { text: `搜索词：${clip(query)}` } : null;
    case "download_url": {
      const filename = text(params.filename);

      return filename ? { text: filename } : null;
    }
    case "fill":
      return typedDetail(params, text(params.value));
    case "type_text":
      return typedDetail(params, text(params.text));
    case "select_option": {
      const values = Array.isArray(params.values) ? params.values.filter((v): v is string => typeof v === "string") : [text(params.values)].filter((v): v is string => !!v);

      return typedDetail(params, values.join("、") || null);
    }
    default:
      return null;
  }
}

export function toolStartForUi<T extends { kind: "tool_start"; name: string; params: Record<string, unknown>; detail?: StepDetail }>(event: T): T {
  const raw = event.params ?? {};
  const query = text(raw.searchQuery) ?? (event.name === "fetch" ? extractSearchQuery(text(raw.body) ?? undefined, text(raw.url) ?? undefined) ?? null : null);
  const detail = event.detail ?? stepDetail(event.name, raw, query);
  const params: Record<string, unknown> = {};

  for (const key of UI_PARAMS) if (raw[key] !== undefined) params[key] = key === "url" && typeof raw[key] === "string" ? redactUrlCredentials(raw[key]) : raw[key];

  if (event.name === "mark" && raw.text !== undefined) params.text = raw.text;

  if (query) params.searchQuery = query;

  const { detail: _old, ...rest } = event;

  return { ...rest, params, ...(detail ? { detail } : {}) } as T;
}
