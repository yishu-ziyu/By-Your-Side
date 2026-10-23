/**
 * 开发统一入口：查环境、跑用例、跑评测、读使用记录、管本机测试网站、清理残留。
 * 踩过的坑写在这里，不写进文档：负载高时不测量、读日志只走 logs.mjs、测试浏览器和任务空间用完就关。
 *
 *   npm run lab -- env
 *   npm run lab -- case <用例…> [--force] [--load-limit=20]
 *   npm run lab -- eval guardrail|duplex [--dist 路径] [--force] [--load-limit=20] [其余参数原样转给评测]
 *   npm run lab -- logs [参数原样转给 logs.mjs]
 *   npm run lab -- methods [--since 日期] [--traces 文件]   （网站方法待修、笔记升级候选的周报）
 *   npm run lab -- sites start|stop|status
 *   npm run lab -- clean          （Ego 只关名字以 bys 开头的任务空间）
 *   npm run lab -- gallery [用例…] [--compare=上次总览目录] [--dist=扩展]   （界面总览；也可 npm run gallery）
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, loadavg, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const [action, ...rest] = process.argv.slice(2);
const flag = name => rest.includes(`--${name}`);
const option = name => rest.find(arg => arg.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

// ── 负载 ────────────────────────────────────────────────

/** 一分钟负载超过它就不测量：10-14 负载升到 90 以上时没人先查就开始测，数字全不能用。 */
const LOAD_LIMIT = Number(option("load-limit") ?? 20);

function load() {
  return loadavg()[0];
}

/** case、eval 开跑前的闸门：超限就拒绝，加 --force 才跑。 */
function loadGate() {
  const now = load();

  if (now <= LOAD_LIMIT) return;

  if (flag("force")) {
    console.log(`⚠ 负载 ${now.toFixed(1)}，超过 ${LOAD_LIMIT}；加了 --force，照跑。这次的耗时数字不能和别的比。`);

    return;
  }

  console.error(`✗ 负载 ${now.toFixed(1)}，超过 ${LOAD_LIMIT}，没有开跑。先 npm run lab -- env 看是谁占着机器；确实要跑加 --force。`);
  process.exit(2);
}

// ── 模型登录 ─────────────────────────────────────────────

/** 只看过期时间，不读也不打印密钥。 */
function logins() {
  const file = join(homedir(), ".pi/agent/auth.json");

  if (!existsSync(file)) return [{ name: "（没有 ~/.pi/agent/auth.json）", note: "没有任何模型登录" }];
  let entries;

  try {
    entries = Object.entries(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return [{ name: "auth.json", note: "读不出来（不是 JSON）" }];
  }

  return entries.map(([name, value]) => {
    const expires = typeof value?.expires === "number" ? value.expires : null;

    if (expires === null) return { name, note: "固定密钥，没有过期时间" };
    const hours = (expires - Date.now()) / 3_600_000;
    // Kimi 的访问令牌只活约 15 分钟，由 npm run kimi:keep 的后台任务续期：过期本身不算坏。
    const renew = name === "kimi-coding" ? "（kimi:keep 自动续期；系统通知说失效时 npm run kimi:login）" : "";

    if (hours > 24 * 365) return { name, note: "长期有效" };

    return { name, note: hours > 0 ? `还有 ${hours.toFixed(1)} 小时过期${renew}` : `已过期 ${(-hours).toFixed(1)} 小时${renew}`, expired: hours <= 0 && !renew };
  });
}

// ── 本机测试网站 ─────────────────────────────────────────

const SITES_HOME = join(homedir(), ".local/share/bys-test-sites");

/** 本机测试网站：程序和数据在 SITES_HOME 下，账号文件不进仓库，也不打印。以后加 Gitea 就在这里加一项。 */
const SITES = [
  {
    name: "memos",
    url: "http://127.0.0.1:5230",
    dir: join(SITES_HOME, "memos"),
    command: dir => [join(dir, "bin/memos"), ["--addr", "127.0.0.1", "--port", "5230", "--data", join(dir, "data"), "--log-level", "warn"]],
  },
];

async function online(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });

    return res.status < 500;
  } catch {
    return false;
  }
}

