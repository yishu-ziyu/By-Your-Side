/**
 * 扩展内构建替换本机 ~/.sideagent/config.json 读取：扩展里没有这个文件，开关都取默认（关）。
 * 与日常本机的差异：本机开着 generalBrowserLoop、displayFastPath；扩展第一版不开（以后放进设置页）。
 */
import type { AgentConfig } from "../../../../agent/src/config.js";

export const voiceSpokenResultGateEnabled = () => false;

export const generalBrowserLoopEnabled = () => false;

export const browserLoopDirectDeliveryEnabled = () => false;

export const routeShadowEnabled = () => false;

export const routeShadowDailyLimit = () => 0;

/** 扩展里没有本机数据目录；只在配置了存储目录时才会用到。 */
export const dataDir = () => "";

export const loadConfig = (): AgentConfig => ({});

export const resolveConfig = (cli: AgentConfig, file: AgentConfig): AgentConfig => ({ ...file, ...cli });
