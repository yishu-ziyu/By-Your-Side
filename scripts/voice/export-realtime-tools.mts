import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REALTIME_BROWSER_TOOL_NAMES, REALTIME_BROWSER_TOOLS } from "../../agent/src/realtime-browser-tool-defs.ts";

const out = join(dirname(fileURLToPath(import.meta.url)), "../../extension/src/inproc/voice/realtime-tools.generated.json");

writeFileSync(out, `${JSON.stringify({ names: REALTIME_BROWSER_TOOL_NAMES, tools: REALTIME_BROWSER_TOOLS }, null, 1)}\n`);

console.log(`已导出 ${REALTIME_BROWSER_TOOLS.length} 个语音工具定义 → ${out}`);
