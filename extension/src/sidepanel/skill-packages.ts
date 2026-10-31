import { SKILL_PACKAGES_KEY, sanitizeSkillPackageConfigs, type SkillPackageConfig, type SkillPackageConfigs } from "../../../shared/skill-packages.js";
import type { SkillOperationSummary } from "../../../shared/protocol.js";

let configs: SkillPackageConfigs = {};
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) listener();
}

void chrome.storage.local.get(SKILL_PACKAGES_KEY).then(stored => {
  configs = sanitizeSkillPackageConfigs(stored[SKILL_PACKAGES_KEY]);
  changed();
}).catch(() => {});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !(SKILL_PACKAGES_KEY in changes)) return;
  configs = sanitizeSkillPackageConfigs(changes[SKILL_PACKAGES_KEY].newValue);
  changed();
});

export function skillPackageConfig(id: string): SkillPackageConfig | undefined {
  return configs[id];
}

export function onSkillPackagesChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function saveSkillPackageConfig(operation: SkillOperationSummary, config: Omit<SkillPackageConfig, "name" | "site">): Promise<void> {
  const stored = await chrome.storage.local.get(SKILL_PACKAGES_KEY);
  const current = sanitizeSkillPackageConfigs(stored[SKILL_PACKAGES_KEY]);
  const next = { ...current, [operation.id]: { name: operation.name, site: operation.site, ...config } };
  await chrome.storage.local.set({ [SKILL_PACKAGES_KEY]: next });
}

export async function removeSkillPackageConfig(id: string): Promise<void> {
  const stored = await chrome.storage.local.get(SKILL_PACKAGES_KEY);
  const current = sanitizeSkillPackageConfigs(stored[SKILL_PACKAGES_KEY]);
  if (!(id in current)) return;
  delete current[id];
  await chrome.storage.local.set({ [SKILL_PACKAGES_KEY]: current });
}
