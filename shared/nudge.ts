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

export const NUDGE_SENTENCE_LIMIT = 20;

export const NUDGE_LABEL_LIMIT = 5;

/** 句子里对象是谁（商家、机构、网站名）的上限。 */
export const NUDGE_PARTY_LIMIT = 16;

export const NUDGE_EVIDENCE_LIMIT = 60;

export const NUDGE_PROMPT_LIMIT = 2000;

export interface NudgePage { title: string; url: string; text: string; selection?: string }

export interface NudgeRecentPage { title: string; url: string; excerpt: string }

export interface NudgeContext { page: NudgePage; recent: NudgeRecentPage[] }

export interface NudgeEvidence { text: string; url: string }

/** actionLabel 是句首的动词，也是按钮；sentence 是动词后面的宾语；party 是对象是谁，没有就不写。 */
export interface Nudge { sentence: string; evidence: NudgeEvidence[]; actionLabel: string; prompt: string; party?: string }

export type NudgeClientMessage = { type: 'nudge_request'; requestId: string; context: NudgeContext };

/** nudge 为 null：这次不建议（模型说不、回复不合格或调用失败都一样，不出卡）。 */
export interface NudgeResult { type: 'nudge_result'; requestId: string; nudge: Nudge | null }

const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(v);

const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;

const chars = (v: string) => [...v].length;

function isNudgePage(p: unknown): p is NudgePage {
  return !!p && typeof p === 'object'
    && 'title' in p && text(p.title, 500) && 'url' in p && text(p.url, 4000) && 'text' in p && text(p.text, NUDGE_TEXT_LIMIT)
    && (!('selection' in p) || p.selection === undefined || text(p.selection, NUDGE_SELECTION_LIMIT));
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
  return id(v.requestId) && isNudgeContext(v.context);
}

/** 模型回复里还没核对过的建议字段。 */
interface NudgeDraft { sentence: unknown; evidence: unknown; actionLabel: unknown; prompt: unknown; party?: unknown }

/** 模型回复的原样 JSON 对象：字段都还没核对。 */
export interface NudgeReply extends Partial<NudgeDraft> { offer?: unknown }

function isEvidence(e: unknown): e is NudgeEvidence {
  return !!e && typeof e === 'object'
    && 'text' in e && typeof e.text === 'string' && !!e.text.trim() && chars(e.text) <= NUDGE_EVIDENCE_LIMIT
    && 'url' in e && text(e.url, 4000);
}

function isNudge(n: NudgeDraft): n is Nudge {
  return typeof n.sentence === 'string' && !!n.sentence.trim() && chars(n.sentence) <= NUDGE_SENTENCE_LIMIT
    && typeof n.actionLabel === 'string' && !!n.actionLabel.trim() && chars(n.actionLabel) <= NUDGE_LABEL_LIMIT
    && typeof n.prompt === 'string' && !!n.prompt.trim() && n.prompt.length <= NUDGE_PROMPT_LIMIT
    && Array.isArray(n.evidence) && n.evidence.length >= 1 && n.evidence.length <= 3
    && n.evidence.every(isEvidence)
    && (n.party === undefined || (typeof n.party === 'string' && chars(n.party) <= NUDGE_PARTY_LIMIT));
}

export function isNudgeResult(v: NudgeResult): boolean {
  return id(v.requestId) && (v.nudge === null || isNudge(v.nudge));
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * 核对模型回复：offer 不是 true、字段不合格、出处不是从给定上下文原样摘的，一律当作不建议。
 * 出处必须指向给出的某一页，且引文能在那一页的标题、正文摘录或选区里原样找到——不让模型编事实或价格。
 */
export function acceptNudgeReply(reply: NudgeReply, context: NudgeContext): Nudge | null {
  if (reply.offer !== true) return null;

  // 对象名可有可无：空的、太长的直接不要，不连累整条建议。
  const party = typeof reply.party === 'string' && reply.party.trim() && chars(reply.party.trim()) <= NUDGE_PARTY_LIMIT ? reply.party.trim() : undefined;
  const candidate: NudgeDraft = { sentence: reply.sentence, evidence: reply.evidence, actionLabel: reply.actionLabel, prompt: reply.prompt, ...(party === undefined ? {} : { party }) };

  if (!isNudge(candidate)) return null;
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
  // 对象名也只能是上下文里出现过的；对不上就不写，不为它丢掉整条建议。
  const named = party !== undefined && [...sources.values()].some(source => source.includes(squash(party)));

  return {
    sentence: candidate.sentence.trim(),
    evidence: candidate.evidence.map(e => ({ text: e.text.trim(), url: e.url })),
    actionLabel: candidate.actionLabel.trim(),
    prompt: candidate.prompt.trim(),
    ...(named && party ? { party } : {}),
  };
}
