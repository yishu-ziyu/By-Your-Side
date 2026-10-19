/**
 * npm run nodes：一次看清所有云电脑节点能不能用。在线、开机多久、负载、可用内存、Chrome 在不在、残留的测试 Chrome；
 * grokbox 另看 sun 的保活 sleep 还剩多久（没有就是随时会睡）。只读，不改任何节点。
 */
import { spawn } from "node:child_process";
import { NODES, SSH_OPTS, type Node } from "./nodes.mts";

// 远端统一打印 key=value，本脚本只认这些行，避开登录横幅、Devin 的终端转义等杂讯。
const PROBE = [
  `echo "up=$(uptime | sed -E 's/.*up +([^,]*),.*/\\1/')"`,
  `echo "load=$( (sysctl -n vm.loadavg 2>/dev/null || cat /proc/loadavg) | tr -d '{}' | awk '{print $1}')"`,
  `echo "cores=$(nproc 2>/dev/null || sysctl -n hw.ncpu)"`,
  `echo "memfree=$(free -m 2>/dev/null | awk '/Mem/{print $7"M"}')"`,
  // 验收用的隔离 Chrome（配置目录名带 sideagent-real-path）只数主进程；测试脚本异常退出时它们会留下来一直占资源。
  `echo "testchrome=$(ps -Ao args | grep -c '[s]ideagent-real-path.*/profile' )/$(ps -Ao args | grep '[s]ideagent-real-path.*/profile' | grep -vc -- '--type=')"`,
].join("; ");

function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((done) => {
    const child = spawn(cmd, args);
    let out = "";
    const timer = setTimeout(() => { out += "\n__timeout__"; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", () => { clearTimeout(timer); done(out); });
    child.on("error", (e) => { clearTimeout(timer); done(out + String(e)); });
  });
}

function chromeCheck(node: Node): string {
  if (!node.chrome) return "";
  const test = node.chrome.startsWith("/")
    ? `for f in ${node.chrome.includes("*") ? node.chrome : `"${node.chrome}"`}; do [ -x "$f" ] && { echo chrome=yes; break; }; done`
    : `command -v ${node.chrome} >/dev/null && echo chrome=yes`;
  return `; ${test}`;
}

async function probe(node: Node, retried = false): Promise<Record<string, string>> {
  const cmd = PROBE + chromeCheck(node)
    + (node.name === "grokbox" ? `; ps -o etime=,args= -C sleep | awk '$NF=="2700"{print "keepalive=已跑 "$1"，共 45 分钟"}'` : "");
  const raw = node.kind === "local"
    ? await run("bash", ["-lc", cmd], 15_000)
    : node.kind === "ssh"
      ? await run("ssh", [...SSH_OPTS, node.host!, cmd], 25_000)
      : await run("devin", ["cloud", "drs", "run", "--devin-id", node.devinId!, "--timeout", "60", "--command", cmd], 90_000);
  const text = node.kind === "drs" ? (() => { try { return JSON.parse(raw.slice(raw.indexOf("{"))).response?.stdout ?? raw; } catch { return raw; } })() : raw;
  const fields: Record<string, string> = {};
  for (const m of text.matchAll(/\b(up|load|cores|memfree|chrome|keepalive|testchrome)=([^\n]*)/g)) fields[m[1]] = m[2].trim();
  if (!fields.up && node.kind !== "local" && !retried) return probe(node, true);
  if (!fields.up) fields.error = raw.includes("__timeout__") ? "超时（可能在休眠）" : raw.trim().split("\n").at(-1)?.slice(0, 120) ?? "无输出";
  return fields;
}

const results = await Promise.all(NODES.map(async (n) => ({ n, f: await probe(n) })));
for (const { n, f } of results) {
  if (f.error) { console.log(`✘ ${n.name.padEnd(8)} 不可用：${f.error}`); continue; }
  const parts = [`开机 ${f.up}`, `负载 ${f.load}/${f.cores} 核`, f.memfree && `可用内存 ${f.memfree}`,
    n.chrome ? (f.chrome ? "Chrome 在" : "没有 Chrome") : "",
    f.testchrome && f.testchrome.split("/")[1] !== "0" && `残留测试 Chrome ${f.testchrome.split("/")[1]} 个（没在跑测试时应为 0）`,
    n.name === "grokbox" ? (f.keepalive ?? "没有保活，随时会睡（见 docs/testing/cloud-nodes.md）") : ""].filter(Boolean);
  console.log(`✔ ${n.name.padEnd(8)} ${parts.join("，")}`);
}
