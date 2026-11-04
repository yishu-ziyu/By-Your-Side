import type { CardPreview } from "../../../shared/answer-cards.js";
import type { DictationResult } from "../inproc/ptt-dictation.js";

export const PTT_KEY = "ptt_key";

export const PTT_KEY_CHOICES: readonly string[] = ["AltRight", "ControlRight", "MetaRight", "AltLeft", ...Array.from({ length: 19 }, (_, i) => `F${i + 1}`)];

const onMac = () => /Mac/i.test(navigator.userAgent);

export const pttKeyOf = (stored: unknown): string =>
  typeof stored === "string" && PTT_KEY_CHOICES.includes(stored) ? stored : onMac() ? "AltRight" : "ControlRight";

export function pttKeyLabel(code: string): string {
  const side = code.endsWith("Right") ? "右" : code.endsWith("Left") ? "左" : "";
  const base = code.replace(/(Right|Left)$/, "");
  const name = onMac() ? ({ Alt: "⌥", Control: "⌃", Meta: "⌘" } as Record<string, string>)[base] : ({ Alt: "Alt", Control: "Ctrl", Meta: "Win" } as Record<string, string>)[base];
  return name ? `${side} ${name}` : code;
}

export interface PttPageMessage { type: "ptt"; phase: "start" | "stop" | "cancel" }

export interface PttCommand { target: "inproc-ptt"; phase: "start" | "stop" | "cancel" | "warm" }

export const PTT_WARM = "ptt_warm";

export const PTT_TARGET = "inproc-ptt";

export type PttReply = { ok: true; text?: string } | Extract<DictationResult, { ok: false }> | { ok: false; reason: "permission" | "device"; message?: string };

export const isPttPageMessage = (raw: Partial<PttPageMessage> | null | undefined): raw is PttPageMessage =>
  raw?.type === "ptt" && (raw.phase === "start" || raw.phase === "stop" || raw.phase === "cancel");

export type PttCapsule =
  | { phase: "listening" }
  | { phase: "transcribing" }
  | { phase: "failed"; reason: string; heard?: string }
  | { phase: "doing"; heard: string; step: string | null; ack: string | null; speaking?: true }
  | { phase: "waiting"; heard: string; reason: string; speaking?: true }
  | { phase: "done"; heard: string; result: string; left: string | null; card?: CardPreview; speaking?: true }
  | { phase: "stopped"; heard: string };

export const PTT_CAPSULE = "ptt_capsule";

export const PTT_LEVEL = "ptt_level";

export interface PttLevelMessage { type: typeof PTT_LEVEL; level: number }

export interface PttCapsuleAction { type: "ptt_capsule_action"; action: "stop" | "resend" | "closed" | "hush"; text?: string }

export const PTT_SPEECH_TARGET = "inproc-speech";

export type PttSpeechCommand = { target: typeof PTT_SPEECH_TARGET; action: "speak"; text: string; key: string } | { target: typeof PTT_SPEECH_TARGET; action: "hush" | "prepare" };

export type PttSpeechReply = { ok: true; playedMs: number; startedAt?: number } | { ok: false; reason: "hushed"; startedAt?: number } | { ok: false; reason: "failed"; message: string };

export const PTT_SPEECH_KEY = "ptt_speech_key";

export const PTT_SPEAK_RESULT = "ptt_speak_result";

export const isSubscriptionKey = (key: string) => /^sk-cp-[\w-]{8,}$/.test(key.trim());

export const READING_VOICE = "reading_voice";

export type ReadingVoiceMessage =
  | { type: typeof READING_VOICE; phase: "heard"; text: string }
  | { type: typeof READING_VOICE; phase: "speaking" | "quiet"; threadId: string };
