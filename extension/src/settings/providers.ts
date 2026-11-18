import type { ProviderChoice } from "../inproc/model-runtime.js";

export interface Entry { key: string; name: string; members: Array<{ id: string; region?: string }> }

const FAMILIES: Array<{ name: string; members: Array<[string, string]> }> = [
  { name: "MiniMax", members: [["minimax", "国际"], ["minimax-cn", "中国"]] },
  { name: "Moonshot AI", members: [["moonshotai", "国际"], ["moonshotai-cn", "中国"]] },
  { name: "Qwen Token Plan", members: [["qwen-token-plan", "国际"], ["qwen-token-plan-cn", "中国"], ["qwen-token-plan-individual", "个人版"]] },
  { name: "Xiaomi Token Plan", members: [["xiaomi-token-plan-cn", "中国"], ["xiaomi-token-plan-sgp", "新加坡"], ["xiaomi-token-plan-ams", "阿姆斯特丹"]] },
];

export function groupEntries(choices: ProviderChoice[]): Entry[] {
  const ids = new Set(choices.map((c) => c.id));
  const seen = new Set<string>();
  const entries: Entry[] = [];

  for (const choice of choices) {
    if (seen.has(choice.id)) continue;
    const family = FAMILIES.find((f) => f.members.some(([id]) => id === choice.id));
    const members = family ? family.members.filter(([id]) => ids.has(id)).map(([id, region]) => ({ id, region })) : [{ id: choice.id }];

    for (const m of members) seen.add(m.id);
    entries.push({ key: members[0]?.id ?? choice.id, name: family && members.length > 1 ? family.name : choice.name, members: members.length > 1 ? members : [{ id: choice.id }] });
  }

  return entries;
}

export function matchEntry(entry: Entry, choices: ProviderChoice[], query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const member = (id: string) => choices.find((c) => c.id === id);
  const hay = `${entry.name} ${entry.members.map((m) => `${m.id} ${member(m.id)?.name ?? ""} ${m.region ?? ""}`).join(" ")}`.toLowerCase();
  const models = words.length ? [...new Set(entry.members.flatMap((m) => member(m.id)?.models ?? []))].filter((id) => words.every((w) => id.toLowerCase().includes(w))) : [];

  return { hit: words.every((w) => hay.includes(w)) || models.length > 0, models };
}
