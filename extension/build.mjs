import * as esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFile, cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

const dist = process.env.SIDEAGENT_BUILD_DIST ? path.resolve(process.env.SIDEAGENT_BUILD_DIST) : path.join(root, "dist");

await rm(dist, { recursive: true, force: true });

await mkdir(dist, { recursive: true });

const pi = path.join(root, "../node_modules/@earendil-works");

const common = {
  absWorkingDir: root,
  bundle: true,
  platform: "browser",
  target: "chrome120",
  outdir: dist,
  logLevel: "info",
};

await esbuild.build({
  ...common,
  format: "esm",
  entryPoints: {
    background: "src/background/index.ts",
    sidepanel: "src/sidepanel/main.ts",
    "voice-permission": "src/sidepanel/voice-permission-page.ts",
    "artifact-viewer": "src/sidepanel/artifact-viewer-page.ts",
    "diagram-engine": "src/sidepanel/diagram-engine.ts",
    "diagram-engine-more": "src/sidepanel/diagram-engine-more.ts",
    "file-read": "src/sidepanel/file-read/index.ts",
  },
});

await esbuild.build({
  ...common,
  format: "iife",
  entryPoints: { "artifact-sandbox": "src/sidepanel/artifact-sandbox.ts", "mini-app-sandbox": "src/sidepanel/mini-app-sandbox.ts" },
});

execFileSync(process.execPath, [path.join(root, "../node_modules/tsx/dist/cli.mjs"), path.join(root, "../scripts/voice/export-realtime-tools.mts")], { stdio: "ignore" });

const agentSrc = path.join(root, "../agent/src");

const shims = path.join(root, "src/inproc/shims");

const browserSwaps = {
  name: "inproc-browser-swaps",
  setup(build) {
    const swap = (filter, target, onlyFromAgent) => build.onResolve({ filter }, (args) =>
      !onlyFromAgent || args.importer.startsWith(agentSrc) ? { path: target } : undefined);

    swap(/^\.\/realtime-browser-tool-defs\.js$/, path.join(root, "src/inproc/voice/tool-defs.ts"), true);
    swap(/^ws$/, path.join(shims, "ws.ts"), false);
    swap(/^\.\/run-trace\.js$/, path.join(shims, "run-trace.ts"), true);
    swap(/^node:crypto$/, path.join(shims, "node-crypto.ts"), false);
    swap(/^(?:node:)?fs(?:\/promises)?$/, path.join(shims, "node-fs.ts"), false);
    swap(/^node:path$/, path.join(shims, "node-path.ts"), false);
    swap(/^node:os$/, path.join(shims, "node-os.ts"), false);
    swap(/^node:perf_hooks$/, path.join(shims, "node-perf-hooks.ts"), false);
    swap(/^node:http$/, path.join(shims, "node-http.ts"), false);
  },
};

await esbuild.build({
  ...common,
  format: "esm",
  entryPoints: { inproc: "src/inproc/main.ts", "opfs-worker": "src/inproc/opfs-worker.ts", settings: "src/settings/main.ts" },
  external: ["node:*"],
  plugins: [browserSwaps],
  define: { "process.env": "{}" },
  alias: { "@earendil-works/pi-ai": path.join(pi, "pi-ai/dist"), "@earendil-works/pi-agent-core": path.join(pi, "pi-agent-core/dist") },
  logLevel: "warning",
});

await esbuild.build({
  ...common,
  format: "iife",
  entryPoints: {
    "content-snapshot": "src/content/snapshot.ts",
    "content-domops": "src/content/domops.ts",
    "content-effect": "src/content/effect.ts",
    "content-cursor": "src/content/cursor.ts",
    "content-ask": "src/content/ask.ts",
    "content-skills": "src/content/skills.ts",
  },
});

for (const [from, to] of [
  ["manifest.json", "manifest.json"],
  ["src/sidepanel/voice-worklet.js", "voice-worklet.js"],
  ["licenses/voiceorbs-MIT.txt", "voiceorbs-MIT.txt"],
  ["licenses/lobe-icons-MIT.txt", "lobe-icons-MIT.txt"],
  ["licenses/magpie-MIT.txt", "magpie-MIT.txt"],
  ["licenses/pele-MIT.txt", "pele-MIT.txt"],
  ["licenses/caveat-OFL.txt", "caveat-OFL.txt"],
  ["sidepanel.html", "sidepanel.html"],
  ["inproc.html", "inproc.html"],
  ["settings.html", "settings.html"],
  ["src/settings/settings.css", "settings.css"],
  ["voice-permission.html", "voice-permission.html"],
  ["artifact-viewer.html", "artifact-viewer.html"],
  ["artifact-sandbox.html", "artifact-sandbox.html"],
  ["mini-app.html", "mini-app.html"],
  ["src/sidepanel/styles.css", "styles.css"],
  ["src/sidepanel/motion-tokens.css", "motion-tokens.css"],
  ["src/sidepanel/answer-cards.css", "answer-cards.css"],
]) {
  await copyFile(path.join(root, from), path.join(dist, to));
}

await copyFile(path.join(root, "../node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm"), path.join(dist, "emscripten-module.wasm"));

await cp(path.join(root, "icons"), path.join(dist, "icons"), { recursive: true });

await cp(path.join(root, "../node_modules/pdfjs-dist/cmaps"), path.join(dist, "pdfjs/cmaps"), { recursive: true });

await copyFile(path.join(root, "../node_modules/pdfjs-dist/build/pdf.worker.min.mjs"), path.join(dist, "pdf.worker.mjs"));
await cp(path.join(root, "../node_modules/pdfjs-dist/standard_fonts"), path.join(dist, "pdfjs/standard_fonts"), { recursive: true });

await cp(path.join(root, "assets/cast"), path.join(dist, "cast"), { recursive: true });

await cp(path.join(root, "assets/voices"), path.join(dist, "voices"), { recursive: true });

await cp(path.join(root, "assets/orbs"), path.join(dist, "orbs"), { recursive: true });

await cp(path.join(root, "assets/fonts"), path.join(dist, "fonts"), { recursive: true });

await mkdir(path.join(dist, "ort"), { recursive: true });
for (const file of [
  "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm",
  "ort-wasm-simd-threaded.jspi.mjs", "ort-wasm-simd-threaded.jspi.wasm",
  "ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm",
]) {
  await copyFile(path.join(root, "../node_modules/onnxruntime-web/dist", file), path.join(dist, "ort", file));
}

console.log("dist/ 构建完成");
