import { validMemoryId, validMemoryVersion } from "./memory.js";

export const NUDGE_TEXT_LIMIT = 4000;

export const NUDGE_EXCERPT_LIMIT = 300;

export const NUDGE_RECENT_LIMIT = 5;

export const NUDGE_SELECTION_LIMIT = 2000;

const NUDGE_SENTENCE_LIMIT = 24;

const NUDGE_LABEL_LIMIT = 5;

const NUDGE_PARTY_LIMIT = 16;

const NUDGE_EVIDENCE_LIMIT = 60;

const QUOTE_LIMIT = 300;

const NUDGE_PROMPT_LIMIT = 2000;

export interface NudgeLink { title: string; url: string }
export interface NudgeMemory { id: string; version: number; text: string }
export interface NudgePreparation { memory: NudgeMemory; links: NudgeLink[] }
export interface NudgePage { title: string; url: string; text: string; selection?: string; links?: NudgeLink[] }

export interface NudgeRecentPage { title: string; url: string; excerpt: string }

export interface NudgeContext { page: NudgePage; recent: NudgeRecentPage[] }

export interface NudgeEvidence { text: string; url: string }

export interface Nudge { sentence: string; evidence: NudgeEvidence[]; actionLabel: string; prompt: string; party?: string; preparation?: NudgePreparation }

export type NudgeClientMessage =
  | { type: 'nudge_request'; requestId: string; context: NudgeContext }
  | { type: 'nudge_validate'; requestId: string; memory: Pick<NudgeMemory, 'id' | 'version'>; url: string };

export type NudgeResult =
  | { type: 'nudge_result'; requestId: string; nudge: Nudge | null }
  | { type: 'nudge_validation'; requestId: string; valid: boolean };

const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(v);

const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;

const chars = (v: string) => [...v].length;

