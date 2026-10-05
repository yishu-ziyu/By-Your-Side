/** 前提：浅色 wallpaper 是 oklch hue 88 且彩度低于预览 0.010；用户气泡与输入框共用形状圆角和井；不新写 D+X1 选择器。 */
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../../extension/src/sidepanel/styles.css", import.meta.url), "utf8");

const light = css.slice(0, css.indexOf("@media (prefers-color-scheme: dark)"));

const wallpaper = light.match(/--wallpaper:\s*oklch\(([\d.]+)\s+([\d.]+)\s+88\)/);

if (!wallpaper) {
  console.error("fail: light --wallpaper must be oklch(L C 88)");
  process.exit(1);
}

const chroma = Number(wallpaper[2]);

if (chroma >= 0.008) {
  console.error(`fail: wallpaper chroma ${chroma} is not quieter than preview 0.010`);
  process.exit(1);
}

if (chroma < 0.004) {
  console.error(`fail: wallpaper chroma ${chroma} left the cream family`);
  process.exit(1);
}

for (const token of ["--fs-read:", "--fs-ui:", "--fs-meta:", "--fs-code:", "--r:", "--r-shape:", "--s-1:", "--well:"]) {
  if (!light.includes(token)) {
    console.error(`fail: missing ${token}`);
    process.exit(1);
  }
}

const user = css.slice(css.indexOf(".msg.user {"), css.indexOf(".msg.user.undelivered"));

const composer = css.slice(css.indexOf("#composer {"), css.indexOf("#composer:focus-within"));

if (!user.includes("var(--r-shape)") || !user.includes("var(--well)")) {
  console.error("fail: user bubble is not on shared shape/well");
  process.exit(1);
}

if (!composer.includes("var(--r-shape)") || !composer.includes("var(--well)")) {
  console.error("fail: composer is not on shared shape/well");
  process.exit(1);
}

if (/\.x1\b|\.inline-cite-link\b/.test(css)) {
  console.error("fail: invented cite D+X1 selectors");
  process.exit(1);
}

if (!css.includes("--accent: var(--apple-blue)")) {
  console.error("fail: accent left the apple-blue family");
  process.exit(1);
}

console.log("ok", { chroma, L: wallpaper[1] });
