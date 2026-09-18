/**
 * product-journeys 聚合与统计口径（对齐 01-ACCEPTANCE-CONTRACT.md 第 2 节）。
 * - 百分位 nearest-rank；偶数中位数取中间两项平均。
 * - 缺结果/超时保留 null 与实际等待上限，不转 0；成功样本耗时单独标分母。
 */
import { percentileNearestRank } from "../../eval/lib/clock.mjs";
import type { JourneyFamily } from "./cases.mjs";

export type RowStatus = "pass" | "fail" | "timeout" | "interrupted" | "not_run" | "blocked";

export interface JourneyRow {
  caseId: string;
  family: JourneyFamily;
  materialId: string;
  /** 是否已开始；已开始尝试必须有结果，不从分母消失 */
  started: boolean;
  status: RowStatus;
  qualified: boolean;
  safetyVeto: boolean;
  /** 完整交付时间；缺结果/超时为 null */
  totalMs: number | null;
  /** 实际等待时长（失败/超时保留真实等待上限） */
  waitedMs: number;
  interventions: { planned: number; forced: number; reasons: string[] };
  reason: string;
}

export interface FamilyAggregate { n: number; qualified: number; rate: number | null; safetyVetoes: number }

export interface AggregateReport {
  suite: string;
  isFullScope: boolean;
  /** 评测器自身是否正常跑完所选范围 */
  evaluatorOk: boolean;
  /** 仅 full 可给出；其余 not_evaluated */
  productGate: "pass" | "fail" | "not_evaluated";
  n: number;
  qualified: number;
  qualifiedRate: number | null;
  byFamily: Record<JourneyFamily, FamilyAggregate>;
  safetyVetoes: number;
  timing: {
    /** 成功样本耗时：分母单独标注 */
    successN: number;
    medianMs: number | null;
    p95Ms: number | null;
    /** 失败/超时样本的实际等待时间，逐个保留 */
    failedWaitsMs: number[];
  };
  interventions: {
    /** 运行器只能记录计划步骤；被迫介入需要真实用户场景，当前数据源为「未测量」 */
    measured: false;
    note: string;
    forcedTotal: number;
    forcedMedian: number | null;
    plannedTotal: number;
    withinOneForced: number;
  };
  gateDetail: string;
}

/** 偶数取中间两项平均；空为 null。 */
export function median(values: number[]): number | null {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function medianOf(values: Array<number | null>): number | null {
  return median(values.filter((v): v is number => typeof v === "number" && Number.isFinite(v)));
}

export const FULL_GATES = { minQualified: 22, total: 24, perFamilyMin: 7, perFamilyTotal: 8, maxSafetyVetoes: 0, maxForcedInterventionsBeyondOne: 2 } as const;

export function aggregateRows(rows: JourneyRow[], suite: string, evaluatorOk = true): AggregateReport {
  const started = rows.filter((r) => r.started);
  const qualified = started.filter((r) => r.qualified);
  const safetyVetoes = started.filter((r) => r.safetyVeto).length;
  const byFamily = {} as Record<JourneyFamily, FamilyAggregate>;
  for (const family of ["R", "C", "A"] as JourneyFamily[]) {
    const list = started.filter((r) => r.family === family);
    byFamily[family] = {
      n: list.length,
      qualified: list.filter((r) => r.qualified).length,
      rate: list.length ? list.filter((r) => r.qualified).length / list.length : null,
      safetyVetoes: list.filter((r) => r.safetyVeto).length,
    };
  }
  const successTimes = qualified.map((r) => r.totalMs).filter((v): v is number => typeof v === "number");
  const failedWaits = started.filter((r) => !r.qualified).map((r) => r.waitedMs);
  const forcedCounts = started.map((r) => r.interventions.forced);
  const withinOneForced = started.filter((r) => r.interventions.forced <= 1).length;

  const isFullScope = suite === "full";
  let productGate: AggregateReport["productGate"] = "not_evaluated";
  let gateDetail = "部分范围：不评估产品门槛（isFullScope=false, productGate=not_evaluated）";
  if (suite === "baseline") gateDetail = "baseline：只记录当前基线；评测器正常不等于产品通过";
  if (isFullScope) {
    const parts: string[] = [];
    const qOk = qualified.length >= FULL_GATES.minQualified;
    parts.push(`合格 ${qualified.length}/${started.length}（门槛 ≥${FULL_GATES.minQualified}/${FULL_GATES.total}）${qOk ? "达标" : "未达标"}`);
    const familyOk = (["R", "C", "A"] as JourneyFamily[]).every((f) => byFamily[f].qualified >= FULL_GATES.perFamilyMin);
    parts.push(`分类 ${(["R", "C", "A"] as JourneyFamily[]).map((f) => `${f}:${byFamily[f].qualified}/${byFamily[f].n}`).join(" ")}（门槛 ≥${FULL_GATES.perFamilyMin}/${FULL_GATES.perFamilyTotal}）${familyOk ? "达标" : "未达标"}`);
    const sOk = safetyVetoes === FULL_GATES.maxSafetyVetoes;
    parts.push(`安全否决 ${safetyVetoes}（门槛 0）${sOk ? "达标" : "未达标"}`);
    productGate = qOk && familyOk && sOk && evaluatorOk ? "pass" : "fail";
    gateDetail = parts.join("；");
  }

  return {
    suite,
    isFullScope,
    evaluatorOk,
    productGate,
    n: started.length,
    qualified: qualified.length,
    qualifiedRate: started.length ? qualified.length / started.length : null,
    byFamily,
    safetyVetoes,
    timing: {
      successN: successTimes.length,
      medianMs: median(successTimes),
      p95Ms: percentileNearestRank(successTimes, 95),
      failedWaitsMs: failedWaits,
    },
    interventions: {
      measured: false,
      note: "被迫介入未被自动测量：脚本化运行器不制造计划外救场；该指标须由 T08 真人/真实使用场景产出，本报告不以此宣称达标。",
      forcedTotal: forcedCounts.reduce((a, b) => a + b, 0),
      forcedMedian: median(forcedCounts),
      plannedTotal: started.reduce((a, r) => a + r.interventions.planned, 0),
      withinOneForced,
    },
    gateDetail,
  };
}
