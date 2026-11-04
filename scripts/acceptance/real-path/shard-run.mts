import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO } from "./harness.mts";
import { CORE_CASES as CORE, NODES, SKIP_FILES as SKIP, SSH_OPTS, type Node } from "../nodes.mts";

const HERE = join(REPO, "scripts/acceptance/real-path");
const OUT = join(REPO, "out/acceptance/real-path");

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

const shards = new Map<Node, string[]>(nodes.map((n) => [n, []]));
const wheel = nodes.flatMap((n) => Array(n.weight).fill(n));
wanted.forEach((name, i) => shards.get(wheel[i % wheel.length])!.push(name));

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
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs) : undefined;
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => { clearTimeout(timer); done({ code, out, timedOut }); });
    child.on("error", (e) => { clearTimeout(timer); out += String(e); done({ code: null, out, timedOut }); });
    void logPrefix;
  });
}

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

function remoteCmd(node: Node, names: string[]): string {
  const dir = node.dir!;
  const chromeExpr = node.chrome!.includes("*")
    ? `$(ls -d ${node.chrome} 2>/dev/null | head -1)`
    : node.chrome!.startsWith("/") ? node.chrome! : `$(command -v ${node.chrome})`;
  return [
    `cd ${dir}`,
    `export EGO_ACCEPTANCE_CHROME="${chromeExpr}"`,
    `export SIDEAGENT_ACCEPTANCE_DIST=${dir}/.shard-dist`,
    ...(process.env.BYS_RERUN === "1" ? ["export BYS_RERUN=1"] : []),
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
  const deadline = (5 + Math.ceil(names.length / node.jobs) * 6) * 60_000;
  const r = node.kind === "ssh"
    ? await sshRun(node, remoteCmd(node, names), deadline)
    : await sh("devin", ["cloud", "drs", "run", "--devin-id", node.devinId!, "--command", remoteCmd(node, names), "--timeout", String(Math.round(deadline / 1000))], "[devin]", deadline);
  let payload = r.out;
  try {
    const outer = JSON.parse(findJson(r.out));
    if (outer?.response?.stdout) payload = outer.response.stdout;
  } catch {  }
  const marked = payload.split("===shard-summary===").pop() ?? "";
  try {
    const summary = JSON.parse(findJson(marked));
    return { node: node.name, ran: summary.results ?? [], raw: payload, timedOut: r.timedOut };
  } catch {
    return { node: node.name, ran: [], raw: payload, timedOut: r.timedOut };
  }
}

async function syncNode(node: Node): Promise<boolean> {
  const tag = `[${node.name}]`;
  if (node.kind === "local") return true;
  if (node.kind === "ssh") {
    if (!node.host) { console.log(`${tag} 未配置 host（见 ~/.sideagent/nodes.local.json）`); return false; }
    let up = await sshRun(node, "echo ok");
    for (let i = 0; !up.out.includes("ok") && i < 3; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      up = await sshRun(node, "echo ok");
    }
    if (!up.out.includes("ok")) { console.log(`${tag} 连不上 ${node.host}`); return false; }
    const push = async (src: string, dst: string, clean: boolean) => {
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
  if (!node.devinId) { console.log(`${tag} 未配置 devinId（见 ~/.sideagent/nodes.local.json）`); return false; }
  const sha = execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["-C", REPO, "status", "--porcelain"], { encoding: "utf8" }).trim();
  if (dirty) console.log(`${tag} 注意：本机有未提交改动，此节点只跑已提交的 ${sha.slice(0, 8)}`);
  const cmd = `cd ${node.dir} && git fetch origin && (git checkout ${sha} 2>/dev/null || { echo "本机 HEAD 未推送，改跑 origin/main"; git checkout origin/main; }) && npm install --no-audit --no-fund >/dev/null 2>&1 && node extension/build.mjs >/dev/null 2>&1 && rm -rf .shard-dist && cp -r extension/dist .shard-dist && echo "prepared $(git rev-parse --short HEAD)"`;
  const r = await sh("devin", ["cloud", "drs", "run", "--devin-id", node.devinId!, "--command", cmd, "--timeout", "1200"], tag);
  if (!r.out.includes("prepared")) return false;
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

async function ensureChrome(node: Node): Promise<boolean> {
  if (node.kind !== "ssh") return true;
  const tag = `[${node.name}]`;
  const probe = node.chrome!.startsWith("/")
    ? `for f in ${node.chrome}; do [ -x "$f" ] && { echo "$f"; break; }; done`
    : `command -v ${node.chrome}`;
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
const reasonOf = (raw: string, name: string): string | undefined => {
  const lines = raw.split("\n");
  const at = lines.findIndex((l) => l.startsWith(`✘ ${name} (`));
  if (at < 0) return undefined;
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
