/**
 * Model credentials for eval jobs, in the shape the extension stores under `inproc_cred:<provider>`.
 * Sources, first match wins:
 *   1. env BYS_KEY_<PROVIDER> (provider id upper-cased, non-alphanumerics -> _), e.g. BYS_KEY_ZAI_CODING_CN
 *   2. stepfun: env SIDEAGENT_STEP_PLAN_KEY, else ~/.sideagent/step-plan.key (Step Plan URL only; see model-runtime.ts)
 *   3. ~/.pi/agent/auth.json[provider]: { type: "api_key", key } or an OAuth login { access, refresh, expires }
 * Never logs or returns the secret in any error message.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const envName = (provider) => `BYS_KEY_${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;

export function loadCredential(provider) {
  const fromEnv = process.env[envName(provider)];

  if (fromEnv) return { type: "api_key", key: fromEnv.trim() };

  if (provider === "stepfun") {
    if (process.env.SIDEAGENT_STEP_PLAN_KEY) return { type: "api_key", key: process.env.SIDEAGENT_STEP_PLAN_KEY.trim() };
    const file = join(homedir(), ".sideagent/step-plan.key");

    if (existsSync(file)) return { type: "api_key", key: readFileSync(file, "utf8").trim() };
  }

  const authFile = join(homedir(), ".pi/agent/auth.json");
  const entry = existsSync(authFile) ? JSON.parse(readFileSync(authFile, "utf8"))[provider] : undefined;

  if (entry?.key) return { type: "api_key", key: String(entry.key) };

  if (entry?.access && entry?.refresh) {
    if (Number(entry.expires) - Date.now() < 5 * 60_000) throw new Error(`${provider}: login token in ~/.pi/agent/auth.json expires within 5 min; refresh it in Pi first`);

    return { type: "oauth", access: entry.access, refresh: entry.refresh, expires: entry.expires };
  }

  throw new Error(`no credential for ${provider}: set ${envName(provider)} or add it to ~/.pi/agent/auth.json`);
}

/** Every secret string in a credential (used to scan job outputs for leaks). */
export const secretsOf = (credential) => [credential.key, credential.access, credential.refresh].flatMap((s) => (s && String(s).length >= 8 ? [String(s)] : []));

/**
 * "main[+fast]" -> { main, fast } as "provider/modelId"; fast defaults to main.
 * Example: minimax-cn/MiniMax-M3.1-Flash-Preview+zai-coding-cn/glm-5.3-flash
 */
export function parseModelSpec(spec) {
  const [main, fast = main] = spec.split("+");

  for (const m of [main, fast]) if (!/^[^/]+\/.+/.test(m)) throw new Error(`model must be provider/modelId: ${m}`);

  return { main, fast };
}

const split = (m) => { const i = m.indexOf("/");

 return { provider: m.slice(0, i), modelId: m.slice(i + 1) }; };

/** chrome.storage.local items the settings page would write for this main + fast pair (contains secrets: never persist). */
export function storageItemsFor(spec) {
  const { main, fast } = parseModelSpec(spec);
  const a = split(main), b = split(fast);
  const items = { inproc_model_config: a, inproc_fast_model_config: b };
  const secrets = [];

  for (const provider of new Set([a.provider, b.provider])) {
    const cred = loadCredential(provider);
    items[`inproc_cred:${provider}`] = cred;
    secrets.push(...secretsOf(cred));
  }

  return { items, secrets, main, fast };
}
