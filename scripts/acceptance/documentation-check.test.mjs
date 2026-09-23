import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const checker = join(repo, "scripts/maintenance/check-docs.mjs");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "sideagent-docs-check-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const put = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };

  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q");
  git("config", "user.name", "Documentation fixture");
  git("config", "user.email", "fixture@example.invalid");
  put("docs/documentation-policy.json", JSON.stringify({
    maxChars: 500, maxLines: 30, entryLimits: { "README.md": 200 },
    historicalPrefixes: ["docs/history/", "docs/evals/"],
    locationExceptions: { "README.md": "entry" },
    syncRules: [{ name: "browser", sources: ["^src/"], documents: ["docs/browser.md"] }],
  }));
  put("README.md", "# 项目\n\n[文档](docs/README.md)\n");
  put("docs/README.md", "# 文档\n\n[浏览器](browser.md)\n");
  put("docs/browser.md", "# 浏览器\n\n当前行为。\n");
  put("src/browser.js", "export const version = 1;\n");
  git("add", ".");
  git("commit", "-qm", "fixture baseline");
  const base = git("rev-parse", "HEAD");

  const run = (...args) => {
    const result = spawnSync(process.execPath, [checker, "--root", root, ...args], { encoding: "utf8", timeout: 15000 });
    assert.equal(result.error, undefined);

    return { status: result.status, output: result.stdout + result.stderr };
  };

  return { root, put, git, base, run };
}

test("真实 CLI 接受合法导航、引用式链接、带空格中文路径，忽略代码示例", t => {
  const f = fixture(t);
  f.put("docs/中文 空格.md", "# 来源\n");
  f.put("docs/browser.md", '# 浏览器\n\n[来源][doc]\n\n[doc]: <中文 空格.md>\n\n```md\n[示例](missing.md)\n```\n');
  const result = f.run();
  assert.equal(result.status, 0, result.output);
});

test("目录外的新说明被拒绝", t => {
  const f = fixture(t);
  f.put("src/notes.md", "# 不应放在源码目录\n");
  const r = f.run();
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /LOCATION.*src\/notes\.md/);
});

test("长单段落也触发字符预算", t => {
  const f = fixture(t);
  f.put("docs/browser.md", "# 浏览器\n" + "文".repeat(600));
  const r = f.run();
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /SIZE.*docs\/browser\.md/);
});

test("断链及 HTML 图片目标被拒绝", t => {
  const f = fixture(t);
  f.put("docs/browser.md", '# 浏览器\n\n[失效](gone.md)\n<img src="missing.png">\n');
  const r = f.run();
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /LINK.*gone\.md/);
  assert.match(r.output, /LINK.*missing\.png/);
});

test("历史缺失证据只在全量审计中报告，不冒充当前验证", t => {
  const f = fixture(t);
  f.put("docs/history/old.md", "# 原件\n[旧证据](missing.png)\n" + "旧".repeat(600));
  const r = f.run("--all");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /HISTORY.*missing\.png/);
});

test("功能修改只写验收记录不能通过同步检查", t => {
  const f = fixture(t);
  f.put("src/browser.js", "export const version = 2;\n");
  f.put("docs/evals/new.md", "# 检查通过\n");
  const r = f.run("--base", f.base);
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /SYNC.*docs\/browser\.md/);
});

test("同步权威文档后工作区和已提交变更均通过", t => {
  const f = fixture(t);
  f.put("src/browser.js", "export const version = 2;\n");
  f.put("docs/browser.md", "# 浏览器\n\n当前行为已变更。\n");
  assert.equal(f.run("--base", f.base).status, 0);
  f.git("add", ".");
  f.git("commit", "-qm", "documented feature");
  assert.equal(f.run("--base", f.base).status, 0);
});

test("无效基线必须报错，不能静默跳过同步", t => {
  const f = fixture(t);
  const r = f.run("--base", "does-not-exist");
  assert.notEqual(r.status, 0);
  assert.match(r.output, /基线|base|revision/i);
});

test("只删除对应文档不能冒充同步", t => {
  const f = fixture(t);
  f.put("src/browser.js", "export const version = 2;\n");
  rmSync(join(f.root, "docs/browser.md"));
  const r = f.run("--base", f.base);
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /SYNC.*docs\/browser\.md/);
});

test("全量审计显示所有缺失引用，不能截掉后半部分", t => {
  const f = fixture(t);
  f.put("docs/history/old.md", "# 原件\n" + Array.from({ length: 20 }, (_, i) => `[证据${i}](missing-${i}.png)`).join("\n"));
  const r = f.run("--all");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /HISTORY.*missing-19\.png/);
});
