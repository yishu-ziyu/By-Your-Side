/**
 * 侧栏动效只许走 token：token 文件以外不许出现裸的 cubic-bezier 和短时长（ms / 小于 1s）。
 *   node scripts/maintenance/check-motion-tokens.mjs
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tokenCss = "extension/src/sidepanel/motion-tokens.css";
const tokenTs = "extension/src/shared/motion-tokens.ts";

const ALLOW = new Set([tokenCss, tokenTs]);

const DURATION = {
  tap: 90,
  micro: 140,
  state: 200,
  layout: 280,
  emph: 420,
};

const EASING = {
  enter: "cubic-bezier(0.23, 1, 0.32, 1)",
  exit: "cubic-bezier(0.4, 0, 1, 1)",
  move: "cubic-bezier(0.16, 1, 0.3, 1)",
  spring: "cubic-bezier(0.34, 1.4, 0.64, 1)",
};

async function filesUnder(dir, match) {
  const out = [];

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name !== "vendor") out.push(...await filesUnder(full, match));
    } else if (match.test(entry.name)) out.push(full);
  }

  return out;
}

function stripComments(src, css) {
  return css
    ? src.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    : src.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " ")).replace(/(^|[^:])\/\/.*$/gm, (line) => line.replace(/\/\/.*/, (c) => " ".repeat(c.length)));
}

const hits = [];

function note(file, line, text) {
  hits.push(`${file}:${line}  ${text.trim().slice(0, 120)}`);
}

function checkSource(file, src, css) {
  const clean = stripComments(src, css);
  const lines = clean.split("\n");

  lines.forEach((line, i) => {
    if (/cubic-bezier\s*\(/i.test(line)) note(file, i + 1, line);
    if (/(?<![\w-])\d+(?:\.\d+)?ms\b/.test(line)) note(file, i + 1, line);
    if (/(?<![\w-])0*\.\d+s\b/.test(line)) note(file, i + 1, line);
  });
}

const cssFiles = (await filesUnder(path.join(repo, "extension/src/sidepanel"), /\.css$/))
  .map((full) => path.relative(repo, full));
const tsFiles = (await filesUnder(path.join(repo, "extension/src/sidepanel"), /\.ts$/))
  .map((full) => path.relative(repo, full));

for (const file of [...cssFiles, ...tsFiles]) {
  if (ALLOW.has(file)) continue;
  checkSource(file, await readFile(path.join(repo, file), "utf8"), file.endsWith(".css"));
}

const css = await readFile(path.join(repo, tokenCss), "utf8");
const js = await readFile(path.join(repo, tokenTs), "utf8");

for (const [name, ms] of Object.entries(DURATION)) {
  if (!new RegExp(`--d-${name}:\\s*${ms}ms`).test(css)) hits.push(`${tokenCss}  缺少 --d-${name}: ${ms}ms`);
  if (!new RegExp(`export const D_${name.toUpperCase()} = ${ms}`).test(js)) hits.push(`${tokenTs}  缺少 D_${name.toUpperCase()} = ${ms}`);
}

for (const [name, value] of Object.entries(EASING)) {
  const compact = value.replace(/\s+/g, "\\s*").replace("(", "\\(").replace(")", "\\)");
  if (!new RegExp(`--e-${name}:\\s*${compact}`).test(css)) hits.push(`${tokenCss}  缺少 --e-${name}`);
  if (!js.includes(value)) hits.push(`${tokenTs}  缺少 ${name} 曲线`);
}

if (hits.length) {
  console.error(`动效 token：${hits.length} 处裸的时长或曲线（只许写在 ${tokenCss} / ${tokenTs}）。\n${hits.join("\n")}`);
  process.exit(1);
}

console.log("动效 token：通过");
