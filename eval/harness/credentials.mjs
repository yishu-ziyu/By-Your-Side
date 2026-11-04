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

export const secretsOf = (credential) => [credential.key, credential.access, credential.refresh].flatMap((s) => (s && String(s).length >= 8 ? [String(s)] : []));

export function parseModelSpec(spec) {
  const [main, fast = main] = spec.split("+");

  for (const m of [main, fast]) if (!/^[^/]+\/.+/.test(m)) throw new Error(`model must be provider/modelId: ${m}`);

  return { main, fast };
}

const split = (m) => { const i = m.indexOf("/");

 return { provider: m.slice(0, i), modelId: m.slice(i + 1) }; };

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
