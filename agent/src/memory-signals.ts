/**
 * 沟通方式的证据累积：每轮复盘（memory-review.ts）判出的抱怨、要求和认可按方面攒起来，够了才问用户要不要记成做法。
 * 一句抱怨可能只是这一次不满意，所以要么用户明说「以后都」，要么「抱怨 → 改了 → 认可」成对出现，
 * 要么同一方面在两个不同的回合里被抱怨过，才问。问过的方面不再问（用户删掉那条做法后也不会自己冒出来）。
 * 纯逻辑，不读时钟，状态是纯 JSON。
 */
import { REVIEW_ASPECTS, type ReviewAspect, type TurnReview } from "./memory-review.js";

export interface StyleSignal {
  aspect: ReviewAspect;
  feedback: TurnReview["feedback"];
  conversationId: string;
  turnKey: string;
  at: number;
  rule: string;
  evidence: string;
}

export interface StyleState {
  signals: StyleSignal[];
  /** 问过的方面 → 问的时间。 */
  asked: Partial<Record<ReviewAspect, number>>;
}

export interface StyleAsk {
  aspect: ReviewAspect;
  rule: string;
  /** 依据：用户说过的原话，最早的在前。 */
  quotes: string[];
  reason: "lasting" | "praised" | "repeated";
}

const EXPIRE_MS = 30 * 24 * 60 * 60 * 1000;

const MAX_SIGNALS = 200;

export function emptyStyleState(): StyleState {
  return { signals: [], asked: {} };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const isAspect = (value: unknown): value is ReviewAspect => (REVIEW_ASPECTS as readonly unknown[]).includes(value);

function isSignal(value: unknown): value is StyleSignal {
  return isRecord(value) && isAspect(value.aspect) && typeof value.feedback === "string" && typeof value.conversationId === "string"
    && typeof value.turnKey === "string" && typeof value.at === "number" && typeof value.rule === "string" && typeof value.evidence === "string";
}

/** 存储里读出的文本：形状不对的部分丢掉，只是少了些证据。 */
export function parseStyleState(text: string | null): StyleState {
  try {
    const raw: unknown = JSON.parse(text ?? "null");

    if (!isRecord(raw)) return emptyStyleState();
    const asked: StyleState["asked"] = {};

    if (isRecord(raw.asked)) for (const [aspect, at] of Object.entries(raw.asked)) if (isAspect(aspect) && typeof at === "number") asked[aspect] = at;

    return { signals: Array.isArray(raw.signals) ? raw.signals.filter(isSignal) : [], asked };
  } catch {
    return emptyStyleState();
  }
}

export function observeStyle(state: StyleState, signal: StyleSignal, lasting: boolean): { state: StyleState; ask: StyleAsk | null } {
  const signals = [...state.signals.filter(old => signal.at - old.at <= EXPIRE_MS && old.turnKey !== signal.turnKey), signal].slice(-MAX_SIGNALS);
  const next: StyleState = { signals, asked: { ...state.asked } };

  if (state.asked[signal.aspect] !== undefined || signal.feedback === "none") return { state: next, ask: null };
  const same = signals.filter(old => old.aspect === signal.aspect);
  const unhappy = same.filter(old => old.feedback === "complaint" || old.feedback === "request");
  let reason: StyleAsk["reason"] | null = null;

  if (lasting && signal.feedback !== "praise") reason = "lasting";
  else if (signal.feedback === "praise" && unhappy.some(old => old.conversationId === signal.conversationId)) reason = "praised";
  else if (signal.feedback === "complaint" && new Set(same.filter(old => old.feedback === "complaint").map(old => old.turnKey)).size >= 2) reason = "repeated";

  if (!reason) return { state: next, ask: null };
  next.asked[signal.aspect] = signal.at;
  const quotes = [...new Set((reason === "lasting" ? [signal] : same.filter(old => old.feedback !== "none")).map(old => old.evidence))].slice(-3);

  // 认可的那句描述的是已经奏效的做法，规则取它；其余取最近一句。
  return { state: next, ask: { aspect: signal.aspect, rule: signal.rule, quotes, reason } };
}
