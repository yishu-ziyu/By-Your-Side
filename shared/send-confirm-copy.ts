/**
 * 确认卡给人看的句子：先说要做什么，技术细节另放。读不到的字段不编。
 */
import { classifyRequest, siteDisplayName } from "./request-confirm.js";
import { SEND_CONFIRM_MS } from "./timeouts.js";
import type { SendConfirmView } from "./protocol.js";

export interface ConfirmCopy {
  headline: string;
  impact?: string;
  quote?: string;
  yes: string;
  no: string;
  kind: "search" | "send" | "request";
  tech?: { method: string; path: string; body?: string };
}

function clipQuote(text: string): string {
  const value = text.replace(/…$/, "").replace(/\s+/g, " ").trim();
  return value.length > 160 ? `${value.slice(0, 159)}…` : value;
}

function looksJson(text: string): boolean {
  const t = text.trim();
  return t.startsWith("{") || t.startsWith("[");
}

export function confirmCopy(view: Pick<SendConfirmView, "host" | "label" | "content" | "recipient" | "route" | "kind" | "query" | "path" | "method" | "body">): ConfirmCopy {
  const site = siteDisplayName(view.host);
  const classified = view.route === "request"
    ? classifyRequest({ method: view.method ?? "POST", url: view.path ? `https://${view.host}${view.path}` : `https://${view.host}/`, body: view.body ?? view.content })
    : null;
  const kind = view.kind ?? (classified?.intent === "search" ? "search" : view.route === "request" ? "request" : "send");
  const query = view.query ?? classified?.query;
  const quoteSource = query ?? (view.content && !looksJson(view.content) ? view.content : undefined);
  const quote = quoteSource ? clipQuote(quoteSource) : undefined;
  const path = view.path ?? (view.route === "request" && /^[A-Z]+ \//.test(view.label) ? view.label.replace(/^[A-Z]+ /, "") : undefined);
  const method = view.method ?? (view.route === "request" ? "POST" : undefined);
  const tech = view.route === "request" || path || view.body
    ? { method: method ?? "POST", path: path ?? view.label, ...(view.body || (view.content && looksJson(view.content)) ? { body: view.body ?? view.content } : {}) }
    : undefined;

  if (kind === "search") {
    const what = quote ? `「${quote}」` : "这项内容";
    return {
      headline: site ? `要在 ${site} 上搜索${what}吗？` : `要搜索${what}吗？`,
      impact: "只是查找，不会发布或修改任何内容。",
      quote,
      yes: "允许搜索",
      no: "先不要",
      kind,
      tech,
    };
  }

  if (kind === "send") {
    const named = view.label.trim();
    const via = named ? `点「${named}」` : "发出去";
    const to = view.recipient ? `发给 ${view.recipient}` : via;
    const bit = quote ? `${via}把这段内容${view.recipient ? `发给 ${view.recipient}` : "发出去"}` : to;
    return {
      headline: site ? `要在 ${site} 上${bit}吗？` : `要${bit}吗？`,
      quote,
      yes: "发送",
      no: "先不发",
      kind,
      tech,
    };
  }

  return {
    headline: site ? `要在 ${site} 上提交这项内容吗？` : "要提交这项内容吗？",
    impact: "提交后可能无法撤回。",
    quote,
    yes: "允许提交",
    no: "先不要",
    kind,
    tech,
  };
}

export function confirmCountdown(now: number, startedAt: number | undefined, expiresAt: number | undefined): string {
  const start = startedAt ?? (expiresAt !== undefined ? expiresAt - SEND_CONFIRM_MS : now);
  const end = expiresAt ?? start + SEND_CONFIRM_MS;
  const waited = Math.max(0, Math.round((now - start) / 1000));
  const left = Math.max(0, Math.round((end - now) / 1000));
  const leftMin = Math.max(1, Math.ceil(left / 60));

  if (left >= 60) return `已等 ${waited} 秒 · ${leftMin} 分钟后自动取消`;
  if (left > 0) return `已等 ${waited} 秒 · 还剩 ${left} 秒`;
  return `已等 ${waited} 秒 · 已到时`;
}
