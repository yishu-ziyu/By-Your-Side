/**
 * 侧栏和设置页的样子只许走 token：数出 token 定义以外写死的字号、圆角、颜色，和界面文字里的 emoji。
 * 现有的数是上限，只许变少；收拢后用 --update 把上限降下来。
 *   node scripts/maintenance/check-style-tokens.mjs [--update]
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const baselineFile = path.join(repo, "scripts/maintenance/style-baseline.json");
const update = process.argv.includes("--update");

const CSS_DIRS = ["extension/src/sidepanel", "extension/src/settings"];
const TS_DIRS = ["extension/src/sidepanel", "extension/src/content", "extension/src/settings"];

// 圆角里 0、正圆和胶囊不算写死的值：它们不随设计档位变。
const RADIUS_FREE = /^(0|50%|999px|9999px|inherit)$/;
const COLOR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(/gi;
const EMOJI = /\p{Extended_Pictographic}/u;

async function filesUnder(dir, match) {
  const out = [];

  for (const entry of await readdir(path.join(repo, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name !== "vendor") out.push(...await filesUnder(rel, match));
    } else if (match.test(entry.name)) out.push(rel);
  }

  return out;
}

/** 一份 CSS 里 token 定义（--name: …）以外的声明。 */
function declarations(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "").split(/[;{}]/).map(part => part.trim()).filter(part => /^[a-z-]+\s*:/i.test(part) && !part.startsWith("--"));
}

function countCss(css) {
  let fontSize = 0, radius = 0, color = 0;

  for (const decl of declarations(css)) {
    const [prop, ...rest] = decl.split(":");
    const value = rest.join(":").trim();
    const name = prop.trim().toLowerCase();

    const bare = value.replace(/var\([^)]*\)/g, "");

    // font 简写里的字号也算：font: 600 24px/1.5 …
    if ((name === "font-size" || name === "font") && /(^|\s)[\d.]+(px|rem|em)(\/|\s|$)/.test(bare)) fontSize++;
    if (name === "border-radius" && bare.split(/[\s/]+/).some(part => /\d/.test(part) && !RADIUS_FREE.test(part))) radius++;
    color += (bare.match(COLOR) ?? []).length;
  }

  return { fontSize, radius, color };
}

/** 一行里不在字符串内的 // 之后是注释（引号成对时才算在字符串外）。 */
function stripLineComment(line) {
  for (let at = line.indexOf("//"); at >= 0; at = line.indexOf("//", at + 2)) {
    const before = line.slice(0, at).replace(/\\./g, "");

    if ((before.match(/["'`]/g) ?? []).length % 2 === 0) return line.slice(0, at);
  }

  return line;
}

/** 界面文字（字符串、模板字符串）里的 emoji；注释不算。 */
function countEmoji(ts) {
  const code = ts.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map(stripLineComment).join("\n");

  return (code.match(/(["'`])(?:\\.|(?!\1)[\s\S])*?\1/g) ?? []).filter(literal => EMOJI.test(literal)).length;
}

const counts = {};

for (const file of (await Promise.all(CSS_DIRS.map(dir => filesUnder(dir, /\.css$/)))).flat()) {
  counts[file] = { ...countCss(await readFile(path.join(repo, file), "utf8")), emoji: 0 };
}

for (const file of (await Promise.all(TS_DIRS.map(dir => filesUnder(dir, /\.ts$/)))).flat()) {
  const emoji = countEmoji(await readFile(path.join(repo, file), "utf8"));

  if (emoji) counts[file] = { ...(counts[file] ?? { fontSize: 0, radius: 0, color: 0 }), emoji };
}

const total = Object.values(counts).reduce((sum, c) => ({ fontSize: sum.fontSize + c.fontSize, radius: sum.radius + c.radius, color: sum.color + c.color, emoji: sum.emoji + c.emoji }), { fontSize: 0, radius: 0, color: 0, emoji: 0 });
const LABEL = { fontSize: "写死的字号", radius: "写死的圆角", color: "写死的颜色", emoji: "界面里的 emoji" };

if (update) {
  await writeFile(baselineFile, `${JSON.stringify(counts, null, 2)}\n`);
  console.log(`✓ 样式上限已更新：${Object.entries(total).map(([k, v]) => `${LABEL[k]} ${v}`).join("，")}`);
  process.exit(0);
}

const baseline = JSON.parse(await readFile(baselineFile, "utf8"));
const worse = [];
const better = [];

for (const [file, now] of Object.entries(counts)) {
  for (const key of Object.keys(LABEL)) {
    const limit = baseline[file]?.[key] ?? 0;

    if (now[key] > limit) worse.push(`${file}：${LABEL[key]} ${limit} → ${now[key]}`);
    else if (now[key] < limit) better.push(`${file}：${LABEL[key]} ${limit} → ${now[key]}`);
  }
}

console.log(`样式现状：${Object.entries(total).map(([k, v]) => `${LABEL[k]} ${v}`).join("，")}`);

if (worse.length) {
  console.error(`✗ 新增了写死的值，请改用 styles.css 开头的 token（--fs-*、--r*、颜色变量）：\n  ${worse.join("\n  ")}`);
  process.exit(1);
}

if (better.length) console.log(`比上限少了，运行 --update 把上限降下来：\n  ${better.join("\n  ")}`);
console.log("✓ 没有新增写死的样式值");
