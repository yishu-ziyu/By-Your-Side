// R1 打包探针：按 extension/build.mjs 的设置（esbuild、browser、chrome120、esm、bundle）打 pi-durable + agent-core 1.0.3 + pi-ai 1.0.3 codex。
// A=只用 codex 服务商（登录模块懒加载）；B=再像扩展 model-runtime.ts 那样静态打进 codex 登录模块；B+shim=给 B 的 node:http 换替身。用法：node r1-bundle.mjs
import * as esbuild from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "../../../out/pi1-durable");
mkdirSync(out, { recursive: true });
const A = `
import { Harness, MemoryStorage, createRegistry, defineTool, defineExtension } from "@earendil-works/pi-durable";
import { JsonlStorage } from "@earendil-works/pi-durable/storage/jsonl";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
globalThis.__probe = { Harness, MemoryStorage, createRegistry, defineTool, defineExtension, JsonlStorage, SqliteStorage, Agent, createModels, openaiCodexProvider };`;
const B = A + `
import { registerBundledOAuthFlowLoaders } from "pi-ai-dist/auth/oauth/load.js";
import { openaiCodexOAuth } from "pi-ai-dist/auth/oauth/openai-codex.js";
registerBundledOAuthFlowLoaders({ openaiCodex: () => openaiCodexOAuth });`;
const alias = { "pi-ai-dist": path.join(here, "node_modules/@earendil-works/pi-ai/dist") };
const httpShim = { name: "node-http-shim", setup: (b) => { b.onResolve({ filter: /^node:http$/ }, () => ({ path: "node-http", namespace: "shim" })); b.onLoad({ filter: /.*/, namespace: "shim" }, () => ({ contents: "export const createServer = () => { throw new Error('no local OAuth callback server in the browser'); };" })); } };
const base = { bundle: true, platform: "browser", target: "chrome120", format: "esm", write: false, logLevel: "silent", metafile: true, define: { "process.env": "{}" }, alias };

async function probe(name, contents, plugins = []) {
  const common = { ...base, stdin: { contents, resolveDir: here, loader: "js" }, plugins };
  // 1) 不 external：失败信息就是 node: 引入清单。
  const strict = await esbuild.build(common).then(() => ({ errors: [] }), (e) => e);
  // 2) 与扩展相同：external node:*；从 metafile 找出谁还引入 node:，以及产物里还剩的静态 node: 引入。
  const loose = await esbuild.build({ ...common, external: ["node:*"], minify: true });
  const leftovers = [];
  for (const [file, input] of Object.entries(loose.metafile.inputs))
    for (const imp of input.imports) if (imp.external && imp.path.startsWith("node:")) leftovers.push({ from: file.replace(/^.*node_modules\//, ""), import: imp.path, kind: imp.kind });
  const code = new TextDecoder().decode(loose.outputFiles[0].contents);
  const staticNodeImports = code.match(/(?:^|;)import[^;(]*?from"node:[a-z_/]+"/g) ?? [];
  const unminified = (await esbuild.build({ ...common, external: ["node:*"] })).outputFiles[0].contents.length; // 扩展构建不压缩
  writeFileSync(path.join(out, `r1-bundle-${name}.js`), code);
  return { strictErrors: strict.errors.map((e) => `${e.location?.file}: ${e.text}`), leftovers, staticNodeImports, minifiedKb: Math.round(code.length / 1024), unminifiedKb: Math.round(unminified / 1024) };
}

const result = { A: await probe("A", A), B: await probe("B", B), "B+shim": await probe("B-shim", B, [httpShim]) };
writeFileSync(path.join(out, "r1-result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