function pidOf(site) {
  const file = join(site.dir, `${site.name}.pid`);

  if (!existsSync(file)) return null;
  const pid = Number(readFileSync(file, "utf8").trim());

  try {
    process.kill(pid, 0);

    return pid;
  } catch {
    return null;
  }
}

async function siteStatus() {
  return Promise.all(SITES.map(async site => ({ name: site.name, url: site.url, installed: existsSync(site.command(site.dir)[0]), up: await online(site.url), pid: pidOf(site) })));
}

async function sites(sub) {
  if (sub === "status" || !sub) {
    for (const site of await siteStatus()) console.log(`${site.up ? "✓" : "✗"} ${site.name}  ${site.url}  ${site.up ? "在线" : site.installed ? "没在跑（npm run lab -- sites start）" : "没装"}${site.pid ? `  pid ${site.pid}` : ""}`);

    return;
  }

  for (const site of SITES) {
    if (sub === "start") {
      if (await online(site.url)) { console.log(`✓ ${site.name} 已在线 ${site.url}`); continue; }
      const [bin, args] = site.command(site.dir);

      if (!existsSync(bin)) { console.log(`✗ ${site.name} 没装（找不到 ${bin}）`); continue; }
      const log = join(site.dir, `${site.name}.log`);
      const child = spawn(bin, args, { cwd: site.dir, detached: true, stdio: ["ignore", "ignore", "ignore"] });
      child.unref();
      writeFileSync(join(site.dir, `${site.name}.pid`), String(child.pid));
      let up = false;

      for (let i = 0; i < 40 && !up; i++) { await new Promise(done => setTimeout(done, 250)); up = await online(site.url); }

      console.log(up ? `✓ ${site.name} 已启动 ${site.url}（pid ${child.pid}）` : `✗ ${site.name} 10 秒内没起来，看 ${log}`);
    } else if (sub === "stop") {
      const pid = pidOf(site);

      if (!pid) { console.log(`${site.name} 没在跑（或不是本入口启动的）`); continue; }
      process.kill(pid, "SIGTERM");
      console.log(`✓ 已停 ${site.name}（pid ${pid}）`);
    } else {
      console.error("用法：npm run lab -- sites start|stop|status");
      process.exit(1);
    }
  }
}

// ── 残留的测试浏览器和临时配置目录 ───────────────────────

/** 测试用的临时配置目录前缀（验收脚本、日常 Chrome 只读连接、评测裁判）。用户的日常 Chrome 配置不在 tmpdir 里，不会被碰到。 */
const TEMP_PREFIXES = ["sideagent-real-path-", "sideagent-acceptance-", "sideagent-daily-", "sideagent-video-", "sideagent-suite-dist-", "sideagent-isolated-", "bys-judge-"];

function tempDirs() {
  const roots = [...new Set([tmpdir(), "/tmp", "/private/tmp"])].filter(existsSync);

  return roots.flatMap(root => readdirSync(root).filter(name => TEMP_PREFIXES.some(prefix => name.startsWith(prefix))).map(name => join(root, name)))
    .filter((path, i, all) => all.findIndex(other => resolveReal(other) === resolveReal(path)) === i);
}

function resolveReal(path) {
  try { return execFileSync("realpath", [path], { encoding: "utf8" }).trim(); } catch { return path; }
}

/** 正在用某个临时配置目录的 Chrome 进程：命令行里 --user-data-dir 指向上面的前缀。 */
function testBrowsers() {
  const out = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout ?? "";

  return out.split("\n").flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);

    if (!match || !/--user-data-dir=/.test(match[2]) || /--type=/.test(match[2])) return [];
    const dir = match[2].match(/--user-data-dir=(\S+)/)?.[1] ?? "";

    return TEMP_PREFIXES.some(prefix => dir.includes(`/${prefix}`)) ? [{ pid: Number(match[1]), dir }] : [];
  });
}

/** ps 的 etime（[[天-]时:]分:秒）换成小时。 */
function elapsedHours(etime) {
  const [days, clock] = etime.includes("-") ? etime.split("-") : ["0", etime];
  const parts = clock.split(":").map(Number).reverse();

  return Number(days) * 24 + (parts[2] ?? 0) + (parts[1] ?? 0) / 60 + (parts[0] ?? 0) / 3600;
}

