import { validMemoryId, validMemoryVersion } from "./memory.js";

/**
 * 主动建议（#52）：用户在读的网页里有可做的事时，页角递一张小卡——一句话、一行出处、一个按钮。
 * 什么时候值得建议由模型看真实上下文判断，这里只定消息形状和对模型回复的核对。
 */

/** 当前页正文摘录上限。 */
export const NUDGE_TEXT_LIMIT = 4000;

/** 最近看过的页每页摘录上限。 */
export const NUDGE_EXCERPT_LIMIT = 300;

/** 最多带几页最近看过的。 */
export const NUDGE_RECENT_LIMIT = 5;

export const NUDGE_SELECTION_LIMIT = 2000;

/**
 * 句子、动词、对象名的上限按显示宽度算：汉字算 1，英文字母、数字、空格算半个（「AirPods Pro 3」算 6.5）。
 * 10-08 真实模型试跑：按字数算时，带英文型号的句子大多被拦下。
 */
export const NUDGE_SENTENCE_LIMIT = 24;

export const NUDGE_LABEL_LIMIT = 5;

/** 句子里对象是谁（商家、机构、网站名）的上限。 */
export const NUDGE_PARTY_LIMIT = 16;

/** 卡上显示的出处引文上限；模型给的引文可以更长，核对原文后截到这么长。 */
export const NUDGE_EVIDENCE_LIMIT = 60;

/** 模型给的出处引文上限：超了才算不合格。 */
const QUOTE_LIMIT = 300;

export const NUDGE_PROMPT_LIMIT = 2000;

export interface NudgeLink { title: string; url: string }
export interface NudgeMemory { id: string; version: number; text: string }
export interface NudgePreparation { memory: NudgeMemory; links: NudgeLink[] }
export interface NudgePage { title: string; url: string; text: string; selection?: string; links?: NudgeLink[] }

export interface NudgeRecentPage { title: string; url: string; excerpt: string }

export interface NudgeContext { page: NudgePage; recent: NudgeRecentPage[] }

export interface NudgeEvidence { text: string; url: string }

/** actionLabel 是句首的动词，也是按钮；sentence 是动词后面的宾语；party 是对象是谁，没有就不写。 */
export interface Nudge { sentence: string; evidence: NudgeEvidence[]; actionLabel: string; prompt: string; party?: string; preparation?: NudgePreparation }

export type NudgeClientMessage =
  | { type: 'nudge_request'; requestId: string; context: NudgeContext }
  | { type: 'nudge_validate'; requestId: string; memory: Pick<NudgeMemory, 'id' | 'version'>; url: string };

/** nudge 为 null：这次不建议（模型说不、回复不合格或调用失败都一样，不出卡）。 */
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

export function isNudgeMemory(v: unknown): v is NudgeMemory {
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

export function isNudgeContext(v: unknown): v is NudgeContext {
  return !!v && typeof v === 'object'
    && 'page' in v && isNudgePage(v.page)
    && 'recent' in v && Array.isArray(v.recent) && v.recent.length <= NUDGE_RECENT_LIMIT && v.recent.every(isRecentPage);
}

export function isNudgeClientMessage(v: NudgeClientMessage): boolean {
  if (!id(v.requestId)) return false;
  if (v.type === 'nudge_request') return isNudgeContext(v.context);
  return !!v.memory && validMemoryId(v.memory.id) && validMemoryVersion(v.memory.version) && isNudgeLink({ title: '', url: v.url });
}

/** 模型回复里还没核对过的建议字段。 */
interface NudgeDraft { sentence: unknown; evidence: unknown; actionLabel: unknown; prompt: unknown; party?: unknown; kind?: unknown; memoryId?: unknown; links?: unknown; preparation?: unknown }

/** 模型回复的原样 JSON 对象：字段都还没核对。 */
export interface NudgeReply extends Partial<NudgeDraft> { offer?: unknown }

/** 显示宽度：汉字等全角字符算 1，英文字母、数字、空格、半角标点算半个。 */
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

/** 原文引文太长时截前一段：截下来的仍是原文。 */
const clipQuote = (quote: string) => (chars(quote) <= NUDGE_EVIDENCE_LIMIT ? quote : `${[...quote].slice(0, NUDGE_EVIDENCE_LIMIT - 1).join('').trimEnd()}…`);

const squash = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * 核对模型回复：offer 不是 true、字段不合格、出处不是从给定上下文原样摘的，一律当作不建议。
 * 出处必须指向给出的某一页，且引文能在那一页的标题、正文摘录或选区里原样找到——不让模型编事实或价格。
 */
export function acceptNudgeReply(reply: NudgeReply, context: NudgeContext, memories: readonly NudgeMemory[] = []): Nudge | null {
  if (reply.offer !== true) return null;
  if (reply.kind !== undefined && reply.kind !== 'prepare' && reply.kind !== 'task') return null;
  const preparing = reply.kind === 'prepare';
  if (!preparing && (reply.memoryId !== undefined || reply.links !== undefined)) return null;
  if (!preparing && typeof reply.actionLabel === 'string' && reply.actionLabel.trim() === '准备') return null;

  // 对象名可有可无：空的、太长的直接不要，不连累整条建议。
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
  // 对象名也只能是出处那几页里出现过的；太短或对不上就不写，不为它丢掉整条建议。
  const named = party !== undefined && chars(party) >= 2 && candidate.evidence.some(e => sources.get(e.url)?.includes(squash(party)));
  const label = candidate.actionLabel.trim();
  // 卡上读作「动词 + 宾语」：模型把动词又写进句首时去掉，免得读成「申请申请晚退房」。
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
