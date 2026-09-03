/**
 * 伴随进程配置文件：~/.sideagent/config.json
 * native messaging 模式下 Chrome 拉起的命令行是固定的，model/proxy 只能从配置文件来。
 * 优先级：CLI 参数 > 配置文件 > 内置默认。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AgentConfig {
  /** provider/id 格式，如 kimi-coding/kimi-for-coding */
  model?: string;
  /** http(s)://host:port 形式的代理地址 */
  proxy?: string;
}

export function configPath(): string {
  return join(homedir(), ".sideagent", "config.json");
}

/** 读取配置文件。文件不存在/解析失败时静默返回空配置（配置文件是可选的）。 */
export function loadConfig(path = configPath()): AgentConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  try {
    const json = JSON.parse(raw) as Record<string, unknown>;
    const config: AgentConfig = {};
    if (typeof json.model === "string" && json.model) config.model = json.model;
    if (typeof json.proxy === "string" && /^https?:\/\//.test(json.proxy)) config.proxy = json.proxy;
    return config;
  } catch {
    return {};
  }
}

/** CLI 参数优先于配置文件。 */
export function resolveConfig(cli: AgentConfig, file: AgentConfig): AgentConfig {
  return { model: cli.model ?? file.model, proxy: cli.proxy ?? file.proxy };
}
