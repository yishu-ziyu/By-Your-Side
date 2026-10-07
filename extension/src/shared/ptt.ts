/**
 * 按住说话在网页、后台、离屏文档之间传的消息（#125，docs/evals/20261007-ptt-dictation.md）。
 * 网页 → 后台：PttPageMessage；后台 → 离屏文档：PttCommand，回 PttReply。
 */
import type { DictationResult } from "../inproc/ptt-dictation.js";

/** 网页脚本发给后台：按住开始、松开、取消。 */
export interface PttPageMessage { type: "ptt"; phase: "start" | "stop" | "cancel" }

/** 后台发给离屏文档的命令；target 用来和别的扩展消息分开。 */
export interface PttCommand { target: "inproc-ptt"; phase: "start" | "stop" | "cancel" }

export const PTT_TARGET = "inproc-ptt";

/** 开始：麦克风拿到了（ok）或拿不到；结束：听写结果。 */
export type PttReply = { ok: true; text?: string } | Extract<DictationResult, { ok: false }> | { ok: false; reason: "permission" | "device"; message?: string };

/** 扩展消息到了才知道是不是按住说话的：先当作可能缺字段的 PttPageMessage 来查。 */
export const isPttPageMessage = (raw: Partial<PttPageMessage> | null | undefined): raw is PttPageMessage =>
  raw?.type === "ptt" && (raw.phase === "start" || raw.phase === "stop" || raw.phase === "cancel");

/**
 * 网页底部胶囊现在显示什么（#125 第 2 步，docs/evals/20261007-ptt-capsule.md）。heard 是听写出的那句话。
 * failed 带 heard：话没交给助手，可以重发；不带：没听到或听写失败。
 */
export type PttCapsule =
  | { phase: "listening" }
  | { phase: "transcribing" }
  | { phase: "failed"; reason: string; heard?: string }
  | { phase: "doing"; heard: string; step: string | null }
  | { phase: "waiting"; heard: string; reason: string }
  | { phase: "done"; heard: string; result: string; left: string | null }
  | { phase: "stopped"; heard: string };

/** 后台 → 网页：换胶囊内容，capsule 为 null 时收起。 */
export const PTT_CAPSULE = "ptt_capsule";

/** 离屏文档 → 后台 → 网页：按住时的音量（0–1），画声波用。 */
export const PTT_LEVEL = "ptt_level";

export interface PttLevelMessage { type: typeof PTT_LEVEL; level: number }

/** 网页 → 后台：胶囊上的「停」（含 Esc）、「重发」，以及胶囊已收起。「在侧栏看」复用药丸的 EDGE_PILL_OPEN。 */
export interface PttCapsuleAction { type: "ptt_capsule_action"; action: "stop" | "resend" | "closed"; text?: string }
