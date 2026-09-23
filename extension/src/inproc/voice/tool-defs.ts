/**
 * 扩展内构建用的语音工具清单：替换 agent/src/realtime-browser-tool-defs.ts。
 * 内容由 scripts/voice/export-realtime-tools.mts 从正式工具定义导出，不在这里手写。
 */
import generated from "./realtime-tools.generated.json";

export const REALTIME_BROWSER_TOOL_NAMES: readonly string[] = generated.names;

export const REALTIME_BROWSER_TOOLS = generated.tools;
