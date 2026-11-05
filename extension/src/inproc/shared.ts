import { GPT_LIVE_MODEL } from "../../../shared/voice.js";

export const INPROC_PORT_NAME = "inproc-host";

export const INPROC_CONFIG_KEY = "inproc_model_config";

export const CODEX_CATALOG_KEY = "inproc_codex_catalog";

export const CUSTOM_CATALOG_KEY = "inproc_custom_catalog";

export const INPROC_FAST_CONFIG_KEY = "inproc_fast_model_config";

export const INPROC_BACKUP_CONFIG_KEY = "inproc_backup_model_config";

export const INPROC_DOCUMENT = "inproc.html";

export const INPROC_KEEPALIVE_MS = 20_000;

export const INPROC_VOICE_KEY = "inproc_voice_key";

export const INPROC_VOICE_MODEL_KEY = "inproc_voice_model";

export type InprocVoiceModel = "stepaudio-3-realtime-preview" | "stepaudio-2.5-realtime" | typeof GPT_LIVE_MODEL;

export function resolveVoiceModel(value: unknown): InprocVoiceModel {
  if (value === undefined) return "stepaudio-3-realtime-preview";

  if (value === "stepaudio-3-realtime-preview" || value === "stepaudio-2.5-realtime" || value === GPT_LIVE_MODEL) return value;
  throw new Error("语音模型设置无效，请在「模型与语音」重新选择后再开启。");
}


const VOICE_HEADER_RULE_ID = 7101;

const PLAN_VOICE_HEADER_RULE_ID = 7102;

export async function installVoiceHeaderRule(key: string): Promise<boolean> {
  const configured = key.trim().length > 0;

  const rule = (id: number, urlFilter: string): chrome.declarativeNetRequest.Rule => ({
    id, priority: 1,
    action: { type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS, requestHeaders: [{ header: "Authorization", operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: `Bearer ${key.trim()}` }] },
    condition: {
      urlFilter,
      resourceTypes: [chrome.declarativeNetRequest.ResourceType.WEBSOCKET],
      initiatorDomains: [chrome.runtime.id],
      tabIds: [chrome.tabs.TAB_ID_NONE],
    },
  });

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [VOICE_HEADER_RULE_ID, PLAN_VOICE_HEADER_RULE_ID],
    addRules: configured ? [rule(VOICE_HEADER_RULE_ID, "||api.stepfun.com/v1/realtime"), rule(PLAN_VOICE_HEADER_RULE_ID, "||api.stepfun.com/step_plan/v1/realtime")] : [],
  });

  return configured;
}

export interface InprocModelConfig {
  provider: string;
  modelId: string;
  baseUrl?: string;
}

export const CUSTOM_PROVIDER_ID = "custom";
export const CUSTOM_ENDPOINT_ENV = "SIDEAGENT_CUSTOM_ENDPOINT";

export interface CustomCatalogModel { id: string; contextWindow?: number; images?: boolean }
export interface CustomCatalog { baseUrl: string; models: CustomCatalogModel[] }

export function readCustomCatalog(value: unknown): CustomCatalog | null {
  if (!value || typeof value !== "object" || !("baseUrl" in value) || typeof value.baseUrl !== "string" || !("models" in value) || !Array.isArray(value.models)) return null;
  const models = value.models.flatMap((item: unknown): CustomCatalogModel[] => {
    if (!item || typeof item !== "object" || !("id" in item) || typeof item.id !== "string" || !item.id) return [];
    return [{
      id: item.id,
      ...("contextWindow" in item && typeof item.contextWindow === "number" && item.contextWindow > 0 ? { contextWindow: item.contextWindow } : {}),
      ...("images" in item && item.images === true ? { images: true } : {}),
    }];
  });
  return { baseUrl: value.baseUrl, models };
}

export function modelCredential(config: InprocModelConfig, key: string): StoredCredential {
  return config.provider === CUSTOM_PROVIDER_ID && config.baseUrl
    ? { type: "api_key", key, env: { [CUSTOM_ENDPOINT_ENV]: config.baseUrl } }
    : { type: "api_key", key };
}

export const STEPFUN_PROVIDER_ID = "stepfun";
export const COMMANDCODE_PROVIDER_ID = "commandcode";

export const INPROC_CREDENTIAL_PREFIX = "inproc_cred:";

export type StoredCredential =
  | { type: "api_key"; key?: string; env?: Record<string, string> }
  | { type: "oauth"; access: string; refresh: string; expires: number; [key: string]: string | number | boolean | null | undefined };

export interface StoredCredentials { [providerId: string]: StoredCredential }

type StorageEntries = ReadonlyArray<readonly [string, unknown]>;

function isStoredCredential(value: unknown): value is StoredCredential {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;

  if (value.type === "api_key") {
    const keyOk = !("key" in value) || value.key === undefined || typeof value.key === "string";
    const envOk = !("env" in value) || value.env === undefined || !!value.env && typeof value.env === "object" && !Array.isArray(value.env) && Object.values(value.env).every(item => typeof item === "string");
    return keyOk && envOk;
  }

  return value.type === "oauth" && "access" in value && typeof value.access === "string" && "refresh" in value && typeof value.refresh === "string" && "expires" in value && typeof value.expires === "number";
}

const isText = (value: unknown): value is string => typeof value === "string";

export function pickCredentials(entries: StorageEntries): StoredCredentials {
  const credentials: StoredCredentials = {};

  for (const [key, value] of entries) {
    if (key.startsWith(INPROC_CREDENTIAL_PREFIX) && isStoredCredential(value)) credentials[key.slice(INPROC_CREDENTIAL_PREFIX.length)] = value;
  }

  return credentials;
}

export function resolveVoiceKey(entries: StorageEntries): string {
  const own = entries.find(([key]) => key === INPROC_VOICE_KEY)?.[1];

  if (isText(own) && own.trim()) return own.trim();
  const shared = pickCredentials(entries)[STEPFUN_PROVIDER_ID];

  return shared?.type === "api_key" && shared.key ? shared.key : "";
}
