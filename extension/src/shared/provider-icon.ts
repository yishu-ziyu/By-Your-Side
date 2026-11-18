const ICONS = new Map(Object.entries({
  stepfun: "stepfun", "opencode-go": "opencode", opencode: "opencode", "zai-coding-cn": "zhipu", zai: "zai", "kimi-coding": "kimi",
  "ant-ling": "antgroup", anthropic: "anthropic", azure: "azure", baseten: "baseten", cerebras: "cerebras", deepseek: "deepseek", fireworks: "fireworks",
  "github-copilot": "githubcopilot", google: "gemini", groq: "groq", huggingface: "huggingface", meta: "meta", minimax: "minimax", "minimax-cn": "minimax",
  mistral: "mistral", moonshotai: "moonshot", "moonshotai-cn": "moonshot", nvidia: "nvidia", openai: "openai", "openai-codex": "openai",
  openrouter: "openrouter", "qwen-token-plan": "qwen", "qwen-token-plan-cn": "qwen", "qwen-token-plan-individual": "qwen", together: "together",
  "vercel-ai-gateway": "vercel", xai: "xai", xiaomi: "xiaomi", "xiaomi-token-plan-cn": "xiaomi",
  "step-plan": "stepfun", kimi: "kimi", moonshot: "moonshot", gemini: "gemini",
}));

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
