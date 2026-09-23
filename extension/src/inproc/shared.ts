/** 扩展内 agent 实验：background 与 offscreen 文档共用的常量，单独成文件，避免把 agent 打进 background。 */
export const INPROC_PORT_NAME = "inproc-host";

export const INPROC_CONFIG_KEY = "inproc_model_config";

export const INPROC_DOCUMENT = "inproc.html";

/**
 * MV3 的 service worker 空闲约 30 秒就会被 Chrome 停掉，和扩展内 agent 的连接随之断开，停机期间发来的任务会丢。
 * 本机进程模式靠 Native Messaging 连接保活；扩展内 agent 改为定时发心跳（端口消息会重置空闲计时）。
 */
export const INPROC_KEEPALIVE_MS = 20_000;

/** StepFun 实时语音的 API Key：只由 background 读取，写进请求头规则，不发给 offscreen 文档。 */
export const INPROC_VOICE_KEY = "inproc_voice_key";

const VOICE_HEADER_RULE_ID = 7101;

/**
 * 浏览器的 WebSocket 不能自己设请求头，StepFun 又只认 Authorization 头：
 * 用会话级 declarativeNetRequest 规则在握手时补上。返回语音是否已配置。
 */
export async function installVoiceHeaderRule(key: string): Promise<boolean> {
  const configured = key.trim().length > 0;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [VOICE_HEADER_RULE_ID],
    addRules: configured ? [{
      id: VOICE_HEADER_RULE_ID, priority: 1,
      action: { type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS, requestHeaders: [{ header: "Authorization", operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: `Bearer ${key.trim()}` }] },
      // 只给本扩展自己发起、且不属于任何标签页的连接（offscreen / 侧栏）补头；网页自己连 StepFun 拿不到用户的 key。
      condition: {
        urlFilter: "||api.stepfun.com/v1/realtime",
        resourceTypes: [chrome.declarativeNetRequest.ResourceType.WEBSOCKET],
        initiatorDomains: [chrome.runtime.id],
        tabIds: [chrome.tabs.TAB_ID_NONE],
      },
    }] : [],
  });

  return configured;
}

/** 用户在设置里选的模型。密钥与登录令牌不在这里，见 INPROC_CREDENTIAL_PREFIX。 */
export interface InprocModelConfig {
  provider: string;
  modelId: string;
  /** 只在 provider === CUSTOM_PROVIDER_ID 时使用。 */
  baseUrl?: string;
}

/** 自定义 OpenAI 兼容服务在凭据与配置里使用的服务商编号。 */
export const CUSTOM_PROVIDER_ID = "custom";

/** 阶跃星辰：pi-ai 目录里没有，扩展自己注册；它的 key 同时可用于实时语音。 */
export const STEPFUN_PROVIDER_ID = "stepfun";

/**
 * 每家服务商一条凭据，存在 `inproc_cred:<服务商>`：填的 key，或订阅登录拿到的令牌。
 * 分键存放，设置页登录与 agent 刷新令牌写不同的键时不会互相覆盖。
 */
export const INPROC_CREDENTIAL_PREFIX = "inproc_cred:";

/** 与 pi-ai 的 Credential 同形；这里单独声明，background 不必引入 pi-ai。 */
export type StoredCredential =
  | { type: "api_key"; key?: string }
  | { type: "oauth"; access: string; refresh: string; expires: number; [key: string]: string | number | boolean | null | undefined };

/** 按服务商编号索引；要经 runtime 端口发给 offscreen 文档，所以是普通对象而不是 Map。 */
export interface StoredCredentials { [providerId: string]: StoredCredential }

/** chrome.storage.local.get 读出的整表，按 Object.entries 展开；值未经解析。 */
export type StorageEntries = ReadonlyArray<readonly [string, unknown]>;

/** 凭据只由设置页和 background 写入；这里仍按形状核对，读到坏值就当没有。 */
function isStoredCredential(value: unknown): value is StoredCredential {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;

  if (value.type === "api_key") return !("key" in value) || value.key === undefined || typeof value.key === "string";

  return value.type === "oauth" && "access" in value && typeof value.access === "string" && "refresh" in value && typeof value.refresh === "string" && "expires" in value && typeof value.expires === "number";
}

const isText = (value: unknown): value is string => typeof value === "string";

/** 从 chrome.storage 的整表里挑出凭据。 */
export function pickCredentials(entries: StorageEntries): StoredCredentials {
  const credentials: StoredCredentials = {};

  for (const [key, value] of entries) {
    if (key.startsWith(INPROC_CREDENTIAL_PREFIX) && isStoredCredential(value)) credentials[key.slice(INPROC_CREDENTIAL_PREFIX.length)] = value;
  }

  return credentials;
}

/** 实时语音用的 key：单独填的优先，否则沿用阶跃星辰模型的 key（同一个账号）。 */
export function resolveVoiceKey(entries: StorageEntries): string {
  const own = entries.find(([key]) => key === INPROC_VOICE_KEY)?.[1];

  if (isText(own) && own.trim()) return own.trim();
  const shared = pickCredentials(entries)[STEPFUN_PROVIDER_ID];

  return shared?.type === "api_key" && shared.key ? shared.key : "";
}
