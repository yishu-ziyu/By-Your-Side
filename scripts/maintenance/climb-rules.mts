/**
 * climb 的判定规则（纯函数，可拿存下来的回放离线重判）：登记文件检查、精确符号检验、配对、三态判定。
 * 规则的来由和取舍见 docs/development/hill-climbing.md。
 */
import { type Row, ok } from "./replay-row.mts";

export const METRICS = ["totalSecs", "secs", "checkSecs", "calls", "ok"] as const;
export type Metric = (typeof METRICS)[number];
export type Target = { metric: Metric; delta?: number; deltaRel?: number } | { case: string; runs?: number; args?: string[] };
export type Guard = { metric: Metric; rel?: number; abs?: number };
export type Registration = { name: string; base: string; cand: string; scenarios: number[]; N: number; alpha: number; budgetMin: number; seed: number; pool?: string; model?: string; target: Target; guards: Guard[]; redLines: string[] };
export type Arm = "base" | "cand";
export type Pass = { arm: Arm; pair: number; report: string; model: string; fastModel: string; rows: Row[] };
export type Verdict = "通过" | "否决" | "证据不足";

/** 登记文件是手写的外部输入：形状、指标名、界线都核一遍，不对就不跑。 */
export function registrationOf(value: unknown): Registration {
  if (!value || typeof value !== "object") throw new Error("登记文件应当是对象");
  const r = value as Record<string, unknown>;
  const need = (ok: boolean, what: string) => { if (!ok) throw new Error(`登记文件：${what}`); };
  const metric = (m: unknown) => METRICS.includes(m as Metric);

  need(typeof r.name === "string" && /^[\w.-]+$/.test(r.name), "name 只能用字母数字和 .-_");
  need(typeof r.base === "string" && typeof r.cand === "string", "要有 base 和 cand 两份构建目录");
  need(Array.isArray(r.scenarios) && r.scenarios.every(n => typeof n === "number"), "scenarios 是任务池里的 n");
  need(Number.isInteger(r.N) && (r.N as number) >= 1, "N 是正整数");
  need(typeof r.alpha === "number" && r.alpha > 0 && r.alpha < 0.5, "alpha 在 0 到 0.5 之间");
  need(typeof r.budgetMin === "number" && r.budgetMin > 0, "budgetMin 是分钟数");
  need(Number.isInteger(r.seed), "seed 是整数");
  const t = r.target as Record<string, unknown> | undefined;
  need(!!t && typeof t === "object" && (typeof t.case === "string" || metric(t.metric)), "target 要么是 { case }，要么是 { metric }");
  if (t && "metric" in t && t.metric !== "ok") need(typeof t.delta === "number" || typeof t.deltaRel === "number", "连续目标要登记 delta 或 deltaRel（最小有意义改进）");
  need(Array.isArray(r.guards) && r.guards.every(g => g && typeof g === "object" && metric((g as Guard).metric) && ((g as Guard).metric === "ok" || typeof (g as Guard).rel === "number" || typeof (g as Guard).abs === "number")), "每个守护要有 metric，连续守护要有 rel 或 abs");
  need(Array.isArray(r.redLines) && r.redLines.every(c => typeof c === "string"), "redLines 是验收用例名");
  need(r.scenarios.length > 0 || (!!t && typeof t.case === "string"), "没有场景时目标必须是验收用例");

  // SAFETY: 上面逐项核过形状。
  return r as unknown as Registration;
}

/** 单侧精确符号检验：差值严格大于 0 的对数至少这么多的概率（0 和负数都不算支持）。 */
export function signP(diffs: number[]): number {
  const n = diffs.length;
  const k = diffs.filter(d => d > 0).length;
  let p = 0;
  for (let r = k; r <= n; r++) p += choose(n, r);
  return p / 2 ** n;
}

function choose(n: number, r: number): number {
  let c = 1;
  for (let i = 1; i <= r; i++) c = c * (n - r + i) / i;
  return c;
}

/** 可复现的先后顺序。 */
export function shuffled(seed: number, pairs: number): Arm[][] {
  let s = seed >>> 0;
  const next = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return Array.from({ length: pairs }, () => (next() < 0.5 ? ["base", "cand"] : ["cand", "base"]));
}

type PairValue = { n: number; pair: number; base: number; cand: number };

/** 一遍回放里某个场景的指标：各句之和；ok 是各句都做成，而且这个场景该有的句子都跑到了（前一句没做完会提前停）。 */
function metricOf(pass: Pass, n: number, metric: Metric, sentences: number): number | null {
  const rows = pass.rows.filter(r => r.n === n);
  if (!rows.length) return null;
  if (metric === "ok") return rows.length === sentences && rows.every(ok) ? 1 : 0;
  if (rows.length !== sentences) return null;
  return rows.reduce((sum, r) => sum + r[metric], 0);
}

export function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * 场景配对的判定。sentences 是任务池里每个场景的句数。机制目标（case）在外面跑完，结果从 caseTargetPass 传进来。
 * 顺序：显著变坏 → 否决；配对不全、模型不一致 → 证据不足；目标没证明变好或任一守护没证明没变差 → 证据不足；都过 → 通过。
 */
