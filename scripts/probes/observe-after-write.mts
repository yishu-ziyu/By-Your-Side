/**
 * 前提：模型做完单独的写操作后，下一轮常常只是看页面（snapshot / read_element / screenshot）。
 * 读已有真实路径测试的诊断记录，统计这种「白看一轮」占写操作的比例。占 1/4 及以上为成立（退出码 0）。
 *   npx tsx scripts/probes/observe-after-write.mts <out/acceptance/real-path 目录> [日期前缀，如 2026-10-0]
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const WRITES = new Set(["click", "fill", "select_option", "press_key", "double_click", "scroll", "type_text"]);
const READS = new Set(["snapshot", "read_element", "screenshot"]);
const [root, prefix = ""] = process.argv.slice(2);
type Call = { run: string; turn: number; tool: string; value?: string };
const calls: Call[] = [];
for (const dir of readdirSync(root).filter((d) => d.startsWith(prefix))) {
  const dl = join(root, dir, "downloads");
  if (!existsSync(dl)) continue;
  for (const f of readdirSync(dl).filter((n) => n.endsWith(".jsonl"))) {
    for (const line of readFileSync(join(dl, f), "utf8").split("\n")) {
      if (!line.includes('"tool_execution_')) continue;
      const r = JSON.parse(line);
      if (r.type === "tool_execution_start") calls.push({ run: `${dir}/${r.runId}`, turn: r.turn, tool: r.data.toolName });
      if (r.type === "tool_execution_end" && r.data.toolName === "browser_run") {
        const last = [...calls].reverse().find((c) => c.run === `${dir}/${r.runId}` && c.tool === "browser_run");
        if (last) last.value = JSON.stringify(r.data.result?.details?.value ?? "");
      }
    }
  }
}
let progObserveNext = 0, writes = 0, observeNext = 0, programs = 0, programSnap = 0;
calls.forEach((c, i) => {
  if (c.tool === "browser_run") { programs++; if (c.value?.includes("[ref=")) programSnap++; }
  if (c.tool === "browser_run") { const n = calls[i + 1]; if (n && n.run === c.run && n.turn > c.turn && READS.has(n.tool)) progObserveNext++; }
  if (!WRITES.has(c.tool)) return;
  writes++;
  const next = calls[i + 1];
  if (next && next.run === c.run && next.turn > c.turn && READS.has(next.tool)) observeNext++;
});
const share = writes ? observeNext / writes : 0;
console.log({ runs: new Set(calls.map((c) => c.run)).size, writes, observeNext, share: share.toFixed(2), programs, programsReturningSnapshot: programSnap, progObserveNext });
process.exit(share >= 0.25 ? 0 : 1);
