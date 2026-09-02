/**
 * target 定位串解析（与 ego 对齐，三种字符串形式）：
 *   "@N"          — snapshot 输出中的 ref
 *   "loc=css:..." — snapshot 给出的稳定定位串（去掉前缀即 CSS）
 *   其他非空字符串 — 原始 CSS 选择器
 * 非法输入返回 null。
 */
export type ParsedTarget =
  | { kind: "ref"; n: number }
  | { kind: "css"; sel: string }
  | { kind: "loc"; sel: string };

const LOC_PREFIX = "loc=css:";

export function parseTarget(raw: unknown): ParsedTarget | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;

  if (s.startsWith("@")) {
    const rest = s.slice(1);
    if (!/^\d+$/.test(rest)) return null;
    const n = Number(rest);
    if (!Number.isSafeInteger(n) || n < 1) return null;
    return { kind: "ref", n };
  }

  if (s.startsWith(LOC_PREFIX)) {
    const sel = s.slice(LOC_PREFIX.length).trim();
    return sel ? { kind: "loc", sel } : null;
  }

  return { kind: "css", sel: s };
}
