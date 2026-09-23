/**
 * 把语音可用的浏览器工具清单导出成 JSON，供扩展内构建使用。
 * 清单由正式工具定义生成（agent/src/realtime-browser-tool-defs.ts），导出后扩展不必打包整条工具链。
 *
 *   npx tsx scripts/voice/export-realtime-tools.mts
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REALTIME_BROWSER_TOOL_NAMES, REALTIME_BROWSER_TOOLS } from "../../agent/src/realtime-browser-tool-defs.ts";

const out = join(dirname(fileURLToPath(import.meta.url)), "../../extension/src/inproc/voice/realtime-tools.generated.json");

writeFileSync(out, `${JSON.stringify({ names: REALTIME_BROWSER_TOOL_NAMES, tools: REALTIME_BROWSER_TOOLS }, null, 1)}\n`);

console.log(`已导出 ${REALTIME_BROWSER_TOOLS.length} 个语音工具定义 → ${out}`);
