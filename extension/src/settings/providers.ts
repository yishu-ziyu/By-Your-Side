/**
 * 设置页服务商列表的界面分组：同一家的不同地区合成一行，配品牌图标，搜索同时匹配模型名。
 * 只影响显示；存储仍按原服务商 id。
 */
import type { ProviderChoice } from "../inproc/model-runtime.js";

export interface Entry { key: string; name: string; members: Array<{ id: string; region?: string }> }

const FAMILIES: Array<{ name: string; members: Array<[string, string]> }> = [
  { name: "MiniMax", members: [["minimax", "国际"], ["minimax-cn", "中国"]] },
  { name: "Moonshot AI", members: [["moonshotai", "国际"], ["moonshotai-cn", "中国"]] },
  { name: "Qwen Token Plan", members: [["qwen-token-plan", "国际"], ["qwen-token-plan-cn", "中国"], ["qwen-token-plan-individual", "个人版"]] },
  { name: "Xiaomi Token Plan", members: [["xiaomi-token-plan-cn", "中国"], ["xiaomi-token-plan-sgp", "新加坡"], ["xiaomi-token-plan-ams", "阿姆斯特丹"]] },
];

/** 服务商 id → icons/providers/ 里的文件名（@lobehub/icons-static-svg，MIT）。没有的用首字（小米的图标是文字标，小尺寸看不清）。 */
const ICONS = new Map(Object.entries({
  stepfun: "stepfun", "opencode-go": "opencode", opencode: "opencode", "zai-coding-cn": "zhipu", zai: "zai", "kimi-coding": "kimi",
  "ant-ling": "antgroup", anthropic: "anthropic", baseten: "baseten", cerebras: "cerebras", deepseek: "deepseek", fireworks: "fireworks",
  "github-copilot": "githubcopilot", google: "gemini", groq: "groq", huggingface: "huggingface", minimax: "minimax", "minimax-cn": "minimax",
  mistral: "mistral", moonshotai: "moonshot", "moonshotai-cn": "moonshot", nvidia: "nvidia", openai: "openai", "openai-codex": "openai",
  openrouter: "openrouter", "qwen-token-plan": "qwen", "qwen-token-plan-cn": "qwen", "qwen-token-plan-individual": "qwen", together: "together",
  "vercel-ai-gateway": "vercel", xai: "xai",
}));

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

/** 品牌图标：用遮罩上色，跟随文字颜色（深色模式也一样）。 */
export function providerIcon(id: string, name: string): HTMLElement {
  const el = document.createElement("span");
  el.setAttribute("aria-hidden", "true");
  const file = ICONS.get(id);

  if (file) {
    el.className = "pv";
    el.style.setProperty("--icon", `url("icons/providers/${file}.svg")`);
  } else {
    el.className = "pv pv-letter";
    el.textContent = /^[一-鿿]/.test(name) ? name.charAt(0) : name.replace(/[^A-Za-z0-9]/g, "")[0]?.toUpperCase() ?? "?";
  }

  return el;
}

/** 每个词都要命中服务商名、id、地区，或某个模型名；返回命中的模型。 */
export function matchEntry(entry: Entry, choices: ProviderChoice[], query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const member = (id: string) => choices.find((c) => c.id === id);
  const hay = `${entry.name} ${entry.members.map((m) => `${m.id} ${member(m.id)?.name ?? ""} ${m.region ?? ""}`).join(" ")}`.toLowerCase();
  const models = words.length ? [...new Set(entry.members.flatMap((m) => member(m.id)?.models ?? []))].filter((id) => words.every((w) => id.toLowerCase().includes(w))) : [];

  return { hit: words.every((w) => hay.includes(w)) || models.length > 0, models };
}
