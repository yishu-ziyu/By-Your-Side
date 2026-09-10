/**
 * 行为骨架：观察用户自己在浏览器里做的事，只为"这件事他常做"提供证据。
 *
 * 三条纪律（对应 devlog 的边界）：
 *   1. 只记骨架：站点 + 语义锚点序列 + 时间 + 次数。**不记输入值**，不记页面文字。
 *   2. 敏感站点不采（银行/支付/邮箱/密码管理器/本地后台），密码与验证码永不采。
 *   3. 阈值是可调旋钮：默认同一串动作做过 ≥3 次、跨 ≥2 天，才值得问用户。
 *
 * 本文件不碰 chrome API 与 DOM，便于单测。
 */
import { sameAnchor, type DemoAnchor } from "./demo-record.js";

/** 一串动作＝一个"run"：同一站点、短时间内连续做的几下。 */
export interface ObservedRun {
  hostname: string;
  /** 归一化后的锚点序列（只有标签/role/名字） */
  anchors: DemoAnchor[];
  at: number;
}

/** 同一个签名的累积证据：做过几次、第一次和最近一次什么时候、最近一次的步骤长什么样。 */
export interface ObservedPattern {
  hostname: string;
  signature: string;
  anchors: DemoAnchor[];
  count: number;
  firstSeen: number;
  lastSeen: number;
  /** 用户已经忽略过的签名，不再重复打扰 */
  dismissed?: boolean;
}

export const MIN_RUNS = 3;
export const MIN_SPAN_MS = 2 * 24 * 60 * 60 * 1000;
export const MIN_STEPS = 2;
export const MAX_PATTERNS_PER_HOST = 30;
export const MAX_HOSTS = 20;

/**
 * 敏感站点：银行、支付、邮箱、密码管理器、认证与后台。
 * 逐个标签判断（bankofchina 这种前缀也算），宁可漏掉一个，也不要在这些地方留痕。
 */
const SENSITIVE_LABELS = new Set([
  "bank", "banking", "pay", "payment", "wallet", "mail", "webmail", "pass", "password",
  "vault", "auth", "sso", "login", "account", "admin",
  "gmail", "outlook", "hotmail", "icloud", "zoho", "proton", "fastmail", "yahoo",
  "alipay", "wechatpay", "tenpay", "1password", "lastpass", "bitwarden", "okta",
]);
const SENSITIVE_LABEL_PART = /bank|pay|mail|pass|vault|auth|sso/;

export function isSensitiveHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".local")) return true;
  return host.split(".").some(label => label && (SENSITIVE_LABELS.has(label) || SENSITIVE_LABEL_PART.test(label)));
}

/** 骨架签名：只由"点了什么"决定，和顺序有关；没名字的点不参与（认不出来，留着是噪声）。 */
export function signatureOf(anchors: DemoAnchor[]): string {
  const named = anchors.filter(a => a.name || a.role);
  return named.map(a => [a.tag, a.role, a.name].filter(Boolean).join("|")).join(">");
}

/** 这一步序列值不值得观察：太短的不是任务。 */
export function worthObserving(run: ObservedRun): boolean {
  if (isSensitiveHost(run.hostname)) return false;
  if (run.anchors.length < MIN_STEPS) return false;
  return signatureOf(run.anchors) !== "";
}

export function mergeRun(patterns: ObservedPattern[], run: ObservedRun, now = run.at): ObservedPattern[] {
  if (!worthObserving(run)) return patterns;
  const hostname = run.hostname.trim().toLowerCase();
  const signature = signatureOf(run.anchors);
  const next = patterns.filter(p => !(p.hostname === hostname && p.signature === signature));
  const previous = patterns.find(p => p.hostname === hostname && p.signature === signature);
  next.push({
    hostname,
    signature,
    anchors: run.anchors.filter(a => a.name || a.role),
    count: (previous?.count ?? 0) + 1,
    firstSeen: previous?.firstSeen ?? now,
    lastSeen: now,
    ...(previous?.dismissed ? { dismissed: true as const } : {}),
  });
  return trimPatterns(next);
}

/** 有界：每个站点留最近常用的若干条，站点数也有上限；观察不能变成新的配额事故。 */
export function trimPatterns(patterns: ObservedPattern[]): ObservedPattern[] {
  const byHost = new Map<string, ObservedPattern[]>();
  for (const pattern of patterns) {
    const list = byHost.get(pattern.hostname) ?? [];
    list.push(pattern);
    byHost.set(pattern.hostname, list);
  }
  const hosts = [...byHost.entries()]
    .map(([hostname, list]) => ({ hostname, list: list.sort((a, b) => b.lastSeen - a.lastSeen).slice(0, MAX_PATTERNS_PER_HOST) }))
    .sort((a, b) => (b.list[0]?.lastSeen ?? 0) - (a.list[0]?.lastSeen ?? 0))
    .slice(0, MAX_HOSTS);
  return hosts.flatMap(h => h.list);
}

/**
 * 够不够格问用户：做过 ≥MIN_RUNS 次，且跨够 MIN_SPAN_MS 天，且用户没忽略过。
 * 三条都满足才打扰——主动打扰是这个产品最贵的东西。
 */
export function shouldPropose(pattern: ObservedPattern): boolean {
  if (pattern.dismissed) return false;
  if (pattern.count < MIN_RUNS) return false;
  if (pattern.lastSeen - pattern.firstSeen < MIN_SPAN_MS) return false;
  return pattern.anchors.length >= MIN_STEPS;
}

export function candidates(patterns: ObservedPattern[]): ObservedPattern[] {
  return patterns.filter(shouldPropose).sort((a, b) => b.count - a.count);
}

/** 面板要讲人话：不解释、不美化，只说事实。 */
export function describePattern(pattern: ObservedPattern, describe: (anchor: DemoAnchor) => string): string {
  const days = Math.max(1, Math.round((pattern.lastSeen - pattern.firstSeen) / (24 * 60 * 60 * 1000)));
  return `你在 ${pattern.hostname} 这样做了 ${pattern.count} 次（跨 ${days} 天）：` +
    pattern.anchors.map(describe).join(" → ");
}

/** 由骨架里出现过的对象拼一句默认意图，用户可以改。 */
export function defaultIntent(pattern: ObservedPattern, describe: (anchor: DemoAnchor) => string): string {
  const head = pattern.anchors.slice(0, 3).map(describe).join("，");
  return `${pattern.hostname}：${head}`;
}

/** 骨架里是否有密码之类：有就整条丢掉（哪怕已经脱敏，也不留着）。 */
export function hasSensitiveAnchor(anchors: DemoAnchor[]): boolean {
  return anchors.some(a => a.inputType === "password");
}

export { sameAnchor };
