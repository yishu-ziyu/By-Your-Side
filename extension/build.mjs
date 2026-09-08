import * as esbuild from "esbuild";
import { copyFile, cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const common = {
  absWorkingDir: root,
  bundle: true,
  platform: "browser",
  target: "chrome120",
  outdir: dist,
  logLevel: "info",
};

// ESM 产物：background service worker 与 side panel 页面
await esbuild.build({
  ...common,
  format: "esm",
  entryPoints: {
    background: "src/background/index.ts",
    sidepanel: "src/sidepanel/main.ts",
    "voice-permission": "src/sidepanel/voice-permission-page.ts",
  },
});

// IIFE 产物：注入页面的 content scripts
await esbuild.build({
  ...common,
  format: "iife",
  entryPoints: {
    "content-snapshot": "src/content/snapshot.ts",
    "content-domops": "src/content/domops.ts",
    "content-cursor": "src/content/cursor.ts",
    "content-ask": "src/content/ask.ts",
  },
});

for (const [from, to] of [
  ["manifest.json", "manifest.json"],
  ["src/sidepanel/voice-worklet.js", "voice-worklet.js"],
  ["licenses/voiceorbs-MIT.txt", "voiceorbs-MIT.txt"],
  ["sidepanel.html", "sidepanel.html"],
  ["voice-permission.html", "voice-permission.html"],
  ["src/sidepanel/styles.css", "styles.css"],
]) {
  await copyFile(path.join(root, from), path.join(dist, to));
}

// 图标：manifest 里以 icons/ 前缀引用，保持目录结构拷入 dist
await cp(path.join(root, "icons"), path.join(dist, "icons"), { recursive: true });
await cp(path.join(root, "assets/cast"), path.join(dist, "cast"), { recursive: true });
await cp(path.join(root, "assets/companion"), path.join(dist, "companion"), { recursive: true });

console.log("dist/ 构建完成");
