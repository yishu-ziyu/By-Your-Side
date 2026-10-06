// P3(a) 打包探针：每个服务商一个入口（API 模块 + 产品用到的登录模块），按扩展设置（browser/esm/chrome120）打包，
// 先不 external 看 node: 清单，再 external node:* 看产物里残留的静态 node: 引入，再加最小替身复查。用法：node build.mjs
import * as esbuild from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const out = path.join(here, "../../../../out/pi1-rebuild/providers");

const dist = path.join(here, "node_modules/@earendil-works/pi-ai/dist");

mkdirSync(out, { recursive: true });

const oauth = (key, file, name) => ({ key, imp: `import { ${name} } from "${dist}/auth/oauth/${file}.js";`, entry: `${key}: () => ${name}` });

const loaders = (list) => `import { registerBundledOAuthFlowLoaders } from "${dist}/auth/oauth/load.js";\n${list.map((o) => o.imp).join("\n")}\nregisterBundledOAuthFlowLoaders({ ${list.map((o) => o.entry).join(", ")} });`;

const entries = {
  "openai-codex": `import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";\n${loaders([oauth("openaiCodex", "openai-codex", "openaiCodexOAuth")])}\nglobalThis.__p = openaiCodexProvider;`,
  "kimi-coding": `import { kimiCodingProvider } from "@earendil-works/pi-ai/providers/kimi-coding";\n${loaders([oauth("kimiCoding", "kimi-coding", "kimiCodingOAuth")])}\nglobalThis.__p = kimiCodingProvider;`,
  deepseek: `import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";\nglobalThis.__p = deepseekProvider;`,
  custom: `import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";\nglobalThis.__p = openAICompletionsApi;`,
  xai: `import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";\n${loaders([oauth("xai", "xai", "xaiOAuth")])}\nglobalThis.__p = xaiProvider;`,
  "github-copilot": `import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";\n${loaders([oauth("githubCopilot", "github-copilot", "githubCopilotOAuth")])}\nglobalThis.__p = githubCopilotProvider;`,
  // 产品现在的写法：providers/all + 四个登录模块 + openai-completions.lazy
  "product-all": `import { builtinModels } from "@earendil-works/pi-ai/providers/all";\nimport { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";\n${loaders([oauth("kimiCoding", "kimi-coding", "kimiCodingOAuth"), oauth("githubCopilot", "github-copilot", "githubCopilotOAuth"), oauth("xai", "xai", "xaiOAuth"), oauth("openaiCodex", "openai-codex", "openaiCodexOAuth")])}\nglobalThis.__p = [builtinModels, openAICompletionsApi];`,
};

// 最小替身：只替 node:http 的 createServer（回调服务器）。其余 node: 引入若残留，会在结果里列出，不盲目替。
const httpShim = { name: "node-http-shim", setup: (b) => { b.onResolve({ filter: /^node:http$/ }, () => ({ path: "node-http", namespace: "shim" })); b.onLoad({ filter: /.*/, namespace: "shim" }, () => ({ contents: "export const createServer = () => { throw new Error('no local OAuth callback server in the browser'); };" })); } };

const base = { bundle: true, platform: "browser", target: "chrome120", format: "esm", write: false, logLevel: "silent", metafile: true, define: { "process.env": "{}" } };

const rel = (f) => f.replace(/^.*node_modules\//, "");

async function probe(name, contents, plugins = []) {
  const common = { ...base, stdin: { contents, resolveDir: here, loader: "js" }, plugins };

  const strict = await esbuild.build(common).then(() => ({ errors: [] }), (e) => e);

  const loose = await esbuild.build({ ...common, external: ["node:*"] }).then((r) => r, (e) => ({ failed: e.errors.map((x) => `${x.location?.file ?? ""}: ${x.text}`) }));

  if (loose.failed) return { bundleOk: false, errors: loose.failed };

  const leftovers = Object.entries(loose.metafile.inputs).flatMap(([file, input]) => input.imports.flatMap((imp) => (imp.external && imp.path.startsWith("node:") ? [{ from: rel(file), import: imp.path, kind: imp.kind }] : [])));

  const code = new TextDecoder().decode(loose.outputFiles[0].contents);

  writeFileSync(path.join(out, `bundle-${name}.js`), code);

  return {
    bundleOk: true,
    strictErrors: [...new Set(strict.errors.map((e) => `${rel(e.location?.file ?? "")}: ${e.text}`))],
    staticNodeImports: leftovers.filter((l) => l.kind === "import-statement"),
    dynamicNodeImports: leftovers.filter((l) => l.kind !== "import-statement").length,
    kb: Math.round(code.length / 1024),
  };
}

const result = {};

for (const [name, src] of Object.entries(entries)) {
  const plain = await probe(name, src);

  const r = { plain };

  if (plain.bundleOk && plain.staticNodeImports.length) r.withHttpShim = await probe(`${name}-shim`, src, [httpShim]);
  result[name] = r;
}

writeFileSync(path.join(out, "bundle-result.json"), JSON.stringify(result, null, 2));

console.log(JSON.stringify(result, null, 2));
