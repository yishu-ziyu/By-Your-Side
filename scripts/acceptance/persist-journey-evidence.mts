/**
 * 把一次 product-journeys 运行的核心证据复制到受版本控制的 docs/evals/ 目录。
 * 原始大文件（events.json、截图）不进 git；manifest 记录完整目录的 sha256 与本机路径。
 *
 *   npx --no-install tsx scripts/acceptance/persist-journey-evidence.mts <runDir> <docsTargetDir>
 */
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [runDir, targetDir] = process.argv.slice(2);
if (!runDir || !targetDir) {
  console.error("用法: persist-journey-evidence.mts <runDir> <docsTargetDir>");
  process.exit(2);
}
const src = resolve(runDir);
const dst = resolve(targetDir);

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

const all = walk(src);
const manifest = {
  source: src,
  copiedAt: new Date().toISOString(),
  files: all.map((p) => ({ path: p.slice(src.length + 1), sha256: sha(p), bytes: statSync(p).size })),
};
mkdirSync(dst, { recursive: true });
// 进 git 的：summary、plan、每臂 run.json、manifest（含全量哈希）
for (const rel of ["summary.json", "plan.json", ...manifest.files.filter((f) => f.path.endsWith("/run.json")).map((f) => f.path)]) {
  const from = join(src, rel);
  const to = join(dst, rel);
  try {
    mkdirSync(join(to, ".."), { recursive: true });
    copyFileSync(from, to);
  } catch { /* 该臂无 run.json 时跳过，manifest 仍记录 */ }
}
writeFileSync(join(dst, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ copiedTo: dst, files: manifest.files.length, totalBytes: manifest.files.reduce((a, f) => a + f.bytes, 0) }));
