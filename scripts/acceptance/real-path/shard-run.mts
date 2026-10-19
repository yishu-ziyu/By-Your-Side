/**
 * 跨机器分片跑本目录验收：本机构建一次扩展 dist，分发到各节点，并行执行，汇总结果。
 *
 *   npx tsx scripts/acceptance/real-path/shard-run.mts            # 同步环境 + 全量分片
 *   npx tsx scripts/acceptance/real-path/shard-run.mts --prepare  # 只做环境检查与首次同步
 *   --core            只分片 CORE 用例（同 run-all）
 *   --only=a,b        只跑指定用例
 *   --skip=aliyun     临时停用某节点
 *
 * 节点表在 ../nodes.mts；各节点怎么连、怎么救活见 docs/testing/cloud-nodes.md。
 * 每个节点把当轮 summary JSON 打在 ===shard-summary=== 标记后，本脚本收集合并。
 * 节点中途挂掉时它分到的用例记为 missing，不算通过。
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO } from "./harness.mts";
import { NODES, SSH_OPTS, type Node } from "../nodes.mts";

const HERE = join(REPO, "scripts/acceptance/real-path");
const OUT = join(REPO, "out/acceptance/real-path");

// 与 run-all.mts 的 SKIP 保持一致。
const SKIP = new Set(["harness.mts", "run-all.mts", "shard-run.mts", "background-tab-input.mts", "attention-cues.mts"]);

// 与 run-all.mts 的 CORE 保持一致。
const CORE = [
  "sidebar-interaction", "composer-expand", "script-friction", "target-gone", "pdf-download", "memory-used-line",
  "session-durability", "error-recovery", "model-failover", "welcome-context", "claim-after-check", "refill-after-check", "readback-privacy", "snapshot-privacy",
  "send-confirm", "panel-send-confirm", "pay-stop", "handoff", "answer-straight", "retry-after-unknown", "site-hint", "panel-tidy", "keep-foreground", "navigate-wait",
  "double-click-new-tab", "reading-correction", "http-page-select", "reading-card-after-reinject", "click-blocked-reason", "settle-after-requests", "slot-yields-to-new-task", "history-prefix", "program-receipt", "process-block", "wait-inline-timer", "overflow-retry",
];

const argv = process.argv.slice(2);
const prepare = argv.includes("--prepare");
const coreOnly = argv.includes("--core");
const onlyArg = argv.find((a) => a.startsWith("--only="));
const skipArg = argv.find((a) => a.startsWith("--skip="));
const skips = new Set((skipArg?.slice("--skip=".length) ?? "").split(",").filter(Boolean));

const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const allCases = (await readdir(HERE))
  .filter((f) => f.endsWith(".mts") && !SKIP.has(f))
  .map((f) => f.replace(/\.mts$/, ""))
  .sort();

const wanted = coreOnly ? CORE : onlyArg ? onlyArg.slice("--only=".length).split(",") : allCases;
const unknown = wanted.filter((n) => !allCases.includes(n));
if (unknown.length) {
  console.error(`用例不存在：${unknown.join("、")}`);
  process.exit(1);
}

const nodes = NODES.filter((n) => !skips.has(n.name));
if (!nodes.length) {
  console.error("没有可用节点");
  process.exit(1);
}

// 按 weight 轮转分配。
const shards = new Map<Node, string[]>(nodes.map((n) => [n, []]));
const wheel = nodes.flatMap((n) => Array(n.weight).fill(n));
wanted.forEach((name, i) => shards.get(wheel[i % wheel.length])!.push(name));

// 本机构建一次 dist 到独立目录：不动日常 Chrome 正在加载的 extension/dist。
// ssh 节点拿这份 bits，每片测的是同一份扩展；drs 节点在同一提交上自行构建。
const distDir = join(REPO, "out/acceptance/shard-dist");
execFileSync(process.execPath, [join(REPO, "extension/build.mjs")], {
  env: { ...process.env, SIDEAGENT_BUILD_DIST: distDir },
  stdio: ["ignore", "ignore", "inherit"],
});

const SSH_OPTS_STR = SSH_OPTS.join(" ");

function sh(cmd: string, args: string[], logPrefix: string, timeoutMs?: number): Promise<{ code: number | null; out: string; timedOut?: boolean }> {
  return new Promise((done) => {
    const child = spawn(cmd, args);
    let out = "";
    let timedOut = false;
    // 云节点会卡住不返回（Devin 沙箱被暂停、grokbox 中途休眠）：到点就杀掉，记成超时而不是一直等。
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs) : undefined;
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => { clearTimeout(timer); done({ code, out, timedOut }); });
    child.on("error", (e) => { clearTimeout(timer); out += String(e); done({ code: null, out, timedOut }); });
    void logPrefix;
  });
}

// findJson：从混有杂讯的输出里取第一个配对完整的 JSON 对象。
function findJson(s: string): string {
  const start = s.indexOf("{");
  if (start < 0) return s;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (!depth) return s.slice(start, i + 1); }
  }
  return s.slice(start);
}

function sshRun(node: Node, cmd: string, timeoutMs?: number): Promise<{ code: number | null; out: string; timedOut?: boolean }> {
  return sh("ssh", [...SSH_OPTS, node.host!, `bash -lc '${cmd.replace(/'/g, "'\\''")}'`], `[${node.name}]`, timeoutMs);
}

// 远端跑分片：定位 Chrome → 跑 run-all --only → 把当轮 summary JSON 打在标记后。
function remoteCmd(node: Node, names: string[]): string {
  const dir = node.dir!;
  const chromeExpr = node.chrome!.includes("*")
    ? `$(ls -d ${node.chrome} 2>/dev/null | head -1)`
    : node.chrome!.startsWith("/") ? node.chrome! : `$(command -v ${node.chrome})`;
  return [
    `cd ${dir}`,
    `export EGO_ACCEPTANCE_CHROME="${chromeExpr}"`,
    `export SIDEAGENT_ACCEPTANCE_DIST=${dir}/.shard-dist`,
    // 本机设的“允许重跑”要带到远端，否则远端按“同一代码已失败两次”拒绝运行。
    ...(process.env.BYS_RERUN === "1" ? ["export BYS_RERUN=1"] : []),
    // 先清掉旧 summary，避免 run-all 提前退出时误读上一轮结果。
    // run-all 有用例失败时 exit 1，summary 必须无条件打印，所以这一段用分号不用 &&。
    `rm -f out/acceptance/real-path/summary-*.json; npx tsx scripts/acceptance/real-path/run-all.mts --only=${names.join(",")} --jobs=${node.jobs}; echo "===shard-summary==="; cat "$(ls -t out/acceptance/real-path/summary-*.json | head -1)"`,
  ].join(" && ");
}

type Row = { name: string; status: string; exitCode: number | null; seconds: number };
type NodeResult = { node: string; ran: Row[]; raw: string; timedOut?: boolean };

async function runNode(node: Node, names: string[]): Promise<NodeResult> {
  if (node.kind === "local") {
    execFileSync("bash", ["-lc", `rm -f ${OUT}/summary-*.json`]);
    const child = spawn("npx", ["tsx", join(HERE, "run-all.mts"), `--only=${names.join(",")}`, `--jobs=${node.jobs}`],
      { env: { ...process.env, SIDEAGENT_ACCEPTANCE_DIST: distDir } });
    const r = await new Promise<{ code: number | null; out: string }>((done) => {
      let out = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { out += d; });
      child.on("close", (code) => done({ code, out }));
    });
    const latest = execFileSync("bash", ["-lc", `ls -t ${OUT}/summary-*.json | head -1`], { encoding: "utf8" }).trim();
    const summary = JSON.parse(await readFile(latest, "utf8"));
    return { node: node.name, ran: summary.results, raw: r.out };
  }
  // 每个用例平均一两分钟；按“每轮同时跑 jobs 个、每轮最多 6 分钟”再加 5 分钟准备时间给上限。
  const deadline = (5 + Math.ceil(names.length / node.jobs) * 6) * 60_000;
  const r = node.kind === "ssh"
    ? await sshRun(node, remoteCmd(node, names), deadline)
    : await sh("devin", ["cloud", "drs", "run", "--devin-id", node.devinId!, "--command", remoteCmd(node, names), "--timeout", String(Math.round(deadline / 1000))], "[devin]", deadline);
  // drs run 把远端 stdout 包在自己的 JSON 响应里，先剥掉外层。
  let payload = r.out;
  try {
    const outer = JSON.parse(findJson(r.out));
    if (outer?.response?.stdout) payload = outer.response.stdout;
  } catch { /* ssh 输出不是 JSON 包装 */ }
  const marked = payload.split("===shard-summary===").pop() ?? "";
  try {
    const summary = JSON.parse(findJson(marked));
    return { node: node.name, ran: summary.results ?? [], raw: payload, timedOut: r.timedOut };
  } catch {
    return { node: node.name, ran: [], raw: payload, timedOut: r.timedOut };
  }
}

