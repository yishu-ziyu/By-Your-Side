import { INPROC_VOICE_KEY, INPROC_CREDENTIAL_PREFIX, resolveVoiceKey } from "../inproc/shared.js";

export const DICTATION_CONFIG_KEY = "dictation_config";
export const DICTATION_KEY_PREFIX = "dictation_key:";
export type DictationProvider = "chrome" | "stepfun-realtime" | "stepfun" | "siliconflow";
export type CloudDictationProvider = Exclude<DictationProvider, "chrome" | "stepfun-realtime">;
export const DICTATION_PROVIDERS: Record<DictationProvider, { name: string; description: string }> = {
  chrome: { name: "Chrome 自带", description: "边说边出字，无需密钥。语音由 Chrome 的识别服务处理，需要网络。" },
  "stepfun-realtime": { name: "阶跃星辰 · Realtime 3", description: "边说边出字，只转写、不回答。语音发给阶跃星辰，使用按量实时语音额度，不走 Step Plan。" },
  stepfun: { name: "阶跃星辰 · Step Plan", description: "支持中文，说完出字。录音发给阶跃星辰，使用 Step Plan 套餐。" },
  siliconflow: { name: "硅基流动 · SenseVoice", description: "支持普通话和粤语，说完出字。录音发给硅基流动，按服务商规则计费。" },
};
export const isDictationProvider = (value: unknown): value is DictationProvider => value === "chrome" || value === "stepfun-realtime" || value === "stepfun" || value === "siliconflow";
export function parseDictationProvider(value: unknown): DictationProvider {
  if (typeof value === "object" && value !== null && "provider" in value && isDictationProvider(value.provider)) return value.provider;
  return "chrome";
}
export type DictationKeySource = "own" | "voice";
export function parseDictationKeySource(value: unknown): DictationKeySource {
  return typeof value === "object" && value !== null && "keySource" in value && value.keySource === "voice" ? "voice" : "own";
}
export async function readVoiceDictationKey(): Promise<{ key: string; description: string }> {
  const stored = await chrome.storage.local.get([INPROC_VOICE_KEY, `${INPROC_CREDENTIAL_PREFIX}stepfun`]);
  const key = resolveVoiceKey(Object.entries(stored));
  const own: unknown = stored[INPROC_VOICE_KEY];
  return { key, description: !key ? "尚未配置语音对话密钥" : typeof own === "string" && own.trim() ? "来自「语音对话」的阶跃星辰密钥" : "来自「连接」中的阶跃星辰模型密钥" };
}
export async function readDictationSettings(): Promise<{ provider: DictationProvider; key: string; keySource: DictationKeySource }> {
  const stored = await chrome.storage.local.get([DICTATION_CONFIG_KEY, `${DICTATION_KEY_PREFIX}stepfun-realtime`, `${DICTATION_KEY_PREFIX}stepfun`, `${DICTATION_KEY_PREFIX}siliconflow`]);
  const provider = parseDictationProvider(stored[DICTATION_CONFIG_KEY]);
  const keySource = parseDictationKeySource(stored[DICTATION_CONFIG_KEY]);
  const key: unknown = stored[`${DICTATION_KEY_PREFIX}${provider}`];
  return { provider, keySource, key: provider === "stepfun-realtime" && keySource === "voice" ? (await readVoiceDictationKey()).key : typeof key === "string" ? key.trim() : "" };
}
