import { CUSTOM_PROVIDER_ID, INPROC_CONFIG_KEY, INPROC_FAST_CONFIG_KEY, INPROC_BACKUP_CONFIG_KEY, INPROC_CREDENTIAL_PREFIX, modelCredential, type InprocModelConfig } from '../inproc/shared.js';

export const CONNECTION_PREFIX = 'settings_connection:';

export type ConnectionCheck = { state: 'passed' | 'failed'; modelId: string };

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

export function readConnectionChecks(stored: Record<string, unknown>): Map<string, ConnectionCheck> {
  const checks = new Map<string, ConnectionCheck>();
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(CONNECTION_PREFIX) || !value || typeof value !== 'object' || !('check' in value)) continue;
    const provider = key.slice(CONNECTION_PREFIX.length);
    const config = modelConfig(value);
    const check: unknown = value.check;
    const credential: unknown = stored[INPROC_CREDENTIAL_PREFIX + provider];
    if (!config || config.provider !== provider || !check || typeof check !== 'object' || !credential || typeof credential !== 'object') continue;
    if (!('state' in check) || (check.state !== 'passed' && check.state !== 'failed')
      || !('modelId' in check) || check.modelId !== config.modelId
      || !('credentialId' in check) || typeof check.credentialId !== 'string'
      || !('settingsVerificationId' in credential) || credential.settingsVerificationId !== check.credentialId) continue;
    checks.set(provider, { state: check.state, modelId: config.modelId });
  }
  return checks;
}

const ROLE_KEYS = [INPROC_CONFIG_KEY, INPROC_FAST_CONFIG_KEY, INPROC_BACKUP_CONFIG_KEY];

function credentialContents(value: unknown, sameAccount = false): string {
  if (!value || typeof value !== 'object') return '';
  const fields = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'settingsVerificationId'));
  if (sameAccount && fields.type === 'oauth' && typeof fields.accountId === 'string' && fields.accountId) {
    return JSON.stringify({ type: fields.type, accountId: fields.accountId });
  }
  return JSON.stringify(fields);
}

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

export async function saveConnection(config: InprocModelConfig, key: string, state: ConnectionCheck['state'], expected: InprocModelConfig | null, expectedCredential: unknown): Promise<boolean> {
  return withModelSettings(async () => {
    const connectionKey = CONNECTION_PREFIX + config.provider;
    const credentialKey = INPROC_CREDENTIAL_PREFIX + config.provider;
    const stored = await chrome.storage.local.get([...ROLE_KEYS, credentialKey, connectionKey]);
    const current = modelConfig(stored[connectionKey]);
    if (JSON.stringify(current) !== JSON.stringify(expected)) return false;
    if (credentialContents(stored[credentialKey], true) !== credentialContents(expectedCredential, true)) return false;
    if (state === 'failed' && (current || stored[credentialKey] || ROLE_KEYS.some(role => modelConfig(stored[role])?.provider === config.provider))) return false;
    const previous: unknown = stored[credentialKey];
    let credential: unknown = key ? modelCredential(config, key) : previous;
    if (config.provider === CUSTOM_PROVIDER_ID) {
      const oldKey = previous && typeof previous === 'object' && 'type' in previous && previous.type === 'api_key' && 'key' in previous && typeof previous.key === 'string' ? previous.key : '';
      credential = modelCredential(config, key || oldKey);
    }
    if (!credential || typeof credential !== 'object') return false;
    const credentialId = crypto.randomUUID();
    const update: Record<string, unknown> = {
      [connectionKey]: { ...config, check: { state, modelId: config.modelId, credentialId } },
      [credentialKey]: { ...credential, settingsVerificationId: credentialId },
    };
    if (config.provider === CUSTOM_PROVIDER_ID) {
      for (const role of ROLE_KEYS) {
        const current = modelConfig(stored[role]);
        if (current?.provider === CUSTOM_PROVIDER_ID) update[role] = { ...current, baseUrl: config.baseUrl };
      }
    }
    // One storage change publishes the endpoint and its key together.
    await chrome.storage.local.set(update);
    return true;
  });
}

export async function updateConnectionCheck(config: InprocModelConfig, state: ConnectionCheck['state'], credential: unknown): Promise<boolean> {
  return withModelSettings(async () => {
    const connectionKey = CONNECTION_PREFIX + config.provider;
    const credentialKey = INPROC_CREDENTIAL_PREFIX + config.provider;
    const stored = await chrome.storage.local.get([connectionKey, credentialKey]);
    if (JSON.stringify(modelConfig(stored[connectionKey])) !== JSON.stringify(config)
      || credentialContents(stored[credentialKey]) !== credentialContents(credential)
      || !credential || typeof credential !== 'object') return false;
    const currentCredential: unknown = stored[credentialKey];
    if (!currentCredential || typeof currentCredential !== 'object') return false;
    const credentialId = crypto.randomUUID();
    await chrome.storage.local.set({
      [connectionKey]: { ...config, check: { state, modelId: config.modelId, credentialId } },
      [credentialKey]: { ...currentCredential, settingsVerificationId: credentialId },
    });
    return true;
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
