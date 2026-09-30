/**
 * 扩展内构建替换本机 ~/.sideagent/config.json 读取：扩展里没有这个文件，开关都取默认（关）。
 */
import type { AgentConfig } from "../../../../agent/src/config.js";

/** 扩展里没有本机数据目录；只在配置了存储目录时才会用到。 */
export const dataDir = () => "";

export const loadConfig = (): AgentConfig => ({});

export const resolveConfig = (cli: AgentConfig, file: AgentConfig): AgentConfig => ({ ...file, ...cli });