/** 有进程的命令行里带着这个目录：别的会话的测试还在用它，不能删。 */
function inUse(dir, commands) {
  const real = resolveReal(dir);

  return commands.some(line => line.includes(dir) || line.includes(real));
}

// ── 冻结扩展 ─────────────────────────────────────────────

/**
 * 按当前代码（HEAD + 未提交改动）构建一份扩展，放在 out/lab/ 下；代码没变就复用。
 * 测量期间改代码不影响这份（10-13：4 次评测因现场构建混进改到一半的代码而白跑）。
 * 一定要设 SIDEAGENT_BUILD_DIST：不设的话 build.mjs 会清空日常 Chrome 正在加载的 extension/dist。
 */
function frozenDist() {
  const git = args => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  const head = git(["rev-parse", "--short", "HEAD"]).trim();
  const untracked = git(["ls-files", "--others", "--exclude-standard", "--", "extension", "shared", "agent"])
    .split("\n").filter(Boolean).map(file => `${file}:${createHash("sha256").update(readFileSync(join(repo, file))).digest("hex")}`).join("\n");
  const dirty = `${git(["diff", "HEAD", "--", "extension", "shared", "agent"])}${untracked}`;
  const key = dirty ? `${head}-${createHash("sha256").update(dirty).digest("hex").slice(0, 8)}` : head;
  const dist = join(repo, "out/lab", `dist-${key}`, "extension");

  if (existsSync(join(dist, "manifest.json"))) {
    console.log(`冻结扩展：复用 ${dist}`);

    return dist;
  }

  console.log(`冻结扩展：按 ${key} 构建到 ${dist}`);
  const result = spawnSync(process.execPath, [join(repo, "extension/build.mjs")], { cwd: repo, stdio: "inherit", env: { ...process.env, SIDEAGENT_BUILD_DIST: dist } });

  if (result.status !== 0 || !existsSync(join(dist, "manifest.json"))) {
    console.error("✗ 冻结扩展构建失败，没有开跑。");
    process.exit(1);
  }

  return dist;
}

/** 不属于本入口的参数原样转给下层脚本。 */
const passThrough = args => args.filter(arg => arg !== "--force" && !arg.startsWith("--load-limit=") && !arg.startsWith("--dist"));

function distOption() {
  const i = rest.indexOf("--dist");
  const value = option("dist") ?? (i >= 0 ? rest[i + 1] : undefined);

  return value ? resolve(value) : null;
}

// ── 动作 ────────────────────────────────────────────────

/** case：构建一次冻结扩展，在无头浏览器里依次跑这些用例，最后列出通过和失败。 */
function cases() {
  const names = rest.filter(arg => !arg.startsWith("--"));

  if (!names.length) {
    console.error("用法：npm run lab -- case <用例…>，用例名是 scripts/acceptance/real-path/ 下的文件名（可不带 .mts）。");
    process.exit(1);
  }

  const scripts = names.map(name => join(repo, "scripts/acceptance/real-path", name.endsWith(".mts") ? name : `${name}.mts`));
  const missing = scripts.filter(file => !existsSync(file));

  if (missing.length) {
    console.error(`✗ 找不到用例：${missing.map(file => file.split("/").pop()).join("、")}`);
    process.exit(1);
  }

  loadGate();
  const dist = frozenDist();
  const extra = passThrough(rest.filter(arg => arg.startsWith("--")));
  const outcomes = [];

  for (const [i, file] of scripts.entries()) {
    console.log(`\n▶ ${names[i]}`);
    const started = Date.now();
    const result = spawnSync("npx", ["tsx", file, "--headless", ...extra], { cwd: repo, stdio: "inherit", env: { ...process.env, SIDEAGENT_ACCEPTANCE_DIST: dist } });
    outcomes.push({ name: names[i], ok: result.status === 0, seconds: Math.round((Date.now() - started) / 1000) });
  }

  console.log("\n结果：");

  for (const item of outcomes) console.log(`  ${item.ok ? "✓" : "✗"} ${item.name}（${item.seconds} 秒）`);
  console.log(`证据在各用例打印的目录里（out/acceptance/real-path/）。扩展：${dist}`);
  process.exit(outcomes.every(item => item.ok) ? 0 : 1);
}

// ── 界面总览 ─────────────────────────────────────────────

