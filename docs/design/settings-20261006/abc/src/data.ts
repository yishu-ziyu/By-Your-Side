/**
 * 原型数据。服务商目录不是手写的：data/choices.json 由 By-Your-Side main（a0169d8）的
 * extension/src/inproc/model-runtime.ts → createModelRuntime().providerChoices() 直接导出（pi-ai 0.84.4）。
 * 凭据状态照用户 2026-10-06 截图摆：5 家已填 key / 已登录，OpenAI Codex 使用中。
 * 原型不写 chrome.storage、不发网络请求，所有改动只留在内存里。
 */
import raw from "../data/choices.json";

export interface Choice { id: string; name: string; apiKey: boolean; oauthLabel?: string; models: string[]; defaultModel: string }
export type Cred = { type: "oauth" } | { type: "api_key"; key: string };
export interface ModelConfig { provider: string; modelId: string; baseUrl?: string }

export const CUSTOM_ID = "custom";

/** 和 main.ts 同样：选择列表 = providerChoices() + 自定义地址。 */
export const CHOICES: Choice[] = [...(raw as Choice[]), { id: CUSTOM_ID, name: "自定义地址", apiKey: true, models: [], defaultModel: "" }];

/** pi-ai 的英文登录文案，换成和现有中文默认一致的说法（现有页对这两家直接显示英文）。 */
const OAUTH_ZH: Record<string, string> = { "kimi-coding": "用 Kimi Code 账号登录", xai: "用 SuperGrok 或 X Premium 登录" };
for (const c of CHOICES) if (OAUTH_ZH[c.id]) c.oauthLabel = OAUTH_ZH[c.id];

export const FEATURED = ["stepfun", "opencode-go", "zai-coding-cn", "kimi-coding"];

/**
 * 同一家的地区 / 套餐版本合成一行（借 Cherry Studio ProviderListGroup 的分组思路），
 * 选中后在详情里切地区。存储仍按原 provider id，数据层不改。
 */
export const FAMILIES: { key: string; name: string; members: [string, string][] }[] = [
  { key: "minimax*", name: "MiniMax", members: [["minimax", "国际"], ["minimax-cn", "中国"]] },
  { key: "moonshot*", name: "Moonshot AI", members: [["moonshotai", "国际"], ["moonshotai-cn", "中国"]] },
  { key: "qwen-token-plan*", name: "Qwen Token Plan", members: [["qwen-token-plan", "国际"], ["qwen-token-plan-cn", "中国"], ["qwen-token-plan-individual", "个人版"]] },
  { key: "xiaomi-token-plan*", name: "Xiaomi Token Plan", members: [["xiaomi-token-plan-cn", "中国"], ["xiaomi-token-plan-sgp", "新加坡"], ["xiaomi-token-plan-ams", "阿姆斯特丹"]] },
];

export interface Entry { key: string; name: string; members: { id: string; region?: string }[] }

export const choiceOf = (id: string) => CHOICES.find((c) => c.id === id)!;

export const ENTRIES: Entry[] = (() => {
  const out: Entry[] = [];
  const seen = new Set<string>();
  for (const c of CHOICES) {
    if (seen.has(c.id)) continue;
    const fam = FAMILIES.find((f) => f.members.some(([id]) => id === c.id));
    if (fam) {
      fam.members.forEach(([id]) => seen.add(id));
      out.push({ key: fam.key, name: fam.name, members: fam.members.map(([id, region]) => ({ id, region })) });
    } else {
      seen.add(c.id);
      out.push({ key: c.id, name: c.name, members: [{ id: c.id }] });
    }
  }
  return out;
})();

export const entryOf = (providerId: string) => ENTRIES.find((e) => e.members.some((m) => m.id === providerId))!;

