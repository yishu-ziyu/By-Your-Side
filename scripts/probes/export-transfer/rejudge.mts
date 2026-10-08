/**
 * 用当前判分（D2、D3）重判已跑完的一批：只读每次运行存下的回答原文、拷出的下载目录和网站记录，不重跑浏览器。
 *   npx tsx scripts/probes/export-transfer/rejudge.mts <批次目录>
 * 用途：判分规则修正后，让修前、修后两批按同一把尺子比（docs/evals/20261008-download-result.md）。
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { judgeReport } from "./shared.mts";
import type { SiteEvent } from "./site.mts";

const root = process.argv[2]!;

for (const name of (await readdir(root)).filter((n) => /^T\d-/.test(n)).sort()) {
  const raw = await readFile(join(root, name, "result.json"), "utf8").catch(() => null);

  if (!raw) continue;
  // SAFETY: result.json 由 run.mts 写出。
  const r = JSON.parse(raw) as { task: "T1" | "T2" | "T3"; rows?: number; reply?: string; siteEvents?: SiteEvent[]; verdicts?: Record<string, string>; error?: string };
  const files = await readdir(join(root, name, "downloads")).catch(() => [] as string[]);
  const now = r.verdicts ? judgeReport(r.task, Array.from({ length: r.rows ?? 0 }, () => "x"), files, r.reply ?? "", r.siteEvents ?? []) : null;
  console.log(JSON.stringify({ run: name, before: r.verdicts ? { D2: r.verdicts.D2, D3: r.verdicts.D3 } : null, now, error: r.error?.split("\n")[0] ?? null }));
}
