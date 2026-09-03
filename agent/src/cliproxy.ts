/**
 * CLIProxyAPI 本地订阅池接入（http://127.0.0.1:8317/v1，OpenAI 兼容）。
 *
 * 注册机制（SDK 0.84.4 实测结论）：ModelRuntime.registerProvider() 运行时注册自定义
 * provider（配置形状同 ~/.pi/agent/models.json 的 providers 条目），注册后
 * ModelRuntime.getAvailable() 会自动枚举本 provider 的模型——选择器零改动出现分组，
 * 无需写 models.json / auth.json。
 *
 * 密钥纪律：apiKey 运行时从 ~/.cli-proxy-api/client.env 读入内存直接传给
 * registerProvider，不复制进仓库、不落盘到 SDK 配置、不打印日志。
 *
 * 优雅降级：注册前以短超时探测 /models；池子未运行（端口不通）时跳过注册，
 * 选择器不出现该分组，agent 启动不受影响。本模块任何失败都只记日志、不抛异常。
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const CLIPROXY_PROVIDER = "cliproxy";
export const CLIPROXY_BASE_URL = "http://127.0.0.1:8317/v1";
const PROBE_TIMEOUT_MS = 2000;

/** 实际使用的 baseURL：SIDEAGENT_CLIPROXY_BASE_URL 可覆盖（调试/抓包用），默认本机池。 */
function cliproxyBaseUrl(): string {
  return process.env.SIDEAGENT_CLIPROXY_BASE_URL ?? CLIPROXY_BASE_URL;
}

export interface CliproxyModelSpec {
  id: string;
  name: string;
  reasoning: boolean;
  /** 是否声明图像输入（截图工具结果依赖它；不确定的一律 false 保守降级）。 */
  image: boolean;
}

/**
 * 实测对话往返可用的模型清单（2026-09-04 探测）。
 * 排除项：
 * - gpt-image-* / grok-imagine-* / *-flash-image：图像/视频生成模型，非对话场景；
 * - 池内其余模型（codex-auto-review、gpt-oss、grok-4.20-* 等）：未实测对话往返，不注册。
 * 注：gemini 系 2026-09-04 凌晨曾因 Antigravity 区域限制不可用，同日复测恢复，已注册。
 */
