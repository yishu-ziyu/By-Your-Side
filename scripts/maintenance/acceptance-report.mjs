import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const IMAGE = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"]);
const STATUS = new Set(["pass", "fail", "not-run"]);
const SHA = /^[a-f0-9]{40}$/i;
const SHA256 = /^[a-f0-9]{64}$/i;
const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const url = (value) => value.split(sep).map(encodeURIComponent).join("/");
const inside = (root, path) => path === root || (!relative(root, path).startsWith(`..${sep}`) && relative(root, path) !== ".." && !isAbsolute(relative(root, path)));
const absent = (error) => error?.code === "ENOENT";
const label = (status) => ({ pass: "通过", fail: "未通过", "not-run": "未运行", incomplete: "证据不完整" })[status];

async function safePath(repo, root, value) {
  const path = isAbsolute(value) ? resolve(value) : resolve(repo, value);
  const lexicalRoot = resolve(repo, "out");
  if (!inside(lexicalRoot, path)) throw new Error(`证据路径越界：${value}`);
  let cursor = path;
  for (;;) {
    try {
      const canonical = await realpath(cursor);
      if (!inside(root, canonical)) throw new Error(`证据符号链接越界：${value}`);
      break;
    } catch (error) {
      if (!absent(error)) throw error;
      if (cursor === lexicalRoot) throw error;
      cursor = dirname(cursor);
    }
  }
  return path;
}

async function collectMedia(repo, root, path, files, depth = 0) {
  const safe = await safePath(repo, root, path);
  let stat;
  try { stat = await lstat(safe); } catch (error) { if (absent(error)) return; throw error; }
  if (stat.isSymbolicLink()) {
    const target = await realpath(safe);
    if (!inside(root, target)) throw new Error(`证据符号链接越界：${path}`);
    const targetStat = await lstat(target);
    if (targetStat.isDirectory()) return;
    stat = targetStat;
  }
  if (stat.isDirectory()) {
    if (depth > 8) throw new Error("证据目录层级过深");
    for (const name of (await readdir(safe)).sort()) {
      if (name !== "frames") await collectMedia(repo, root, join(safe, name), files, depth + 1);
    }
  } else if (stat.isFile()) {
    const extension = extname(safe).toLowerCase();
    const basename = safe.slice(safe.lastIndexOf(sep) + 1);
    const kind = IMAGE.has(extension) ? "image" : /^(run|slow)\.mp4$/.test(basename) ? "video" : null;
    if (kind) {
      const handle = await open(safe, "r");
      let header;
      try { const bytes = Buffer.alloc(32); const read = await handle.read(bytes, 0, 32, 0); header = bytes.subarray(0, read.bytesRead); } finally { await handle.close(); }
      const ascii = header.toString("ascii");
      const valid = extension === ".png" ? header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : extension === ".jpg" || extension === ".jpeg" ? header[0] === 255 && header[1] === 216 && header[2] === 255
        : extension === ".gif" ? /^GIF8[79]a/.test(ascii)
        : extension === ".webp" ? ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP"
        : extension === ".avif" ? ascii.slice(4, 8) === "ftyp" && /avif|avis/.test(ascii.slice(8))
        : ascii.slice(4, 8) === "ftyp";
      if (!valid) throw new Error(`证据不是有效媒体文件：${relative(repo, safe)}`);
      files.set(await realpath(safe), { path: safe, kind, extension });
    }
  }
  if (files.size > 500) throw new Error("单个用例媒体超过 500 项");
}

function parseResults(summary) {
  if (!summary || typeof summary !== "object" || !Array.isArray(summary.results)) throw new Error("验收摘要缺少 results");
  const seen = new Set();
  for (const row of summary.results) {
    if (!row || typeof row !== "object" || typeof row.name !== "string" || !/^[a-zA-Z0-9_-]+$/.test(row.name) || !STATUS.has(row.status) || !Number.isFinite(row.seconds) || row.seconds < 0 || !(row.exitCode === null || Number.isInteger(row.exitCode))) throw new Error("验收摘要包含无效用例");
    if (seen.has(row.name)) throw new Error(`用例重复：${row.name}`);
    seen.add(row.name);
    if ((row.status === "pass" && row.exitCode !== 0) || (row.status === "fail" && row.exitCode === 0) || (row.status === "not-run" && row.exitCode !== null)) throw new Error(`测试状态与退出码不一致：${row.name}`);
  }
  const selected = summary.selectedCases ?? summary.results.filter((row) => row.status !== "not-run").map((row) => row.name);
  if (!Array.isArray(selected) || selected.some((name) => typeof name !== "string" || !/^[a-zA-Z0-9_-]+$/.test(name))) throw new Error("selectedCases 无效");
  if (new Set(selected).size !== selected.length) throw new Error("选中用例重复");
  for (const name of selected) if (!seen.has(name)) throw new Error(`选中用例缺少结果：${name}`);
  for (const row of summary.results) if (row.status !== "not-run" && !selected.includes(row.name)) throw new Error(`结果不在选中范围：${row.name}`);
  return selected.map((name) => summary.results.find((row) => row.name === name));
}