/** 会截侧栏或网页样子的用例，按用户看到的地方分组。新加截图用例时补进来。 */
const GALLERY = [
  ["空会话", ["memory-management"]],
  ["输入与菜单", ["composer-expand", "model-menu", "conversation-menu", "mention-plan-actions"]],
  ["工作中与回答", ["process-block", "answer-cards", "card-form", "card-inputs", "card-row-source", "answer-diagram", "answer-shorten", "mini-apps"]],
  ["做完、确认与长会话", ["fill-undo-button", "panel-send-confirm", "guided-teaching", "conversation-chapters"]],
  ["网页上", ["reading-card-gloss", "page-assistance-visual", "ptt-capsule", "edge-tab", "visual-ui-presence", "proactive-card"]],
  ["出错", ["error-recovery-show"]],
  ["设置页", ["first-run-settings", "settings-panel"]],
];

/** 证据写在固定目录、也不打印路径的用例。 */
const GALLERY_DIRS = { "edge-tab": "out/edge-tab", "visual-ui-presence": "out/acceptance/visual-ui-production/real-extension" };

function runCase(name, dist) {
  return new Promise(done => {
    const started = Date.now();
    const child = spawn("npx", ["tsx", join(repo, "scripts/acceptance/real-path", `${name}.mts`), "--headless"], { cwd: repo, env: { ...process.env, SIDEAGENT_ACCEPTANCE_DIST: dist, SIDEAGENT_GALLERY: "1" } });
    let output = "";

    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.on("close", status => {
      // 各用例把证据目录写在输出里，格式不统一：取最后一个指向 out/ 的路径；没打印的，找这次新建的「时间-用例名」目录。
      const printed = [...output.matchAll(/(\/[^\s"']*\/out\/[^\s"']+)/g)].map(m => m[1].replace(/[),.;]+$/, "")).at(-1);
      const runs = join(repo, "out/acceptance/real-path");
      const fresh = existsSync(runs) ? readdirSync(runs).filter(entry => entry.endsWith(`-${name}`) && statSync(join(runs, entry)).mtimeMs >= started).sort().at(-1) : undefined;
      const found = GALLERY_DIRS[name] ? join(repo, GALLERY_DIRS[name]) : printed ?? (fresh && join(runs, fresh));
      const dir = found && /\.\w+$/.test(found) ? dirname(found) : found;

      done({ name, ok: status === 0, seconds: Math.round((Date.now() - started) / 1000), dir: dir && existsSync(dir) ? dir : null, started });
    });
  });
}

/** 这次运行拍的图：固定目录里留着旧图，按修改时间只取这次的。 */
function pngsUnder(dir, since) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);

    if (entry.isDirectory()) return entry.name === "screenshots" ? [] : pngsUnder(full, since);

    return entry.name.endsWith(".png") && !entry.name.endsWith(".dark.png") && statSync(full).mtimeMs >= since ? [full] : [];
  });
}

