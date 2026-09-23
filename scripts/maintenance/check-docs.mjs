#!/usr/bin/env node
/** 文档路径、篇幅、文件链接与功能同步检查；语义正确性仍由维护者复核。 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const options = { root: resolve(dirname(fileURLToPath(import.meta.url)), "../.."), all: false, base: null };

try {
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];

    if (arg === "--all") options.all = true;
    else if ((arg === "--root" || arg === "--base") && process.argv[i + 1]) options[arg.slice(2)] = process.argv[++i];
    else throw new Error(`未知或缺值参数 ${arg}。用法：check-docs.mjs [--all] [--base <revision>] [--root <path>]`);
  }

  options.root = resolve(options.root);
  run();
} catch (error) {
  console.error(`DOCS ERROR: ${error.message}`);
  process.exitCode = 2;
}

function git(...args) {
  return execFileSync("git", args, { cwd: options.root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

function splitFiles(output) {
  return output.split("\0").filter(Boolean);
}

function fileExists(path) {
  const full = resolve(options.root, path);

  return existsSync(full) && statSync(full).isFile();
}

function linksFrom(text) {
  const links = new Set();
  marked.walkTokens(marked.lexer(text), token => {
    if (token.type === "link" || token.type === "image") links.add(token.href);

    // 只读 HTML token 的引用，不执行 HTML；代码块不会进入这里。
    if (token.type === "html") {
      for (const match of token.text.matchAll(/\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) links.add(match[1] ?? match[2]);
    }
  });

  return [...links];
}

function run() {
  const policy = JSON.parse(readFileSync(resolve(options.root, "docs/documentation-policy.json"), "utf8"));
  const errors = [];
  const warnings = [];
  const paths = [...new Set(splitFiles(git("ls-files", "-c", "-o", "--exclude-standard", "-z")))];
  const documents = paths.filter(p => /\.(md|mdx)$/i.test(p) && fileExists(p));
  const untracked = splitFiles(git("ls-files", "--others", "--exclude-standard", "-z"));
  let base = "HEAD";

  if (options.base) {
    try {
      const commit = git("rev-parse", "--verify", "--end-of-options", `${options.base}^{commit}`).trim();
      base = git("merge-base", commit, "HEAD").trim();
    } catch {
      throw new Error(`无效或不可比较的基线 base: ${options.base}`);
    }
  }

  const changed = new Set([...splitFiles(git("diff", "--name-only", "--no-renames", "-z", base, "--")), ...untracked]);
  const historical = p => policy.historicalPrefixes.some(prefix => p.startsWith(prefix)) && !p.endsWith("/README.md");
  let checked = 0;
  let historyCount = 0;

  for (const file of documents) {
    const exception = policy.locationExceptions[file];

    if (!file.startsWith("docs/") && !exception) errors.push(`LOCATION ${file}: 项目说明应放入 docs/`);

    // 工具约定入口、vendor 来源和评测原件只核对位置，不重写其格式与规格。
    if (!file.startsWith("docs/") && !["README.md", "AGENTS.md"].includes(file)) continue;
    const old = historical(file);

    if (old) historyCount++;

    if (old && !options.all && !changed.has(file)) continue;
    const text = readFileSync(resolve(options.root, file), "utf8");
    const chars = [...text].length;
    const lines = text.trimEnd().split("\n").length;
    const limit = policy.entryLimits[file] ?? policy.maxChars;

    if (!old && (chars > limit || lines > policy.maxLines)) errors.push(`SIZE ${file}: ${chars}/${limit} 字符，${lines}/${policy.maxLines} 行；请拆分并链接`);
    checked++;

    for (const href of linksFrom(text)) {
      if (!href || href.startsWith("#") || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) continue;
      let target;

      try { target = decodeURIComponent(href.split(/[?#]/, 1)[0]); }
      catch { errors.push(`LINK ${file}: 非法 URL 编码 ${href}`); continue; }

      if (!target) continue;

      if (isAbsolute(target) || target.startsWith("~/")) {
        warnings.push(`LOCAL ${file}: 仅本机路径，未验证 ${href}`);
        continue;
      }

      const full = resolve(options.root, dirname(file), target);
      const inRepo = relative(options.root, full).split(sep).join("/");

      if (inRepo === ".." || inRepo.startsWith("../")) {
        warnings.push(`LOCAL ${file}: 仓库外路径，未验证 ${href}`);
        continue;
      }

      // out 是可清理的本地证据，干净 clone 不保证拥有它；不能替代受版本控制的文档。
      if (inRepo.startsWith("out/")) {
        if (!existsSync(full)) warnings.push(`ARTIFACT ${file}: 本地证据未携带 ${href}`);
        continue;
      }

      if (!existsSync(full)) (old ? warnings : errors).push(`${old ? "HISTORY" : "LINK"} ${file}: 目标不存在 ${href}`);
    }
  }

  for (const required of ["README.md", "docs/README.md"]) {
    if (!fileExists(required)) errors.push(`ENTRY ${required}: 缺少文档入口`);
  }

  if (fileExists("README.md") && !linksFrom(readFileSync(resolve(options.root, "README.md"), "utf8")).some(href => href.split("#")[0] === "docs/README.md")) {
    errors.push("ENTRY README.md: 必须链接 docs/README.md");
  }

  if (options.base) {
    const groups = new Map();

    for (const file of changed) {
      if (/\.(md|mdx)$/i.test(file) || /(^|\/)(test|tests)\//.test(file) || /\.test\.[^.]+$/.test(file)) continue;
      const rule = policy.syncRules.find(rule => rule.sources.some(pattern => new RegExp(pattern).test(file)));

      if (!rule) continue;
      groups.set(rule.name, rule);
    }

    for (const rule of groups.values()) {
      if (!rule.documents.some(doc => changed.has(doc) && fileExists(doc))) errors.push(`SYNC ${rule.name}: 请同步 ${rule.documents.join(" 或 ")}；STATUS/验收记录不能代替功能说明`);
    }
  }

  for (const error of errors) console.error(error);

  for (const warning of options.all ? warnings : warnings.slice(0, 15)) console.warn(warning);

  if (!options.all && warnings.length > 15) console.warn(`另有 ${warnings.length - 15} 条历史/本机证据提醒；--all 可看完整清单。`);
  console.log(`文档检查：${documents.length} 份文档，检查 ${checked} 份正文，${historyCount} 份历史记录；${errors.length} 错误，${warnings.length} 提醒。`);
  console.log(options.base ? `功能同步比较基线：${base}` : "未指定 --base：本次只检查文档结构；PR 需另跑功能同步检查。");
  process.exitCode = errors.length ? 1 : 0;
}
