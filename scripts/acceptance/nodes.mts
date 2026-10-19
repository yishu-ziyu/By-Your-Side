/**
 * 云电脑节点表：分片验收（real-path/shard-run.mts）和节点状态（nodes-status.mts）共用。
 * 每台机器怎么连、怎么唤醒、踩过的坑见 docs/testing/cloud-nodes.md。
 */
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

export const NODES: Node[] = [
  { name: "local", kind: "local", weight: 2, jobs: 2 },
  { name: "aliyun", kind: "ssh", weight: 1, jobs: 1, host: "root@121.89.90.68", dir: "/root/bys",
    chrome: "/opt/chrome-for-testing/chrome-linux64/chrome" },
  { name: "devin", kind: "drs", weight: 3, jobs: 4, devinId: "100916ca2fd74266b2080741d2952ca7",
    dir: "~/repos/By-Your-Side", chrome: "google-chrome" },
  { name: "grokbox", kind: "ssh", weight: 2, jobs: 2, host: "box@100.124.81.45", dir: "/home/box/bys",
    chrome: "/home/box/.cache/ms-playwright/chromium-*/chrome-linux*/chrome" },
];

// 阿里云偶尔在握手阶段直接断开（sshd 日志里没有记录）：复用同一条连接减少握手次数；sh 失败时调用方再重试。
export const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ConnectionAttempts=3",
  "-o", "ControlMaster=auto", "-o", "ControlPath=/tmp/bys-ssh-%C", "-o", "ControlPersist=120"];
