import { CUSTOM_PROVIDER_ID, INPROC_CONFIG_KEY, INPROC_FAST_CONFIG_KEY, INPROC_BACKUP_CONFIG_KEY, INPROC_CREDENTIAL_PREFIX, modelCredential, type InprocModelConfig } from '../inproc/shared.js';

export const CONNECTION_PREFIX = 'settings_connection:';

export function modelConfig(value: unknown): InprocModelConfig | null {
  if (!value || typeof value !== 'object' || !('provider' in value) || typeof value.provider !== 'string' || !value.provider || !('modelId' in value) || typeof value.modelId !== 'string' || !value.modelId) return null;
  const config: InprocModelConfig = { provider: value.provider, modelId: value.modelId };
  if (value.provider === CUSTOM_PROVIDER_ID) {
    if (!('baseUrl' in value) || typeof value.baseUrl !== 'string') return null;
    try {
      const url = new URL(value.baseUrl);
      if (!['http:', 'https:'].includes(url.protocol)) return null;
    } catch { return null; }
    config.baseUrl = value.baseUrl;
  }
  return config;
}

export function optionConfig(value: string): InprocModelConfig | null {
  try { return modelConfig(JSON.parse(value)); } catch { return null; }
}

export function readConnections(stored: Record<string, unknown>): Map<string, InprocModelConfig> {
  const result = new Map<string, InprocModelConfig>();
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(CONNECTION_PREFIX)) continue;
    const config = modelConfig(value);
    if (config && key === CONNECTION_PREFIX + config.provider) result.set(config.provider, config);
  }
  return result;
}

const ROLE_KEYS = [INPROC_CONFIG_KEY, INPROC_FAST_CONFIG_KEY, INPROC_BACKUP_CONFIG_KEY];

export function withModelSettings<T>(write: () => Promise<T>): Promise<T> {
  return navigator.locks.request('settings-model-configuration', write);
}

/** Preserve manual models before changing a role; another settings window may have just saved one. */
export async function rememberConnections(configs: Array<InprocModelConfig | null>, existing: Map<string, InprocModelConfig>): Promise<void> {
  const candidates = configs.filter((config): config is InprocModelConfig => !!config && !existing.has(config.provider));
  if (!candidates.length) return;
  await withModelSettings(async () => {
    const stored = await chrome.storage.local.get(candidates.map(c => CONNECTION_PREFIX + c.provider));
    const missing: Record<string, InprocModelConfig> = {};
    for (const config of candidates) {
      const key = CONNECTION_PREFIX + config.provider;
      if (!modelConfig(stored[key]) && !missing[key]) missing[key] = config;
    }
    if (Object.keys(missing).length) await chrome.storage.local.set(missing);
  });
}

export async function saveConnection(config: InprocModelConfig, key: string): Promise<void> {
  await withModelSettings(async () => {
    const stored = await chrome.storage.local.get([...ROLE_KEYS, INPROC_CREDENTIAL_PREFIX + config.provider]);
    const update: Record<string, unknown> = { [CONNECTION_PREFIX + config.provider]: config };
    if (key) update[INPROC_CREDENTIAL_PREFIX + config.provider] = modelCredential(config, key);
    if (config.provider === CUSTOM_PROVIDER_ID) {
      const previous: unknown = stored[INPROC_CREDENTIAL_PREFIX + config.provider];
      const oldKey = previous && typeof previous === 'object' && 'type' in previous && previous.type === 'api_key' && 'key' in previous && typeof previous.key === 'string' ? previous.key : '';
      update[INPROC_CREDENTIAL_PREFIX + config.provider] = modelCredential(config, key || oldKey);
      for (const role of ROLE_KEYS) {
        const current = modelConfig(stored[role]);
        if (current?.provider === CUSTOM_PROVIDER_ID) update[role] = { ...current, baseUrl: config.baseUrl };
      }
    }
    // One storage change publishes the endpoint and its key together.
    await chrome.storage.local.set(update);
  });
}

export async function saveModelRole(role: string, config: InprocModelConfig | null): Promise<void> {
  await withModelSettings(async () => {
    if (!config) { await chrome.storage.local.remove(role); return; }
    if (config.provider === CUSTOM_PROVIDER_ID) {
      const key = CONNECTION_PREFIX + config.provider;
      const saved = modelConfig((await chrome.storage.local.get(key))[key]);
      if (saved) config = { ...config, baseUrl: saved.baseUrl };
    }
    await chrome.storage.local.set({ [role]: config });
  });
}
