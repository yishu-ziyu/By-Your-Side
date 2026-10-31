import { isJsonObject, type JsonObject } from "./learned-operations.js";

export const SKILL_PACKAGES_KEY = "sideagent_skill_packages";
export const SKILL_PACKAGE_RUN = "sideagent_skill_package_run";

export interface SkillPackageConfig {
  name: string;
  site: string;
  slash: boolean;
  pageButton: boolean;
  input: JsonObject;
}

export type SkillPackageConfigs = Record<string, SkillPackageConfig>;

export interface SkillPackageRunMessage {
  type: typeof SKILL_PACKAGE_RUN;
  id: string;
  input: JsonObject;
}

const validId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
const validSite = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try { return new URL(value).origin === value && ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
};

export function sanitizeSkillPackageConfigs(raw: unknown): SkillPackageConfigs {
  if (!isJsonObject(raw)) return {};
  const entries = Object.entries(raw).slice(0, 100).flatMap(([id, value]): Array<[string, SkillPackageConfig]> => {
    if (!validId(id) || !isJsonObject(value) || typeof value.name !== "string" || !value.name.trim() || value.name.length > 80 || !validSite(value.site)
      || typeof value.slash !== "boolean" || typeof value.pageButton !== "boolean" || !isJsonObject(value.input) || JSON.stringify(value.input).length > 16_384) return [];
    return [[id, { name: value.name, site: value.site, slash: value.slash, pageButton: value.pageButton, input: value.input }]];
  });
  return Object.fromEntries(entries);
}

export function isSkillPackageRunMessage(raw: unknown): raw is SkillPackageRunMessage {
  return isJsonObject(raw) && raw.type === SKILL_PACKAGE_RUN && validId(raw.id) && isJsonObject(raw.input) && JSON.stringify(raw.input).length <= 16_384;
}
