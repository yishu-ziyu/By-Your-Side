/**
 * 云电脑节点表与核心验收清单：分片验收（real-path/shard-run.mts）、本机整轮（real-path/run-all.mts）和节点状态（nodes-status.mts）共用。
 * 远端主机地址与沙箱 ID 从本机 ~/.sideagent/nodes.local.json 或环境变量读取，不在公开仓库源码中硬编码服务器 IP。
 * 每台机器怎么连、怎么唤醒、踩过的坑见 docs/testing/cloud-nodes.md。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Node = {
  name: string;
  kind: "local" | "ssh" | "drs";
  weight: number; // 分片权重：快机器多分几个用例
  jobs: number;
  host?: string;      // ssh: user@host
  dir?: string;       // 远端 repo 目录
  devinId?: string;   // drs: sandbox session id
  chrome?: string;    // 远端 Chrome 路径（可含 glob，远端展开）
};

type NodeOverride = Partial<Pick<Node, "host" | "dir" | "devinId" | "chrome" | "weight" | "jobs">>;

function parseNodeOverride(raw: unknown): NodeOverride {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const out: NodeOverride = {};
  if (typeof obj.host === "string" && obj.host.trim()) out.host = obj.host.trim();
  if (typeof obj.dir === "string" && obj.dir.trim()) out.dir = obj.dir.trim();
  if (typeof obj.devinId === "string" && obj.devinId.trim()) out.devinId = obj.devinId.trim();
  if (typeof obj.chrome === "string" && obj.chrome.trim()) out.chrome = obj.chrome.trim();
  if (typeof obj.weight === "number" && Number.isFinite(obj.weight) && obj.weight > 0) out.weight = obj.weight;
  if (typeof obj.jobs === "number" && Number.isInteger(obj.jobs) && obj.jobs > 0) out.jobs = obj.jobs;
  return out;
}

function loadLocalOverrides(): Record<string, NodeOverride> {
  const file = process.env.BYS_NODES_FILE ?? join(homedir(), ".sideagent/nodes.local.json");
  if (!existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, NodeOverride> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      out[key] = parseNodeOverride(value);
    }
    return out;
  } catch {
    return {};
  }
}

const overrides = loadLocalOverrides();

const BASE_NODES: Node[] = [
  { name: "local", kind: "local", weight: 2, jobs: 2 },
  { name: "aliyun", kind: "ssh", weight: 1, jobs: 1, host: process.env.BYS_ALIYUN_HOST?.trim() || undefined, dir: "/root/bys",
    chrome: "/opt/chrome-for-testing/chrome-linux64/chrome" },
  { name: "devin", kind: "drs", weight: 3, jobs: 4, devinId: process.env.BYS_DEVIN_ID?.trim() || undefined,
    dir: "~/repos/By-Your-Side", chrome: "google-chrome" },
  { name: "grokbox", kind: "ssh", weight: 2, jobs: 2, host: process.env.BYS_GROKBOX_HOST?.trim() || undefined, dir: "/home/box/bys",
    chrome: "/home/box/.cache/ms-playwright/chromium-*/chrome-linux*/chrome" },
];

export const NODES: Node[] = BASE_NODES.map((node) => ({
  ...node,
  ...overrides[node.name],
}));

// 远端 SSH 偶尔在握手阶段直接断开：复用同一条连接减少握手次数；失败时调用方再重试。
export const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ConnectionAttempts=3",
  "-o", "ControlMaster=auto", "-o", "ControlPath=/tmp/bys-ssh-%C", "-o", "ControlPersist=120"];

// background-tab-input 和 attention-cues 要有窗口的 Chrome（会开窗口）；learned-operations-live 需要真实模型凭据，都不进默认整轮。
export const SKIP_FILES = new Set(["harness.mts", "run-all.mts", "shard-run.mts", "background-tab-input.mts", "attention-cues.mts", "learned-operations-live.mts"]);

// 核心用户路径（npm test / accept:shard --core 共用唯一清单）：只装扩展、脚本模型、无需凭据。
export const CORE_CASES = [
  "sidebar-interaction", "composer-expand", "script-friction", "target-gone", "pdf-download", "memory-used-line",
  "session-durability", "error-recovery", "model-failover", "claim-after-check", "refill-after-check", "readback-privacy", "snapshot-privacy",
  "send-confirm", "panel-send-confirm", "pay-stop", "handoff", "answer-straight", "retry-after-unknown", "site-hint", "panel-tidy", "keep-foreground", "navigate-wait",
  "double-click-new-tab", "reading-correction", "http-page-select", "reading-card-after-reinject", "click-blocked-reason", "settle-after-requests", "slot-yields-to-new-task", "history-prefix", "program-receipt", "process-block", "wait-inline-timer", "overflow-retry",
  "restart-resume", "file-attachments", "self-use-isolation", "tab-id-hidden", "open-in-front", "video-captions", "quiet-background-tabs", "mermaid-diagram", "caveat-not-unfinished", "stream-stall-retry", "network-before-recording", "mini-apps-setting", "goal-continue-budget", "run-clock", "check-window-card", "long-source-answer",
];
