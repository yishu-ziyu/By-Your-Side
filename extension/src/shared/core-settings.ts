/**
 * 扩展内核心（offscreen 文档）要读的设置开关。offscreen 文档里没有 chrome.storage：
 * 后台在连上时和这些键变化时整组推过来（inproc_settings），核心在这里同步读。
 */
import { isMiniAppsOn, MINI_APPS_KEY } from "./mini-apps.js";
import { CONTINUATION_KEY, PROGRAM_OBSERVATION_KEY } from '../../../shared/task-continuation.js';
import { SELF_USE_KEY, selfUseActive } from "./self-use.js";
import { parseTranslationStyle, TRANSLATION_STYLE_KEY, translationStyleText } from "../../../shared/translation-style.js";

export const CORE_SETTING_KEYS = [SELF_USE_KEY, MINI_APPS_KEY, TRANSLATION_STYLE_KEY, CONTINUATION_KEY, PROGRAM_OBSERVATION_KEY];

let pushed: Record<string, unknown> = {};

export function receiveCoreSettings(values: unknown): void {
  pushed = values && typeof values === "object" ? { ...values } : {};
}

export const pushedSelfUse = (): boolean => selfUseActive(pushed[SELF_USE_KEY]);
export const pushedContinuation = (): boolean => pushed[CONTINUATION_KEY] === true;

export const pushedMiniApps = (): boolean => isMiniAppsOn(pushed[MINI_APPS_KEY]);

export const pushedTranslationStyle = (): string => translationStyleText(parseTranslationStyle(pushed[TRANSLATION_STYLE_KEY]));