export const state = {
  config: { provider: "openai-codex", modelId: "gpt-6-luna" } as ModelConfig,
  fast: null as ModelConfig | null,
  creds: {
    stepfun: { type: "api_key", key: "sk-step-••••a8F2" },
    "opencode-go": { type: "api_key", key: "sk-oc-••••91cd" },
    "zai-coding-cn": { type: "api_key", key: "zai-••••7e30" },
    "kimi-coding": { type: "oauth" },
    "openai-codex": { type: "oauth" },
    "minimax-cn": { type: "api_key", key: "mmx-••••Q4tz" },
  } as Record<string, Cred>,
  customBaseUrl: "",
  voiceOwnKey: "",
  voice: "wenroushunv",
  persona: "default" as string,
  personaText: "",
  toggles: { selection: true, linkPreview: true, nudge: false, openThreads: true },
};

export function credNote(id: string): "已登录" | "已填 key" | "" {
  const c = state.creds[id];
  if (c?.type === "oauth") return "已登录";
  if (c?.type === "api_key" && c.key) return "已填 key";
  return "";
}

export const isConfigured = (e: Entry) => e.members.some((m) => credNote(m.id)) || e.members.some((m) => m.id === state.config.provider);
export const inUse = (e: Entry) => e.members.some((m) => m.id === state.config.provider);

/** 一行的状态：使用中 > 已登录 > 已填 key。家族行带上是哪个地区。 */
export function entryStatus(e: Entry): { kind: "use" | "oauth" | "key" | ""; text: string; region?: string } {
  const use = e.members.find((m) => m.id === state.config.provider);
  if (use) return { kind: "use", text: "使用中", region: use.region };
  const o = e.members.find((m) => credNote(m.id) === "已登录");
  if (o) return { kind: "oauth", text: "已登录", region: o.region };
  const k = e.members.find((m) => credNote(m.id) === "已填 key");
  if (k) return { kind: "key", text: "已填 key", region: k.region };
  return { kind: "", text: "" };
}

/** 置顶顺序：使用中 → 现有 FEATURED 顺序 → 其余按名字。 */
export function connectedEntries(): Entry[] {
  const rank = (e: Entry) => (inUse(e) ? -1 : (() => { const i = FEATURED.indexOf(e.members[0].id); return i < 0 ? 50 : i; })());
  return ENTRIES.filter(isConfigured).sort((a, b) => rank(a) - rank(b));
}

export function otherEntries(): Entry[] {
  return ENTRIES.filter((e) => !isConfigured(e) && e.key !== CUSTOM_ID);
}

/** 搜索同时匹配服务商名和模型名（借 Cherry Studio ProviderList.tsx 的 matchKeywordsInProvider）。 */
export function matchEntry(e: Entry, q: string): { hit: boolean; models: string[] } {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return { hit: true, models: [] };
  const hay = (e.name + " " + e.members.map((m) => `${m.id} ${choiceOf(m.id).name} ${m.region ?? ""}`).join(" ")).toLowerCase();
  const models = [...new Set(e.members.flatMap((m) => choiceOf(m.id).models))].filter((id) => words.every((w) => id.toLowerCase().includes(w)));
  return { hit: words.every((w) => hay.includes(w)) || models.length > 0, models };
}

export function defaultModel(id: string): string {
  if (state.config.provider === id) return state.config.modelId;
  return choiceOf(id).defaultModel;
}

export const labelOf = (id: string) => {
  const e = entryOf(id); const m = e?.members.find((x) => x.id === id);
  return e ? (m?.region ? `${e.name}（${m.region}）` : e.name) : id;
};

export const STEP_VOICES = [
  { id: "wenroushunv", label: "温柔淑女" },
  { id: "qingchunshaonv", label: "青春少女" },
  { id: "jingdiannvsheng", label: "经典女声" },
];

export const PERSONAS = [
  { id: "default", label: "默认", summary: "简洁利落的搭子" },
  { id: "robin", label: "罗宾式", summary: "沉静博学，话少，偶尔冷幽默" },
  { id: "custom", label: "自定义", summary: "用你自己的描述" },
];