export function isNudgeLink(v: unknown): v is NudgeLink {
  if (!v || typeof v !== 'object' || !('title' in v) || !text(v.title, 120) || !('url' in v) || !text(v.url, 2000)) return false;
  try { const url = new URL(v.url); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}

function isNudgeMemory(v: unknown): v is NudgeMemory {
  return !!v && typeof v === 'object' && 'id' in v && validMemoryId(v.id)
    && 'version' in v && validMemoryVersion(v.version) && 'text' in v && text(v.text, 2000) && !!v.text.trim();
}

export function isNudgePreparation(v: unknown): v is NudgePreparation {
  return !!v && typeof v === 'object' && 'memory' in v && isNudgeMemory(v.memory)
    && 'links' in v && Array.isArray(v.links) && v.links.length >= 1 && v.links.length <= 3 && v.links.every(isNudgeLink);
}

function isNudgePage(p: unknown): p is NudgePage {
  return !!p && typeof p === 'object'
    && 'title' in p && text(p.title, 500) && 'url' in p && text(p.url, 4000) && 'text' in p && text(p.text, NUDGE_TEXT_LIMIT)
    && (!('selection' in p) || p.selection === undefined || text(p.selection, NUDGE_SELECTION_LIMIT))
    && (!('links' in p) || p.links === undefined || (Array.isArray(p.links) && p.links.length <= 80 && p.links.every(isNudgeLink)));
}

function isRecentPage(r: unknown): r is NudgeRecentPage {
  return !!r && typeof r === 'object'
    && 'title' in r && text(r.title, 500) && 'url' in r && text(r.url, 4000) && 'excerpt' in r && text(r.excerpt, NUDGE_EXCERPT_LIMIT);
}

function isNudgeContext(v: unknown): v is NudgeContext {
  return !!v && typeof v === 'object'
    && 'page' in v && isNudgePage(v.page)
    && 'recent' in v && Array.isArray(v.recent) && v.recent.length <= NUDGE_RECENT_LIMIT && v.recent.every(isRecentPage);
}

export function isNudgeClientMessage(v: NudgeClientMessage): boolean {
  if (!id(v.requestId)) return false;
  if (v.type === 'nudge_request') return isNudgeContext(v.context);
  return !!v.memory && validMemoryId(v.memory.id) && validMemoryVersion(v.memory.version) && isNudgeLink({ title: '', url: v.url });
}

interface NudgeDraft { sentence: unknown; evidence: unknown; actionLabel: unknown; prompt: unknown; party?: unknown; kind?: unknown; memoryId?: unknown; links?: unknown; preparation?: unknown }

interface NudgeReply extends Partial<NudgeDraft> { offer?: unknown }

const width = (v: string) => [...v].reduce((sum, ch) => sum + (ch.codePointAt(0)! < 0x2e80 ? 0.5 : 1), 0);

const isEvidence = (max: number) => (e: unknown): e is NudgeEvidence => !!e && typeof e === 'object'
  && 'text' in e && typeof e.text === 'string' && !!e.text.trim() && chars(e.text) <= max
  && 'url' in e && text(e.url, 4000);

function isNudge(n: NudgeDraft, quoteMax = NUDGE_EVIDENCE_LIMIT): n is Nudge {
  return typeof n.sentence === 'string' && !!n.sentence.trim() && width(n.sentence) <= NUDGE_SENTENCE_LIMIT
    && typeof n.actionLabel === 'string' && !!n.actionLabel.trim() && width(n.actionLabel) <= NUDGE_LABEL_LIMIT
    && typeof n.prompt === 'string' && !!n.prompt.trim() && n.prompt.length <= NUDGE_PROMPT_LIMIT
    && Array.isArray(n.evidence) && n.evidence.length >= 1 && n.evidence.length <= 3
    && n.evidence.every(isEvidence(quoteMax))
    && (n.party === undefined || (typeof n.party === 'string' && width(n.party) <= NUDGE_PARTY_LIMIT))
    && (n.preparation === undefined || isNudgePreparation(n.preparation));
}

export function isNudgeResult(v: NudgeResult): boolean {
  return id(v.requestId) && (v.type === 'nudge_validation' ? typeof v.valid === 'boolean' : (v.nudge === null || isNudge(v.nudge)));
}

const clipQuote = (quote: string) => (chars(quote) <= NUDGE_EVIDENCE_LIMIT ? quote : `${[...quote].slice(0, NUDGE_EVIDENCE_LIMIT - 1).join('').trimEnd()}…`);

const squash = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

export function acceptNudgeReply(reply: NudgeReply, context: NudgeContext, memories: readonly NudgeMemory[] = []): Nudge | null {
  if (reply.offer !== true) return null;
  if (reply.kind !== undefined && reply.kind !== 'prepare' && reply.kind !== 'task') return null;
  const preparing = reply.kind === 'prepare';
  if (!preparing && (reply.memoryId !== undefined || reply.links !== undefined)) return null;
  if (!preparing && typeof reply.actionLabel === 'string' && reply.actionLabel.trim() === '准备') return null;

  const party = typeof reply.party === 'string' && reply.party.trim() && width(reply.party.trim()) <= NUDGE_PARTY_LIMIT ? reply.party.trim() : undefined;
  const candidate: NudgeDraft = { sentence: reply.sentence, evidence: reply.evidence, actionLabel: reply.actionLabel, prompt: preparing ? '准备卡上列出的入口。' : reply.prompt, ...(party === undefined ? {} : { party }) };

  if (!isNudge(candidate, QUOTE_LIMIT)) return null;
  const sources = new Map<string, string>();
  const add = (url: string, ...parts: (string | undefined)[]) => sources.set(url, `${sources.get(url) ?? ''} ${squash(parts.filter(Boolean).join(' '))}`);
  add(context.page.url, context.page.title, context.page.text, context.page.selection);

  for (const page of context.recent) add(page.url, page.title, page.excerpt);

  const grounded = candidate.evidence.every(e => {
    const source = sources.get(e.url);
    const quote = squash(e.text).replace(/^["'“”「」『』]+|["'“”「」『』]+$/gu, '');

    return source !== undefined && !!quote && source.includes(quote);
  });

  if (!grounded) return null;
  let preparation: NudgePreparation | undefined;
  if (preparing) {
    if (candidate.evidence.some(e => e.url !== context.page.url)) return null;
    const memory = memories.find(entry => entry.id === reply.memoryId);
    if (!memory || !Array.isArray(reply.links) || reply.links.length < 1 || reply.links.length > 3) return null;
    const urls: unknown[] = reply.links;
    if (new Set(urls).size !== urls.length) return null;
    const links = urls.map(url => context.page.links?.find(link => link.url === url));
    if (links.some(link => !link)) return null;
    preparation = { memory, links: links.filter((link): link is NudgeLink => !!link) };
  }
  const named = party !== undefined && chars(party) >= 2 && candidate.evidence.some(e => sources.get(e.url)?.includes(squash(party)));
  const label = candidate.actionLabel.trim();
  const object = candidate.sentence.trim().startsWith(label) && candidate.sentence.trim().length > label.length ? candidate.sentence.trim().slice(label.length).trim() : candidate.sentence.trim();

  return {
    sentence: preparation ? `这页的 ${preparation.links.length} 个阅读入口` : object,
    evidence: candidate.evidence.map(e => ({ text: clipQuote(e.text.trim()), url: e.url })),
    actionLabel: preparation ? '准备' : label,
    prompt: candidate.prompt.trim(),
    ...(named && party ? { party } : {}),
    ...(preparation ? { preparation } : {}),
  };
}