// 每轮都执行：同步代码与 dist、按需补依赖。返回 false 的节点本轮跳过。
async function syncNode(node: Node): Promise<boolean> {
  const tag = `[${node.name}]`;
  if (node.kind === "local") return true;
  if (node.kind === "ssh") {
    // 云节点可能刚被唤醒或休眠中，多试几次再判不可用。
    let up = await sshRun(node, "echo ok");
    for (let i = 0; !up.out.includes("ok") && i < 3; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      up = await sshRun(node, "echo ok");
    }
    if (!up.out.includes("ok")) { console.log(`${tag} 连不上 ${node.host}`); return false; }
    // 只同步跑测试需要的文件（约 4MB）：grokbox 这类节点可能中途休眠，全仓库传输来不及。
    // 用 tar 流而不是 rsync——远端可能没有 rsync，快照恢复后装的工具也会丢。
    const push = async (src: string, dst: string, clean: boolean) => {
      // macOS tar 默认把扩展属性打成 ._* 文件，远端 run-all 会把它们当成用例名；顺手清掉以前推过去的。
      const pre = clean
        ? `mkdir -p ${dst} && rm -rf ${dst}/* ${dst}/.[!.]* ; `
        : `mkdir -p ${dst} && find ${dst} -name "._*" -delete ; `;
      const pack = clean
        ? "tar -cz ."
        : "tar -cz --exclude=extension/dist scripts agent shared extension eval/harness package.json package-lock.json";
      for (let i = 0; i < 5; i++) {
        const r = await sh("bash", ["-lc",
          `cd ${src} && COPYFILE_DISABLE=1 ${pack} | ssh ${SSH_OPTS_STR} ${node.host} '${pre}tar -xz -C ${dst}'`], tag);
        if (r.code === 0) return true;
        await new Promise((d) => setTimeout(d, 4000));
      }
      return false;
    };
    if (!(await push(REPO, node.dir!, false))) { console.log(`${tag} repo 同步失败`); return false; }
    const hasNode = await sshRun(node, "command -v node >/dev/null && node --version || echo MISSING");
    if (hasNode.out.includes("MISSING")) {
      console.log(`${tag} 安装 Node 22`);
      const ins = await sshRun(node, `S=$(sudo -n true 2>/dev/null && echo "sudo -n" || echo "") && curl -fsSL https://registry.npmmirror.com/-/binary/node/v22.20.0/node-v22.20.0-linux-x64.tar.xz -o /tmp/node.tar.xz && $S mkdir -p /opt && $S tar -xJf /tmp/node.tar.xz -C /opt && $S ln -sf /opt/node-v22.20.0-linux-x64/bin/node /opt/node-v22.20.0-linux-x64/bin/npm /opt/node-v22.20.0-linux-x64/bin/npx /usr/local/bin/ && node --version`);
      if (ins.code !== 0 || !ins.out.includes("v22")) { console.log(`${tag} Node 安装失败`); return false; }
    }
    if (!(await push(distDir, `${node.dir}/.shard-dist`, true))) { console.log(`${tag} dist 同步失败`); return false; }
    const localLock = execFileSync("md5", ["-q", join(REPO, "package-lock.json")], { encoding: "utf8" }).trim();
    const remoteLock = await sshRun(node, `md5sum ${node.dir}/package-lock.json | cut -d' ' -f1`);
    if (remoteLock.out.trim() !== localLock) {
      console.log(`${tag} 锁文件变了，重装依赖`);
      const deps = await sshRun(node, `cd ${node.dir} && npm ci --registry=https://registry.npmmirror.com --no-audit --no-fund 2>&1 | tail -3`);
      if (deps.code !== 0) { console.log(`${tag} npm ci 失败`); return false; }
    }
    // 真模型用例读 ~/.sideagent/providers.local.json（走 pi-auth 的 OAuth 条目不在此列）。
    // 内容与本机不一致就重推；grokbox 这类快照节点权威副本放 agent-data，睡醒后 symlink 回来。
    const secretPath = join(homedir(), ".sideagent/providers.local.json");
    if (!existsSync(secretPath)) { console.log(`${tag} 缺 providers.local.json，真模型用例会在该节点失败`); }
    else {
      const secretMd5 = execFileSync("md5", ["-q", secretPath], { encoding: "utf8" }).trim();
      const remoteMd5 = await sshRun(node, `mkdir -p ~/.sideagent && [ -f ~/agent-data/sideagent/providers.local.json ] && ln -sf ~/agent-data/sideagent/providers.local.json ~/.sideagent/providers.local.json; md5sum ~/.sideagent/providers.local.json 2>/dev/null | cut -d' ' -f1 || echo NONE`);
      if (remoteMd5.out.trim() !== secretMd5) {
        const pushed = await sh("bash", ["-lc",
          `ssh ${SSH_OPTS_STR} ${node.host} 'mkdir -p ~/agent-data/sideagent ~/.sideagent && cat > ~/agent-data/sideagent/providers.local.json && chmod 600 ~/agent-data/sideagent/providers.local.json && ln -sf ~/agent-data/sideagent/providers.local.json ~/.sideagent/providers.local.json' < ${JSON.stringify(secretPath)}`], tag);
        if (pushed.code !== 0) console.log(`${tag} providers.local.json 下发失败`);
      }
    }
    return true;
  }
  // drs：仓库由 Devin 克隆好，切到本地 HEAD 同一提交后装依赖、建 dist、拷到 .shard-dist。
  const sha = execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["-C", REPO, "status", "--porcelain"], { encoding: "utf8" }).trim();
  if (dirty) console.log(`${tag} 注意：本机有未提交改动，此节点只跑已提交的 ${sha.slice(0, 8)}`);
  // Devin 只能拿 origin 上的代码：本地 sha 没推送时退回 origin/main，并在输出里标明实际版本。
  const cmd = `cd ${node.dir} && git fetch origin && (git checkout ${sha} 2>/dev/null || { echo "本机 HEAD 未推送，改跑 origin/main"; git checkout origin/main; }) && npm install --no-audit --no-fund >/dev/null 2>&1 && node extension/build.mjs >/dev/null 2>&1 && rm -rf .shard-dist && cp -r extension/dist .shard-dist && echo "prepared $(git rev-parse --short HEAD)"`;
  const r = await sh("devin", ["cloud", "drs", "run", "--devin-id", node.devinId!, "--command", cmd, "--timeout", "1200"], tag);
  if (!r.out.includes("prepared")) return false;
  // 真模型凭据：沙箱没有就从阿里云拉。私钥只在沙箱里，公钥经本机加到阿里云 authorized_keys——文件内容不经过命令行。
  const localSecret = join(homedir(), ".sideagent/providers.local.json");
  const secretMd5 = existsSync(localSecret) ? execFileSync("md5", ["-q", localSecret], { encoding: "utf8" }).trim() : "NONE";
  const probe = await sh("devin", ["cloud", "drs", "run", "--devin-id", node.devinId!, "--command",
    `md5sum ~/.sideagent/providers.local.json 2>/dev/null | cut -d' ' -f1 || echo NONE`, "--timeout", "120"], tag);
  if (probe.out.trim().split("\n").pop() !== secretMd5) {
    const pubGen = await sh("devin", ["cloud", "drs", "run", "--devin-id", node.devinId!, "--command",
      `test -f ~/.ssh/devin_pull.pub && cat ~/.ssh/devin_pull.pub || { ssh-keygen -t ed25519 -N "" -f ~/.ssh/devin_pull -q && cat ~/.ssh/devin_pull.pub; }`, "--timeout", "120"], tag);
    const pub = pubGen.out.match(/ssh-ed25519 \S+/);
    const bridge = NODES.find((n) => n.name === "aliyun")?.host;
    if (pub && bridge) {
      await sh("ssh", [...SSH_OPTS, bridge, `grep -qF '${pub[0]}' ~/.ssh/authorized_keys || echo '${pub[0]} devin-pull' >> ~/.ssh/authorized_keys`], tag);
      const pull = await sh("devin", ["cloud", "drs", "run", "--devin-id", node.devinId!, "--command",
        `mkdir -p ~/.sideagent && scp -i ~/.ssh/devin_pull -o StrictHostKeyChecking=accept-new ${bridge}:~/.sideagent/providers.local.json ~/.sideagent/ && chmod 600 ~/.sideagent/providers.local.json && wc -c ~/.sideagent/providers.local.json`, "--timeout", "120"], tag);
      if (!/\d+ .*providers/.test(pull.out)) console.log(`${tag} providers.local.json 下发失败`);
    }
  }
  return true;
}

