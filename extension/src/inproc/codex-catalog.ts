import type { StoredCredential } from "./shared.js";

export const CODEX_CATALOG_TTL_MS = 5 * 60_000;
// The Codex backend varies its response by client version; this version was
// checked against the current account's model catalog.
const CODEX_CLIENT_VERSION = "0.164.0";
// Discovery only: models returned solely to a later client still require a connection test.
const CODEX_DISCOVERY_VERSION = "999.0.0";

export interface CodexCatalogModel {
  id: string;
  name: string;
  efforts: string[];
  input: ("text" | "image")[];
  contextWindow: number;
  discoveryOnly: boolean;
}

export interface CodexCatalog {
  identity: string;
  checkedAt: number;
  models: CodexCatalogModel[];
  discoveryComplete: boolean;
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export async function codexIdentity(credential: StoredCredential | undefined): Promise<string | undefined> {
  if (credential?.type !== "oauth" || typeof credential.accountId !== "string" || !credential.accountId) return undefined;
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`openai-codex\0${credential.accountId}`));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}

function catalogModel(value: unknown): CodexCatalogModel | undefined {
  if (!record(value) || typeof value.id !== "string" || !value.id || typeof value.name !== "string" || !Array.isArray(value.efforts) || !value.efforts.every(x => typeof x === "string") || !Array.isArray(value.input) || !value.input.every(x => x === "text" || x === "image") || typeof value.contextWindow !== "number" || !Number.isSafeInteger(value.contextWindow) || value.contextWindow <= 0) return undefined;
  if (value.discoveryOnly !== undefined && typeof value.discoveryOnly !== "boolean") return undefined;
  return { id: value.id, name: value.name, efforts: value.efforts, input: value.input, contextWindow: value.contextWindow, discoveryOnly: value.discoveryOnly === true };
}

export function readCodexCatalog(value: unknown, identity: string | undefined): CodexCatalog | undefined {
  if (!identity || !record(value) || value.identity !== identity || typeof value.checkedAt !== "number" || !Number.isFinite(value.checkedAt) || !Array.isArray(value.models) || value.models.length > 1000) return undefined;
  const models = value.models.map(catalogModel);
  if (models.some(m => !m)) return undefined;
  return { identity, checkedAt: value.checkedAt, models: models as CodexCatalogModel[], discoveryComplete: value.discoveryComplete === true };
}

export async function fetchCodexCatalog(credential: StoredCredential, signal?: AbortSignal): Promise<CodexCatalog> {
  const identity = await codexIdentity(credential);
  if (!identity || credential.type !== "oauth" || typeof credential.accountId !== "string") throw new Error("无法确认登录账号，请重新登录后更新模型列表。");
  if (credential.expires <= Date.now()) throw new Error("登录已过期，请重新登录后更新模型列表。");
  const { access, accountId } = credential;
  async function list(version: string): Promise<CodexCatalogModel[]> {
    const response = await fetch(`https://chatgpt.com/backend-api/codex/models?client_version=${version}`, {
      credentials: "omit", signal, headers: { Authorization: `Bearer ${access}`, "chatgpt-account-id": accountId },
    });
    if (!response.ok) throw new Error(`模型列表更新失败（HTTP ${response.status}）。`);
    const body: unknown = await response.json();
    if (!record(body) || !Array.isArray(body.models) || body.models.length > 1000 || body.models.some((m: unknown) => !record(m) || typeof m.visibility !== "string")) throw new Error("服务商返回的模型列表格式不正确。");
    const visible = body.models.filter((m: unknown) => record(m) && m.visibility === "list");
    const models = visible.map((m: unknown) => {
      if (!record(m) || !Array.isArray(m.supported_reasoning_levels) || !Array.isArray(m.input_modalities)) return undefined;
      return catalogModel({ id: m.slug, name: m.display_name, efforts: m.supported_reasoning_levels.map((x: unknown) => record(x) ? x.effort : undefined), input: m.input_modalities.filter((x: unknown) => x === "text" || x === "image"), contextWindow: m.context_window });
    });
    if (models.some((m: CodexCatalogModel | undefined) => !m)) throw new Error("服务商返回的模型信息不完整。");
    return models as CodexCatalogModel[];
  }
  const models = await list(CODEX_CLIENT_VERSION);
  let discoveryComplete = false;
  try {
    const discoveries = await list(CODEX_DISCOVERY_VERSION);
    const known = new Set(models.map(model => model.id));
    models.push(...discoveries.filter(model => !known.has(model.id)).map(model => ({ ...model, discoveryOnly: true })));
    discoveryComplete = true;
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  return { identity, checkedAt: Date.now(), models, discoveryComplete };
}