/** gallery：冻结扩展跑截图用例（4 路并行），把截图和深色版拷进 out/gallery/<时间>/，拼成一页总览。 */
async function gallery() {
  const picked = rest.filter(arg => !arg.startsWith("--"));
  const groups = picked.length ? [["选中的用例", picked]] : GALLERY;
  const compare = option("compare") && resolve(option("compare"));
  loadGate();
  const dist = distOption() ?? frozenDist();
  const queue = groups.flatMap(([, names]) => names);
  const results = new Map();
  const lane = async () => {
    for (let name = queue.shift(); name; name = queue.shift()) {
      const result = await runCase(name, dist);
      results.set(name, result);
      console.log(`  ${result.ok ? "✓" : "✗"} ${name}（${result.seconds} 秒）`);
    }
  };

  console.log(`界面总览：${queue.length} 个用例，4 路并行`);
  await Promise.all([lane(), lane(), lane(), lane()]);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = join(repo, "out/gallery", stamp);
  const shots = [];

  for (const [group, names] of groups) {
    for (const name of names) {
      const result = results.get(name);

      for (const file of result?.dir ? pngsUnder(result.dir, result.started) : []) {
        const key = `${name}/${file.slice(result.dir.length + 1)}`;
        const target = join(out, key);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(file, target);
        const dark = file.replace(/\.png$/, ".dark.png");
        if (existsSync(dark)) copyFileSync(dark, target.replace(/\.png$/, ".dark.png"));
        shots.push({ group, name, key, dark: existsSync(dark), ok: result.ok });
      }
    }
  }

  const before = compare && existsSync(join(compare, "manifest.json")) ? JSON.parse(readFileSync(join(compare, "manifest.json"), "utf8")) : null;

  if (before) {
    const keys = new Set(before.shots.map(shot => shot.key));
    const darkOf = key => key.replace(/\.png$/, ".dark.png");
    const pairs = shots.filter(shot => keys.has(shot.key)).flatMap(shot => [[join(compare, shot.key), join(out, shot.key)], ...(shot.dark && existsSync(join(compare, darkOf(shot.key))) ? [[join(compare, darkOf(shot.key)), join(out, darkOf(shot.key))]] : [])]);
    const diff = pixelDiff(pairs);

    // 浅色、深色取变得多的那张：只改深色样式时也要标出来。
    for (const shot of shots) {
      const values = [diff.get(join(out, shot.key)), diff.get(join(out, darkOf(shot.key)))].filter(value => value !== undefined);
      if (values.length) shot.changed = Math.max(...values);
    }
  }
  const manifest = { stamp, head: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), dist, compare: compare ?? null, shots, cases: [...results.values()] };
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(out, "index.html"), galleryPage(manifest, before ? { dir: compare, keys: new Set(before.shots.map(shot => shot.key)) } : null));
  console.log(`\n${shots.length} 张截图（${shots.filter(shot => shot.dark).length} 张带深色版）→ ${join(out, "index.html")}`);
  const missing = [...results.values()].filter(result => !result.dir);
  if (missing.length) console.log(`没找到证据目录：${missing.map(result => result.name).join("、")}`);
}

/** 每对图里变了的像素占多少（0–1）；尺寸不同记 1。用 Python 的 PIL，本机没有就不标。 */
function pixelDiff(pairs) {
  const script = `
import json, sys
from PIL import Image, ImageChops
out = {}
for a, b in json.load(sys.stdin):
    x, y = Image.open(a).convert("RGB"), Image.open(b).convert("RGB")
    if x.size != y.size:
        out[b] = 1
        continue
    d = ImageChops.difference(x, y).convert("L").point(lambda v: 255 if v > 16 else 0)
    out[b] = d.histogram()[255] / (x.size[0] * x.size[1])
print(json.dumps(out))`;
  const result = spawnSync("python3", ["-c", script], { input: JSON.stringify(pairs), encoding: "utf8", maxBuffer: 16 << 20 });

  if (result.status !== 0) {
    console.log("没有算像素差异（需要 python3 和 PIL）");

    return new Map();
  }

  return new Map(Object.entries(JSON.parse(result.stdout)));
}