// --prepare 的额外资产生成：远端没有 Chrome 时用 Playwright 装一份。
async function ensureChrome(node: Node): Promise<boolean> {
  if (node.kind !== "ssh") return true;
  const tag = `[${node.name}]`;
  // chrome 是绝对路径（可含 glob）时逐枚查可执行文件；否则按命令名查 PATH。
  const probe = node.chrome!.startsWith("/")
    ? `for f in ${node.chrome}; do [ -x "$f" ] && { echo "$f"; break; }; done`
    : `command -v ${node.chrome}`;
  // 只认输出里形如绝对路径的行，避开 ssh 告警等杂讯。
  const found = (out: string) => out.split("\n").map((l) => l.trim()).find((l) => l.startsWith("/"));
  let r = await sshRun(node, probe);
  if (!found(r.out)) {
    console.log(`${tag} 安装 Chrome`);
    await sshRun(node, `cd ${node.dir} && npx playwright install chromium && (sudo -n npx playwright install-deps chromium || true)`);
    r = await sshRun(node, probe);
  }
  const ok = Boolean(found(r.out));
  if (!ok) console.log(`${tag} 没有可用 Chrome`);
  return ok;
}

console.log(`用例 ${wanted.length} 个 → ${nodes.map((n) => `${n.name}×${shards.get(n)!.length}`).join(" + ")}`);

