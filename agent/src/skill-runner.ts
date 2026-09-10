/**
 * 按技能跑一遍：**不叫模型**。
 *
 * 复用与 browser_run 完全相同的执行器（同一个 QuickJS 沙箱、同一条 ToolRpc、同一套扩展侧闸门），
 * 只是程序不是模型写的，而是当初从示范编译出来的那一份。
 *
 * 三条纪律：
 *   - 页面不像当初就停：解析不到目标时脚本自己抛错，这里如实记下停在第几步；
 *   - 用户接管 / 中止 / 确认闸门照旧生效（它们在扩展侧，绕不过去）；
 *   - 把这次的耗时与结果写进运行记录——技能要不要改、还敢不敢自己跑，全靠这些证据。
 */
import { runBrowserProgram } from "./browser-program.js";
import type { ToolRpc } from "./rpc.js";
import type { Skill, SkillRun } from "../../shared/skill.js";

export interface SkillRunOutcome extends SkillRun {
  /** 程序返回值里带回来的证据（run 记录不存它，太长） */
  value?: unknown;
}

/** 从脚本自己抛的错误里认出"停在第几步"。 */
export function stepFromError(message: string): number | undefined {
  const match = /第\s*(\d+)\s*步/.exec(message);
  if (!match) return undefined;
  const step = Number(match[1]);
  return Number.isInteger(step) && step > 0 ? step : undefined;
}

export async function runSkill(options: {
  skill: Skill;
  rpc: ToolRpc;
  signal?: AbortSignal;
  onStep?: Parameters<typeof runBrowserProgram>[0]["onStep"];
  now?: () => number;
}): Promise<SkillRunOutcome> {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const programId = `skill-${options.skill.id}-${startedAt}`;
  let done = 0;
  const onStep: Parameters<typeof runBrowserProgram>[0]["onStep"] = step => {
    if (step.phase === "end") done += 1;
    options.onStep?.(step);
  };
  try {
    const result = await runBrowserProgram({
      code: options.skill.program,
      call: (name, params, stepId) => options.rpc.call(name, params, undefined, undefined, programId, undefined, stepId),
      signal: options.signal,
      id: programId,
      onStep,
    });
    const skipped = (result.value as { skipped?: number[] } | undefined)?.skipped ?? [];
    return {
      at: startedAt,
      ok: true,
      elapsedMs: Math.max(0, now() - startedAt),
      steps: result.steps,
      ...(skipped.length ? { skipped } : {}),
      value: result.value,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedStep = stepFromError(message);
    return {
      at: startedAt,
      ok: false,
      elapsedMs: Math.max(0, now() - startedAt),
      steps: done,
      ...(failedStep === undefined ? {} : { failedStep }),
      error: message,
    };
  }
}