export async function createAcceptanceReport({ repo, summary: summaryPath, output, title = "验收报告", expectedCommit }) {
  if (typeof repo !== "string" || !isAbsolute(repo) || typeof summaryPath !== "string" || !isAbsolute(summaryPath) || typeof output !== "string" || !isAbsolute(output)) throw new Error("repo、summary、output 必须是绝对路径");
  if (typeof title !== "string") throw new Error("title 必须是文字");
  if (expectedCommit !== undefined && (typeof expectedCommit !== "string" || !SHA.test(expectedCommit))) throw new Error("期望版本必须为 40 位 commit");
  const root = await realpath(join(repo, "out"));
  await safePath(repo, root, summaryPath);
  await safePath(repo, root, output);
  const data = JSON.parse(await readFile(summaryPath, "utf8"));
  const selected = parseResults(data);
  const issues = [];
  const commit = typeof data.commit === "string" && SHA.test(data.commit) ? data.commit.toLowerCase() : null;
  if (expectedCommit && commit && commit !== expectedCommit.toLowerCase()) throw new Error(`构建版本不符：期望 ${expectedCommit}，摘要为 ${commit}`);
  if (!commit) issues.push("摘要缺少有效构建版本，无法核对来源");
  if (data.dirty !== false) issues.push(data.dirty === true ? "测试版本包含未提交改动" : "摘要缺少工作区状态");
  if (typeof data.startedAt !== "string" || !Number.isFinite(Date.parse(data.startedAt))) issues.push("摘要缺少有效运行时间");
  if (typeof data.buildSha256 !== "string" || !SHA256.test(data.buildSha256)) issues.push("摘要缺少有效构建 SHA-256");
  if (!Array.isArray(data.selectedCases)) issues.push("摘要缺少明确选中用例，范围仅从已有结果推断");
  if (!selected.length) issues.push("没有选中验收用例");
  let logDir = null;
  if (typeof data.logDir === "string" && data.logDir) logDir = await safePath(repo, root, data.logDir);
  else issues.push("摘要缺少日志目录，无法查找媒体证据");
  const cases = [];
  for (const row of selected) {
    const caseIssues = [];
    const files = new Map();
    if (row.status === "not-run") caseIssues.push("该用例未运行");
    else if (logDir) {
      const log = await safePath(repo, root, join(logDir, `${row.name}.log`));
      let text = "";
      try { text = await readFile(log, "utf8"); } catch (error) { if (!absent(error)) throw error; caseIssues.push("缺少该用例日志"); }
      for (const line of text.split(/\r?\n/)) {
        const match = /^\s*(?:证据|录屏)：\s*(.+?)\s*$/.exec(line.replace(/\u001b\[[0-9;]*m/g, ""));
        if (!match) continue;
        const path = match[1];
        if (isAbsolute(path) || /^out[\\/]/.test(path) || /^(?:\.\.?[\\/])/.test(path)) await collectMedia(repo, root, path, files);
      }
    }
    const media = [...files.values()].map((file, index) => ({ kind: file.kind, source: relative(repo, file.path), file: join("assets", row.name, `${String(index + 1).padStart(3, "0")}${file.extension}`), path: file.path }));
    const missingImage = !media.some((file) => file.kind === "image");
    const missingVideo = !media.some((file) => file.kind === "video");
    if (missingImage) caseIssues.push("缺少截图");
    if (missingVideo) caseIssues.push("缺少录屏");
    cases.push({ name: row.name, status: row.status, exitCode: row.exitCode, seconds: row.seconds, missingImage, missingVideo, issues: caseIssues, media });
  }
  const status = cases.some((row) => row.status === "fail") ? "fail" : issues.length || cases.some((row) => row.issues.length) ? "incomplete" : "pass";
  const manifest = {
    schemaVersion: 1, title, status, generatedAt: new Date().toISOString(),
    source: { summary: relative(repo, summaryPath), commit, expectedCommit: expectedCommit?.toLowerCase() ?? null, dirty: typeof data.dirty === "boolean" ? data.dirty : null, startedAt: typeof data.startedAt === "string" && Number.isFinite(Date.parse(data.startedAt)) ? data.startedAt : null, buildSha256: typeof data.buildSha256 === "string" && SHA256.test(data.buildSha256) ? data.buildSha256.toLowerCase() : null },
    issues, cases: cases.map(({ media, ...row }) => ({ ...row, media: media.map(({ path, ...file }) => file) })),
  };
  const unchecked = [...issues, ...cases.flatMap((row) => row.issues.map((issue) => `${row.name}：${issue}`))];
  const style = `:root{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#242b31;background:#f6f7f8;color-scheme:light dark}body{max-width:1080px;margin:auto;padding:32px 20px}h1{font-size:28px}h2{font-size:20px}p,li{line-height:1.7}header,article,aside{background:#fff;border:1px solid #dce1e5;border-radius:12px;padding:22px;margin-bottom:20px}.status{font-weight:650;color:#16713c}.fail,.incomplete,.not-run{color:#596875}.meta{color:#596875;overflow-wrap:anywhere}.media{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr));gap:16px}figure{margin:0}img,video{display:block;width:100%;max-height:640px;object-fit:contain;background:#edf0f2;border-radius:6px}a{color:#1766a0}figcaption{padding:8px 0;color:#596875;font-size:14px}.progress{height:8px;background:#dce1e5;border-radius:8px;overflow:hidden}.progress span{display:block;height:100%;background:#3481b6}code{font-size:12px}@media(prefers-color-scheme:dark){:root{color:#e3e7ea;background:#171c20}header,article,aside{background:#20282e;border-color:#414c54}.meta,figcaption,.fail,.incomplete,.not-run{color:#bac3cb}.status.pass{color:#78d69b}a{color:#8ac6f1}img,video,.progress{background:#333e47}}`;
  const passed = cases.filter((row) => row.status === "pass").length;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; media-src 'self'; base-uri 'none'; form-action 'none'"><title>${escape(title)}</title><style>${style}</style></head><body><header><h1>${escape(title)}</h1><p class="status ${status}">${escape(label(status))} · 测试通过 ${passed}/${cases.length}</p><div class="progress" aria-label="测试通过 ${passed}/${cases.length}"><span style="width:${cases.length ? Math.round(passed / cases.length * 100) : 0}%"></span></div><p class="meta">构建版本：<code>${escape(commit ?? "来源未确认")}</code><br>运行时间：${escape(manifest.source.startedAt ?? "未记录")}<br>构建 SHA-256：<code>${escape(manifest.source.buildSha256 ?? "未记录")}</code></p></header>${cases.map((row) => `<article><h2>${escape(row.name)}</h2><p class="status ${row.status}">测试${escape(label(row.status))} · ${row.seconds} 秒</p>${row.issues.length ? `<p class="meta">${row.issues.map(escape).join("；")}</p>` : ""}<div class="media">${row.media.map((file) => `<figure>${file.kind === "image" ? `<a href="${url(file.file)}"><img src="${url(file.file)}" alt="${escape(row.name)} 截图" loading="lazy"></a>` : `<video src="${url(file.file)}" controls preload="metadata" aria-label="${escape(row.name)} 录屏"></video>`}<figcaption>${escape(file.source)}</figcaption></figure>`).join("")}</div></article>`).join("")}<aside><h2>未验证项</h2>${unchecked.length ? `<ul>${unchecked.map((issue) => `<li>${escape(issue)}</li>`).join("")}</ul>` : "<p>本次选中范围的测试、来源与媒体证据均齐全；其他产品路径未在本报告中验证。</p>"}</aside></body></html>\n`;
  const markdownEscape = (value) => escape(value).replace(/[\\`*_[\]#|]/g, "\\$&");
  const markdown = `# ${markdownEscape(title)}\n\n${label(status)} · 测试通过 ${passed}/${cases.length}\n\n构建版本：${commit ?? "来源未确认"}\n\n运行时间：${markdownEscape(manifest.source.startedAt ?? "未记录")}\n\n构建 SHA-256：${manifest.source.buildSha256 ?? "未记录"}\n${cases.map((row) => `\n## ${markdownEscape(row.name)}\n\n测试${label(row.status)} · ${row.seconds} 秒\n${row.issues.length ? `\n${row.issues.map(markdownEscape).join("；")}\n` : ""}${row.media.map((file) => `\n${file.kind === "image" ? "!" : ""}[${file.kind === "image" ? "截图" : "录屏"}](${url(file.file)})\n`).join("")}`).join("")}\n## 未验证项\n\n${unchecked.length ? unchecked.map((issue) => `- ${markdownEscape(issue)}`).join("\n") : "本次选中范围的测试、来源与媒体证据均齐全；其他产品路径未在本报告中验证。"}\n`;
  await mkdir(output, { recursive: true });
  for (const row of cases) for (const file of row.media) {
    await safePath(repo, root, file.path);
    const destination = join(output, file.file);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(file.path, destination, 1);
  }
  const htmlPath = join(output, "index.html");
  const markdownPath = join(output, "report.md");
  const manifestPath = join(output, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  await writeFile(markdownPath, markdown, { flag: "wx" });
  await writeFile(htmlPath, html, { flag: "wx" });
  return { html: htmlPath, markdown: markdownPath, manifest: manifestPath, status };
}

async function main() {
  const options = {};
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const match = /^--(summary|out|commit|title)(?:=(.*))?$/.exec(args[index]);
    if (!match) throw new Error(`未知参数：${args[index]}`);
    const value = match[2] ?? args[++index];
    if (!value || value.startsWith("--")) throw new Error(`参数缺少值：${match[1]}`);
    if (options[match[1]] !== undefined) throw new Error(`参数重复：${match[1]}`);
    options[match[1]] = value;
  }
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const result = await createAcceptanceReport({ repo, summary: options.summary, output: options.out, title: options.title, expectedCommit: options.commit });
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "pass") process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