const ready: Node[] = [];
for (const node of nodes) {
  if ((await syncNode(node)) && (await ensureChrome(node))) ready.push(node);
  else console.log(`[${node.name}] 不可用，本片用例记为未跑`);
}
if (prepare) process.exit(ready.length === nodes.length ? 0 : 1);
if (!ready.length) {
  console.error("所有节点都不可用");
  process.exit(1);
}

const started = Date.now();
const settled = await Promise.all(ready.map((n) => runNode(n, shards.get(n)!)));

const rows: { node: string; name: string; status: string; seconds: number; reason?: string }[] = [];
const seen = new Set<string>();
// run-all 给每个失败用例打印“✘ 名字 (Ns)”加 15 行日志尾巴（每行以 │ 开头）；取其中最像原因的一行。
const reasonOf = (raw: string, name: string): string | undefined => {
  const lines = raw.split("\n");
  const at = lines.findIndex((l) => l.startsWith(`✘ ${name} (`));
  if (at < 0) return undefined;
  // 只看紧跟在这一行后面、以 │ 开头的日志块，遇到别的行就停，不串到下一个用例。
  const end = lines.findIndex((l, i) => i > at && !/^\s*(│|\/)/.test(l));
  const tail = lines.slice(at + 1, end < 0 ? undefined : end).filter((l) => l.includes("│")).map((l) => l.replace(/^\s*│ ?/, "").trim()).filter(Boolean);
  return (tail.find((l) => /Error|FAIL|超时|失败|断言|not ok/i.test(l)) ?? tail.at(-1))?.slice(0, 200);
};
const lastLines = (raw: string) => raw.trimEnd().split("\n").slice(-3).join(" ⏎ ").slice(0, 300);
for (const r of settled) {
  for (const row of r.ran) {
    if (row.status === "not-run") continue;
    seen.add(row.name);
    rows.push({ node: r.node, name: row.name, status: row.status, seconds: row.seconds,
      reason: row.status === "fail" ? reasonOf(r.raw, row.name) : undefined });
  }
  if (!r.ran.length) {
    const why = r.timedOut ? `节点超时：${lastLines(r.raw)}` : `节点没交回结果：${lastLines(r.raw)}`;
    for (const c of shards.get(nodes.find((n) => n.name === r.node)!)!) rows.push({ node: r.node, name: c, status: "missing", seconds: 0, reason: why });
  }
}
for (const n of nodes) {
  if (!ready.includes(n)) for (const c of shards.get(n)!) rows.push({ node: n.name, name: c, status: "missing", seconds: 0, reason: "节点不可用（连不上或准备失败）" });
}
for (const c of wanted) if (!seen.has(c) && !rows.some((r) => r.name === c)) rows.push({ node: "-", name: c, status: "missing", seconds: 0 });
rows.sort((a, b) => a.name.localeCompare(b.name));

const failed = rows.filter((r) => r.status === "fail");
const missing = rows.filter((r) => r.status === "missing");
const wall = Math.round((Date.now() - started) / 1000);

// 每个节点的完整输出留在 out/，失败原因只看一行不够时去这里找。
const logDir = join(OUT, `shard-${stamp}`);
await mkdir(logDir, { recursive: true });
for (const r of settled) await writeFile(join(logDir, `${r.node}.log`), r.raw);

for (const r of rows) {
  console.log(`${r.status === "pass" ? "✔" : r.status === "fail" ? "✘" : "?"} ${r.name}  ${r.node}  ${r.seconds}s`);
  if (r.reason) console.log(`    └ ${r.reason}`);
}
console.log(`\n${rows.length} 例：过 ${rows.length - failed.length - missing.length}，败 ${failed.length}，未跑 ${missing.length}；整轮 ${wall}s`);
console.log(`各节点完整输出：${logDir}`);

await writeFile(join(OUT, `shard-${stamp}.json`), JSON.stringify({ wall, rows, logDir }, null, 2));

process.exit(failed.length || missing.length ? 1 : 0);
