import * as esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFile, cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

// 验收隔离构建可输出到临时目录（默认仍是日常 dist）；不带环境变量时行为不变。
const dist = process.env.SIDEAGENT_BUILD_DIST ? path.resolve(process.env.SIDEAGENT_BUILD_DIST) : path.join(root, "dist");

await rm(dist, { recursive: true, force: true });

await mkdir(dist, { recursive: true });

// 实验：Pi 的浏览器端库只装在 pi-coding-agent 的嵌套依赖里，直接指到它们的 dist。
const pi = path.join(root, "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works");

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

// 语音工具清单由正式工具定义导出成 JSON，扩展内构建直接读它。
execFileSync(process.execPath, [path.join(root, "../node_modules/tsx/dist/cli.mjs"), path.join(root, "../scripts/voice/export-realtime-tools.mts")], { stdio: "ignore" });

// 语音复用 agent/src 的原模块；只把牵出本机依赖的几个导入换成浏览器版本。
const agentSrc = path.join(root, "../agent/src");

const shims = path.join(root, "src/inproc/shims");

const browserSwaps = {
  name: "inproc-browser-swaps",
  setup(build) {
    const swap = (filter, target, onlyFromAgent) => build.onResolve({ filter }, (args) =>
      !onlyFromAgent || args.importer.startsWith(agentSrc) ? { path: target } : undefined);

    swap(/^\.\/realtime-browser-tool-defs\.js$/, path.join(root, "src/inproc/voice/tool-defs.ts"), true);
    swap(/^\.\/route-shadow\.js$/, path.join(shims, "route-shadow.ts"), true);
    swap(/^\.\/config\.js$/, path.join(shims, "config.ts"), true);
    swap(/^ws$/, path.join(shims, "ws.ts"), false);
    swap(/^node:crypto$/, path.join(shims, "node-crypto.ts"), false);
    swap(/^node:(fs\/promises|os|path)$/, path.join(shims, "node-fs.ts"), false);
  },
};

// 扩展内 agent（offscreen 文档）：单独打包，避免 Pi 与各家 SDK 进入 background。
await esbuild.build({
  ...common,
  format: "esm",
  entryPoints: { inproc: "src/inproc/main.ts", settings: "src/settings/main.ts" },
  // 订阅登录模块里有 Node 环境才走的动态 import（回调服务），浏览器里不会执行。
  external: ["node:*"],
  plugins: [browserSwaps],
  alias: { "@earendil-works/pi-ai": path.join(pi, "pi-ai/dist"), "@earendil-works/pi-agent-core": path.join(pi, "pi-agent-core/dist") },
  logLevel: "warning",
});

// IIFE 产物：注入页面的 content scripts
await esbuild.build({
  ...common,
  format: "iife",
  entryPoints: {
    "content-snapshot": "src/content/snapshot.ts",
    "content-domops": "src/content/domops.ts",
    "content-effect": "src/content/effect.ts",
    "content-cursor": "src/content/cursor.ts",
    "content-ask": "src/content/ask.ts",
    "content-point": "src/content/point.ts",
    "content-record": "src/content/record.ts",
    "content-observe": "src/content/observe.ts",
  },
});

for (const [from, to] of [
  ["manifest.json", "manifest.json"],
  ["src/sidepanel/voice-worklet.js", "voice-worklet.js"],
  ["licenses/voiceorbs-MIT.txt", "voiceorbs-MIT.txt"],
  ["sidepanel.html", "sidepanel.html"],
  ["inproc.html", "inproc.html"],
  ["settings.html", "settings.html"],
  ["src/settings/settings.css", "settings.css"],
  ["voice-permission.html", "voice-permission.html"],
  ["src/sidepanel/styles.css", "styles.css"],
]) {
  await copyFile(path.join(root, from), path.join(dist, to));
}

// 图标：manifest 里以 icons/ 前缀引用，保持目录结构拷入 dist
await cp(path.join(root, "icons"), path.join(dist, "icons"), { recursive: true });

await cp(path.join(root, "assets/cast"), path.join(dist, "cast"), { recursive: true });

await cp(path.join(root, "assets/companion"), path.join(dist, "companion"), { recursive: true });

// 设置页的音色试听样本（scripts/voice/voice-samples.mts 用真实接口录制）。
await cp(path.join(root, "assets/voices"), path.join(dist, "voices"), { recursive: true });

console.log("dist/ 构建完成");
