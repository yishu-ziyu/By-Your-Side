/**
 * 伴随进程配置文件：~/.sideagent/config.json
 * native messaging 模式下 Chrome 拉起的命令行是固定的，model/proxy 只能从配置文件来。
 * 优先级：CLI 参数 > 配置文件 > 内置默认。
 */
import { readFileSync, writeFileSync } from "node:fs";
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

/**
 * 把面板选择的模型写回配置文件（保留其他字段）。
 * 文件不存在/解析失败时按空对象处理；写入失败抛错由调用方记录。
 */
export function saveConfigModel(model: string, path = configPath()): void {
  let json: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      json = parsed as Record<string, unknown>;
    }
  } catch {
    /* 文件不存在或损坏：按空配置重建 */
  }
  json.model = model;
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`, "utf8");
}