function galleryPage(manifest, before) {
  const esc = text => String(text).replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
  const img = (src, label) => `<figure><img loading="lazy" src="${esc(src)}" alt="${esc(label)}"><figcaption>${esc(label)}</figcaption></figure>`;
  const sections = [...new Set(manifest.shots.map(shot => shot.group))].map(group => {
    const rows = manifest.shots.filter(shot => shot.group === group).map(shot => {
      const cells = [];
      const dark = shot.key.replace(/\.png$/, ".dark.png");
      if (before?.keys.has(shot.key)) cells.push(img(`file://${join(before.dir, shot.key)}`, "改前"));
      cells.push(img(shot.key, before ? "改后" : "浅色"));
      if (shot.dark && before?.keys.has(shot.key) && existsSync(join(before.dir, dark))) cells.push(img(`file://${join(before.dir, dark)}`, "改前 · 深色"));
      if (shot.dark) cells.push(img(dark, before ? "改后 · 深色" : "深色"));

      // 像素差异：小于 0.5% 多半只是时间、端口号这类会变的字。
      const change = shot.changed === undefined ? "" : shot.changed < 0.005 ? ' <span class="same">没变</span>' : ` <span class="diff">变了 ${(shot.changed * 100).toFixed(1)}%</span>`;

      return `<div class="row" data-changed="${shot.changed ?? ""}"><h3>${esc(shot.key)}${change}${shot.ok ? "" : ' <span class="fail">用例没过</span>'}</h3><div class="cells">${cells.join("")}</div></div>`;
    });

    return `<section><h2>${esc(group)}</h2>${rows.join("")}</section>`;
  });

  // 没过或没截到图的用例放在最前面：它们那块界面这次看不到，不能当成没变。
  const shotCount = name => manifest.shots.filter(shot => shot.name === name).length;
  const gaps = manifest.cases.filter(item => !item.ok || !shotCount(item.name)).map(item => `<li>${esc(item.name)}：${[item.ok ? "" : "用例没过", shotCount(item.name) ? `截到 ${shotCount(item.name)} 张` : "没有截图"].filter(Boolean).join("，")}</li>`);
  const gapList = gaps.length ? `<section class="gaps"><h2>这次看不全的地方</h2><ul>${gaps.join("")}</ul></section>` : "";

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>界面总览</title><style>
body{margin:0;background:#f4f3ef;color:#1d1d1f;font:14px/1.5 -apple-system,"PingFang SC",sans-serif}main{max-width:1400px;margin:0 auto;padding:24px 16px 80px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:32px 0 8px;padding-top:12px;border-top:1px solid #ddd}h3{font-size:12px;font-weight:500;color:#6b6b70;margin:12px 0 6px}
.cells{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-start}figure{margin:0;max-width:360px}figure img{display:block;max-width:100%;max-height:640px;border:1px solid #ddd;border-radius:8px;background:#fff;cursor:zoom-in}
figcaption{font-size:12px;color:#6b6b70;margin-top:2px}.fail{color:#b44}.same{color:#2f7d4f}.diff{color:#2c5fb3;font-weight:600}.zoom{position:fixed;inset:0;background:rgba(0,0,0,.8);display:none;align-items:center;justify-content:center;cursor:zoom-out}.zoom img{max-width:94vw;max-height:94vh}
</style></head><body><main><h1>界面总览</h1><p>${esc(manifest.head)} · ${manifest.shots.length} 张${before ? ` · 对照 ${esc(before.dir)}` : ""}</p>${gapList}${sections.join("")}</main>
<div class="zoom" id="z"><img alt=""></div><script>const z=document.getElementById("z");document.querySelectorAll("figure img").forEach(i=>i.onclick=()=>{z.firstChild.src=i.src;z.style.display="flex"});z.onclick=()=>z.style.display="none";</script></body></html>`;
}

/** eval guardrail|duplex：包装爬坡护栏（compare-real 的 24 个任务）和插话评测。默认用冻结扩展。 */
function evaluate() {
  const kind = rest[0];
  const extra = passThrough(rest.slice(1)).filter((arg, i, all) => !(all[i - 1] === "--dist"));

  if (kind !== "guardrail" && kind !== "duplex") {
    console.error("用法：npm run lab -- eval guardrail|duplex [--dist 路径] [--force] [其余参数原样转给评测]");
    process.exit(1);
  }

  loadGate();
  const dist = distOption() ?? frozenDist();

  if (!existsSync(join(dist, "manifest.json"))) {
    console.error(`✗ ${dist} 里没有 manifest.json，不是构建好的扩展。`);
    process.exit(1);
  }

  const env = { ...process.env, SIDEAGENT_ACCEPTANCE_DIST: dist };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  if (kind === "guardrail") {
    const out = join(repo, "out/lab/eval", `guardrail-${stamp}`);
    console.log(`进度页（每 4 秒刷新）：${join(out, "progress.html")}`);
    // 有窗口的测试浏览器在后台启动，不抢焦点；全量 24×2 条约 26 分钟，先用 --only=<任务> --repeat=1 试跑一条。
    const result = spawnSync("npx", ["tsx", "scripts/probes/compare-real.mts", ".", out, "ext", ...extra], { cwd: repo, stdio: "inherit", env });
    console.log(`\n进度页：${join(out, "progress.html")}\n结果：${join(out, "result-ext.json")}`);
    process.exit(result.status ?? 1);
  }

  const runId = `duplex-${stamp}`;
  const runDir = join(repo, "eval/runs", runId);
  const hasModels = extra.includes("--models");
  console.log(`运行目录：${runDir}（插话评测没有进度页，进度在下面的输出里）`);
  const run = spawnSync(process.execPath, ["eval/harness/run.mjs", ...(hasModels ? [] : ["--models", "openai-codex/gpt-6-luna"]), "--run-id", runId, "--concurrency", "2", ...extra],
    { cwd: repo, stdio: "inherit", env: { ...env, BYS_TASKS: "eval/tasks/duplex.jsonl" } });

  if (run.status === 0) spawnSync(process.execPath, ["eval/harness/duplex-metrics.mjs", runDir], { cwd: repo, stdio: "inherit" });
  console.log(`\n读数：${join(runDir, "duplex.md")}\n运行目录：${runDir}`);
  process.exit(run.status ?? 1);
}

/** 正在用 Ego 的评测进程：有就不关任何任务空间，免得关掉别的会话正在跑的评测。 */
function egoBusy(commands) {
  // compare-real 只有 ego 那一组用 Ego；扩展组（ext）不碰任务空间。
  return commands.filter(line => (/compare-real\.mts\s+\S+\s+\S+\s+ego\b/.test(line) || /^\S*ego-browser nodejs/.test(line.trim())) && !line.includes("lab.mjs"));
}

function ego(code) {
  const result = spawnSync("ego-browser", ["nodejs", "-e", code], { encoding: "utf8", timeout: 60_000 });
  // ego-browser 把 console.log 写到 stderr，两边都读。
  const line = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.split("\n").reverse().find(text => text.trim().startsWith("{") || text.trim().startsWith("["));

  if (result.error || !line) throw new Error(result.error?.message ?? (result.stderr || result.stdout || "ego-browser 没有输出").slice(-300));

  return JSON.parse(line);
}

/** clean：关掉名字以 bys 开头的 Ego 任务空间、关掉残留的测试浏览器、删没在用的临时配置目录；工作树只列出能删的。 */
async function clean() {
  const commands = (spawnSync("ps", ["-axo", "command="], { encoding: "utf8" }).stdout ?? "").split("\n");

  console.log("Ego 任务空间：");

  if (spawnSync("which", ["ego-browser"]).status !== 0) {
    console.log("  没装 ego-browser，跳过");
  } else if (egoBusy(commands).length) {
    console.log(`  有评测正在用 Ego（${egoBusy(commands).length} 个进程），这次一个也不关。等它跑完再清。`);
  } else {
    try {
      const spaces = ego("const s = await listTaskSpaces(); console.log(JSON.stringify(s.map(x => ({ id: x.spaceId ?? x.id, name: x.name ?? '', ownership: x.ownership ?? '' }))));");
      // 只关我们的脚本建的空间：名字以 bys 开头（compare-real 建的是「bys-real …」）。其余一律不碰，不按 ownership 判断：
      // 用户的空间在某一刻可能不是 "user"（例如没人认领），按 ownership 判断会把它当成我们的关掉（10-14 定）。
      const mine = spaces.filter(space => /^bys/i.test(String(space.name ?? "")));
      console.log(`  共 ${spaces.length} 个；名字以 bys 开头的 ${mine.length} 个要关，其余 ${spaces.length - mine.length} 个不碰。`);

      for (const space of spaces) console.log(`    ${mine.includes(space) ? "关" : "留"}  #${space.id}「${space.name}」 ownership=${space.ownership || "?"}`);

      for (const space of mine) {
        // finish() 只把空间交回去，ego 会给空窗口补一个空白页：在协议层关掉每个标签页，空间才真的关掉。
        const closed = ego(`let task; try { task = await takeOverTaskSpace(${JSON.stringify(space.id)}); } catch { task = await taskSpace(${JSON.stringify(space.id)}); }
const tabs = await task.tabs(); let n = 0;
for (const t of tabs) { await task.cdp("Target.closeTarget", { targetId: t.targetId }).then(() => n++).catch(() => {}); }
console.log(JSON.stringify({ n }));`);
        console.log(`  ✓ 关了「${space.name}」（${closed.n} 个标签页）`);
      }
    } catch (error) {
      console.log(`  ✗ 读不到任务空间：${error.message}`);
    }
  }

  console.log("测试浏览器：");
  const browsers = testBrowsers();

  if (!browsers.length) console.log("  没有");

  for (const item of browsers) {
    // 只关确定没人在用的：无头的、启动它的脚本已经没了；或者开了超过 3 小时（最长的评测约半小时）。
    // 有窗口的测试浏览器经 open -g 启动，上级进程本来就是 launchd，不能按“上级没了”判断。
    const line = spawnSync("ps", ["-o", "ppid=,etime=,command=", "-p", String(item.pid)], { encoding: "utf8" }).stdout.trim();
    const [ppid, etime] = line.split(/\s+/);
    const hours = elapsedHours(etime ?? "");
    const orphan = (Number(ppid) === 1 && /--headless/.test(line)) || hours > 3;

    if (!orphan) { console.log(`  pid ${item.pid} 可能还有测试在用（开了 ${hours.toFixed(1)} 小时），不关`); continue; }
    try { process.kill(item.pid, "SIGTERM"); console.log(`  ✓ 关了 pid ${item.pid}`); } catch { console.log(`  pid ${item.pid} 已经不在了`); }
  }

  await new Promise(done => setTimeout(done, 1_000));
  const after = (spawnSync("ps", ["-axo", "command="], { encoding: "utf8" }).stdout ?? "").split("\n");
  const dirs = tempDirs();
  let removed = 0;
  let kept = 0;

  for (const dir of dirs) {
    // 构建好的扩展（sideagent-suite-dist-）只靠环境变量传，命令行里看不到：3 小时内动过的一律留着。
    const fresh = Date.now() - statSync(dir).mtimeMs < 3 * 3_600_000;

    if (fresh || inUse(dir, after)) { kept += 1; continue; }

    try { rmSync(dir, { recursive: true, force: true }); removed += 1; } catch { kept += 1; }
  }

  console.log(`临时配置目录：删了 ${removed} 个；${kept} 个还有进程在用或 3 小时内动过，留着。`);

  console.log("工作树（只列出，不自动删）：");
  const lines = spawnSync(process.execPath, [join(here, "lines.mjs")], { encoding: "utf8" }).stdout ?? "";
  const removable = lines.split("\n").filter(line => /可删/.test(line));
  console.log(removable.length ? removable.join("\n") : "  没有能删的");
}

async function env() {
  const now = load();
  console.log(`负载（1 分钟）：${now.toFixed(1)}${now > LOAD_LIMIT ? `  ⚠ 超过 ${LOAD_LIMIT}，先别测量` : ""}`);
  const top = spawnSync("ps", ["-Ao", "pcpu=,comm="], { encoding: "utf8" }).stdout.split("\n").filter(Boolean)
    .map(line => line.trim().split(/\s+/)).map(([cpu, ...name]) => ({ cpu: Number(cpu), name: name.join(" ").split("/").pop() }))
    .sort((a, b) => b.cpu - a.cpu).slice(0, 5);
  console.log(`  占 CPU 最多：${top.map(item => `${item.name} ${item.cpu}%`).join("，")}`);

  console.log("\n模型登录（只看过期时间）：");

  for (const item of logins()) console.log(`  ${item.expired ? "⚠" : " "} ${item.name}：${item.note}`);

  console.log("\n残留：");
  const browsers = testBrowsers();
  const dirs = tempDirs();
  console.log(`  测试浏览器 ${browsers.length} 个${browsers.length ? `（pid ${browsers.map(item => item.pid).join("、")}；可能有测试正在用，clean 只关确定没人在用的）` : ""}`);
  console.log(`  临时配置目录 ${dirs.length} 个${dirs.length ? "（npm run lab -- clean 删掉没在用的）" : ""}`);

  console.log("\n本机测试网站：");
  await sites("status");

  console.log("\n工作树：");
  spawnSync(process.execPath, [join(here, "lines.mjs")], { stdio: "inherit" });
}

async function main() {
  switch (action) {
    case "env": return env();
    case "sites": return sites(rest[0]);
    case "case": return cases();
    case "eval": return evaluate();
    case "clean": return clean();
    case "gallery": return gallery();
    case "methods": {
      const result = spawnSync(process.execPath, [join(here, "method-report.mjs"), ...rest], { stdio: "inherit" });

      process.exit(result.status ?? 1);
    }
    case "logs": {
      const result = spawnSync(process.execPath, [join(here, "logs.mjs"), ...rest], { stdio: "inherit" });

      process.exit(result.status ?? 1);
    }
    default:
      console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].split("\n").filter(line => line.startsWith(" *")).map(line => line.slice(3)).join("\n"));
      process.exit(action ? 1 : 0);
  }
}

await main();