export const CLIPROXY_MODELS: readonly CliproxyModelSpec[] = [
  // Codex 系（走 Chat Completions，池子负责翻译）
  { id: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark", reasoning: true, image: true },
  { id: "gpt-5.4", name: "GPT-5.4", reasoning: true, image: true },
  { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", reasoning: true, image: true },
  { id: "gpt-5.5", name: "GPT-5.5", reasoning: true, image: true },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", reasoning: true, image: true },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", reasoning: true, image: true },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", reasoning: true, image: true },
  // Kimi（k2 系均为文本模型；image 保守 false）
  { id: "kimi-k2", name: "Kimi K2", reasoning: false, image: false },
  { id: "kimi-k2-thinking", name: "Kimi K2 Thinking", reasoning: true, image: false },
  { id: "kimi-k2.5", name: "Kimi K2.5", reasoning: false, image: false },
  { id: "kimi-k2.6", name: "Kimi K2.6", reasoning: false, image: false },
  { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", reasoning: false, image: false },
  // xAI
  { id: "grok-3-mini", name: "Grok 3 Mini", reasoning: true, image: false },
  { id: "grok-4.3", name: "Grok 4.3", reasoning: true, image: true },
  { id: "grok-4.5", name: "Grok 4.5", reasoning: true, image: true },
  { id: "grok-4.6", name: "Grok 4.6", reasoning: true, image: true },
  { id: "grok-build-0.1", name: "Grok Build 0.1", reasoning: false, image: false },
  // Claude
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", reasoning: false, image: true },
  { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 Thinking", reasoning: true, image: true },
  // Gemini（Antigravity，2026-09-04 复测可用）
  { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite", reasoning: false, image: true },
  { id: "gemini-3-flash", name: "Gemini 3 Flash", reasoning: false, image: true },
  { id: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro Low", reasoning: true, image: true },
  { id: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash High", reasoning: true, image: true },
  { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash High", reasoning: true, image: true },
];

/** 解析 client.env 内容，取 OPENAI_API_KEY（容忍 export 前缀与引号）。 */
export function parseClientEnvKey(content: string): string | null {
  for (const line of content.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const value = (m[1] ?? "").trim().replace(/^["']|["']$/g, "");
    if (value) return value;
  }
  return null;
}

/**
 * 从池子 /models 实际通告的 id 里挑出要注册的：只保留静态清单中实测过的对话模型，
 * 清单里没有的一律不注册（天然排除 gemini 全系与图像/视频模型），顺序跟清单走。
 */
export function selectCliproxyModels(advertised: readonly string[]): CliproxyModelSpec[] {
  const available = new Set(advertised);
  return CLIPROXY_MODELS.filter((spec) => available.has(spec.id));
}

export function cliproxyEnvPath(): string {
  return join(homedir(), ".cli-proxy-api", "client.env");
}

interface ProbeResult {
  alive: boolean;
  /** /models 通告的模型 id；响应不可解析时为 null（视为全部静态清单可注册）。 */
  ids: string[] | null;
}

/** 探测池子是否在线。任何 HTTP 响应都算在线；网络错误/超时算不在线。 */
async function probeCliproxy(baseUrl: string, apiKey: string, timeoutMs: number): Promise<ProbeResult> {
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { alive: true, ids: null };
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const ids = Array.isArray(body.data)
      ? body.data.map((m) => m?.id).filter((id): id is string => typeof id === "string")
      : null;
    return { alive: true, ids };
  } catch {
    return { alive: false, ids: null };
  }
}

/**
 * 把 CLIProxyAPI 池注册进 ModelRuntime（选择器经 getAvailable() 自动出现分组）。
 * 返回是否注册成功；任何失败（无 env 文件、无 key、池子离线、注册校验报错）都返回 false，
 * 绝不阻塞或搞垮 agent 启动。
 */
export async function registerCliproxyProvider(
  modelRuntime: ModelRuntime,
  options?: { envPath?: string; timeoutMs?: number },
): Promise<boolean> {
  try {
    const envPath = options?.envPath ?? cliproxyEnvPath();
    let content: string;
    try {
      content = await readFile(envPath, "utf8");
    } catch {
      console.error(`[sideagent] 本地池未接入：${envPath} 不存在或不可读`);
      return false;
    }
    const apiKey = parseClientEnvKey(content);
    if (!apiKey) {
      console.error(`[sideagent] 本地池未接入：${envPath} 中没有 OPENAI_API_KEY`);
      return false;
    }
    const baseUrl = cliproxyBaseUrl();
    const probe = await probeCliproxy(baseUrl, apiKey, options?.timeoutMs ?? PROBE_TIMEOUT_MS);
    if (!probe.alive) {
      console.error(`[sideagent] 本地池未接入：${baseUrl} 不可达（池子未运行？），已跳过`);
      return false;
    }
    const specs = probe.ids ? selectCliproxyModels(probe.ids) : [...CLIPROXY_MODELS];
    if (specs.length === 0) {
      console.error(`[sideagent] 本地池未接入：/models 通告的模型与实测清单无交集`);
      return false;
    }
    modelRuntime.registerProvider(CLIPROXY_PROVIDER, {
      name: "本地池 (CLIProxyAPI)",
      baseUrl,
      apiKey,
      api: "openai-completions",
      models: specs.map((spec) => ({
        id: spec.id,
        name: spec.name,
        reasoning: spec.reasoning,
        input: spec.image ? ["text" as const, "image" as const] : ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
      })),
    });
    console.error(`[sideagent] 本地池已接入：${CLIPROXY_PROVIDER} 注册 ${specs.length} 个模型`);
    return true;
  } catch (err) {
    console.error(`[sideagent] 本地池注册失败（已跳过）：${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