export function judge(reg: Registration, passes: Pass[], sentences: Map<number, number>, caseTargetPass: boolean | null): { verdict: Verdict; reasons: string[]; lines: string[] } {
  const reasons: string[] = [];
  const lines: string[] = [];
  const pairsFor = (metric: Metric): PairValue[] => {
    const values: PairValue[] = [];
    for (let pair = 0; pair < reg.N; pair++) {
      const base = passes.find(p => p.pair === pair && p.arm === "base");
      const cand = passes.find(p => p.pair === pair && p.arm === "cand");
      if (!base || !cand) continue;
      for (const n of reg.scenarios) {
        const b = metricOf(base, n, metric, sentences.get(n) ?? 1);
        const c = metricOf(cand, n, metric, sentences.get(n) ?? 1);
        // 连续指标要两边都把场景跑完才比；没跑完的那边由「做成」记失败。
        if (b === null || c === null) continue;
        values.push({ n, pair, base: b, cand: c });
      }
    }
    return values;
  };

  const models = new Set(passes.map(p => `${p.model}｜${p.fastModel}`));
  if (models.size > 1) reasons.push(`两边模型配置不一样：${[...models].join(" / ")}`);
  const complete = pairsFor("ok");
  const expected = reg.N * reg.scenarios.length;
  if (complete.length < expected) reasons.push(`配对不全：${complete.length}/${expected}`);

  // 「做成」：新增失败（改前做成、改后没做成）和修好（反过来）分开数，不拿总数相抵。
  const broke = complete.filter(v => v.base === 1 && v.cand === 0);
  const fixed = complete.filter(v => v.base === 0 && v.cand === 1);
  const harmP = broke.length ? signP([...broke.map(() => 1), ...fixed.map(() => -1)]) : 1;
  lines.push(`做成：配对 ${complete.length}，新增失败 ${broke.length}（${broke.map(v => `场景${v.n}第${v.pair + 1}对`).join("、") || "无"}），修好 ${fixed.length}；没见到新增失败时，新增失败概率的单侧 95% 上界 ${(100 * (1 - 0.05 ** (1 / Math.max(1, complete.length)))).toFixed(1)}%`);
  const harmful = broke.length > 0 && harmP <= reg.alpha;
  if (harmful) reasons.push(`改后做成显著变少（新增失败 ${broke.length}、修好 ${fixed.length}，p=${harmP.toFixed(3)}）`);

  const guardsPass = reg.guards.map(guard => {
    if (guard.metric === "ok") {
      if (broke.length) reasons.push(`守护「做成」：有 ${broke.length} 次新增失败`);
      return broke.length === 0;
    }
    const values = pairsFor(guard.metric);
    const allowed = (v: PairValue) => Math.max((guard.rel ?? 0) * v.base, guard.abs ?? 0);
    const p = values.length ? signP(values.map(v => allowed(v) - (v.cand - v.base))) : 1;
    const worse = values.filter(v => v.cand - v.base >= allowed(v)).length;
    lines.push(`守护 ${guard.metric}（每对允许变差 ${[guard.rel ? `${guard.rel * 100}%` : "", guard.abs ? String(guard.abs) : ""].filter(Boolean).join(" 或 ")}，取大）：${values.length} 对里 ${worse} 对越界，p=${p.toFixed(3)}；改前/改后中位 ${median(values.map(v => v.base))} / ${median(values.map(v => v.cand))}`);
    if (p > reg.alpha) reasons.push(`守护 ${guard.metric} 没能证明没变差（p=${p.toFixed(3)}）`);
    return p <= reg.alpha;
  });

  let targetPass = caseTargetPass ?? false;
  const target = reg.target;
  if (!("case" in target)) {
    if (target.metric === "ok") {
      const p = signP([...fixed.map(() => 1), ...broke.map(() => -1)]);
      targetPass = fixed.length > 0 && p <= reg.alpha;
      lines.push(`目标 做成：修好 ${fixed.length}、新增失败 ${broke.length}，p=${fixed.length ? p.toFixed(3) : "—"}`);
    } else {
      const values = pairsFor(target.metric);
      const need = (v: PairValue) => target.delta ?? (target.deltaRel ?? 0) * v.base;
      const p = values.length ? signP(values.map(v => v.base - v.cand - need(v))) : 1;
      targetPass = values.length > 0 && p <= reg.alpha;
      lines.push(`目标 ${target.metric}（每对至少好 ${target.delta ?? `${(target.deltaRel ?? 0) * 100}%`}）：${values.filter(v => v.base - v.cand > need(v)).length}/${values.length} 对达到，p=${p.toFixed(3)}；改前/改后中位 ${median(values.map(v => v.base))} / ${median(values.map(v => v.cand))}`);
    }
  }
  if (!targetPass) reasons.push("目标没有证明变好");

  const verdict: Verdict = harmful ? "否决" : targetPass && guardsPass.every(Boolean) && !reasons.length ? "通过" : "证据不足";
  return { verdict, reasons, lines };
}
