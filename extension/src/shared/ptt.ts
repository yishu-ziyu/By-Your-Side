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
