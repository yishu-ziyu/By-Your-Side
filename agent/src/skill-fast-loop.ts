import { bindSkillInputs, normalizeSkillHost, redactSkillMaterials, skillHealth, type SkillRun } from "../../shared/skill.js";
import type { PageContext } from "../../shared/protocol.js";
import type { ToolRpc } from "./rpc.js";
import type { SkillStore } from "./skill-store.js";
import { autoSkillEligible } from "./skill-learning.js";
import { routeSkill, type SkillJudge } from "./skill-router.js";
import { judgeSkill } from "./skill-judge.js";
import { runSkill, type SkillRunOutcome } from "./skill-runner.js";

export interface SelectedSkillRun {
  id: string;
  expectedVersion: number;
  inputs?: Record<string, string>;
  allowStale?: boolean;
  onResult?(outcome: SkillRunOutcome): void;
}

export type FastSkillResult =
  | { kind: "miss"; reason: string }
  | { kind: "done"; outcome: SkillRunOutcome; skillName: string }
  | { kind: "fallback"; reason: string }
  | { kind: "stopped" };

/** 公开事件里取代真实运行代码的占位：步骤本身在技能卡片上可看，代码不进历史。 */
const SKILL_PROGRAM_PLACEHOLDER = "[内置技能程序已隐藏：按保存的步骤执行，本次材料不进公开事件]";

/** The executor is the session's REGISTERED tool, never a private browser RPC shortcut. */
export async function trySkillFastLoop(options: {
  store: SkillStore; rpc: ToolRpc; request: string; context: PageContext; signal: AbortSignal;
  current(): boolean;
  /**
   * 调用本会话已注册的工具。第二个参数是真实执行参数；第三个是可选的对外展示参数：
   * 技能程序把本次材料内联在代码里，运行代码只进执行参数，不进公开事件与历史。
   */
  execute(name: "snapshot" | "browser_run", params: Record<string, unknown>,
    display?: { params: Record<string, unknown>; materials?: string[] }): Promise<{ details?: unknown }>;
  notice(text: string): void;
  selected?: SelectedSkillRun;
  judge?: SkillJudge;
}): Promise<FastSkillResult> {
  const { store, context, signal, selected } = options;
  const stop = (): FastSkillResult => ({ kind: "stopped" });
  let selectedCompleted = false;
  let materials: string[] = [];
  const finishSelection = (outcome: SkillRunOutcome) => { selectedCompleted = true; selected?.onResult?.(outcome); };
  try {
    const hostname = normalizeSkillHost(new URL(context.url).hostname);
    let skill, inputs: Record<string, string>, expectedVersion: number;
    if (selected) {
      skill = await store.get(selected.id);
      if (!skill || skill.version !== selected.expectedVersion || skill.hostname !== hostname) throw new Error("技能或站点已变化，请重新查看后执行。");
      inputs = bindSkillInputs(skill, selected.inputs); expectedVersion = selected.expectedVersion;
    } else {
      const skills = (await store.findByHost(hostname)).filter(autoSkillEligible);
      if (!options.current()) return stop();
      if (!skills.length) return { kind: "miss", reason: "没有具备完成核验的已保存做法" };
      const runs: Record<string, SkillRun[]> = {};
      await Promise.all(skills.map(async item => { runs[item.id] = await store.listRuns(item.id); }));
      if (!options.current()) return stop();
      const route = await routeSkill({ userText: options.request, hostname, skills, runs }, { signal, judge: options.judge ?? judgeSkill });
      if (!options.current()) return stop();
      if (route.status !== "match") {
        if (route.status === "ambiguous") options.notice("有多份相似做法，这次不自动套用。");
        if (route.status === "needs_input") options.notice(`已保存的做法还需要本次的${route.missing.join("、")}，没有沿用旧材料。`);
        return { kind: "miss", reason: route.reason };
      }
      const found = skills.find(item => item.id === route.skillId)!;
      skill = await store.get(route.skillId);
      if (!skill || skill.version !== found.version || !autoSkillEligible(skill)) return { kind: "miss", reason: "做法在判断期间发生变化" };
      inputs = route.inputs; expectedVersion = found.version;
    }
    if (!options.current()) return stop();
    if (skillHealth(await store.listRuns(skill.id)).stale && !selected?.allowStale) throw new Error("这份技能可能已过期，请重新示范。");
    const observed = await options.execute("snapshot", { tabId: context.tabId });
    if (!options.current()) return stop();
    const page = observed.details as { tabId?: number; url?: string } | undefined;
    if (page?.tabId !== context.tabId || !page.url || normalizeSkillHost(new URL(page.url).hostname) !== hostname) throw new Error("当前页面与技能站点不一致，未执行。");
    const latest = await store.get(skill.id);
    if (!options.current()) return stop();
    if (!latest || latest.version !== expectedVersion) {
      if (selected) throw new Error("你选中的技能在执行前被修改或删除，未改由模型执行。");
      return { kind: "miss", reason: "技能在执行前被修改或删除" };
    }
    options.notice(`找到你保存的「${skill.name}」，按这次的材料执行。`);
    // 失败回执同样是公开的（面板与 skill_result）：只留事实，本次材料原文不出这条路径。
    materials = Object.values(inputs).filter(value => typeof value === "string" && value.length >= 2);
    const publicText = (text: string) => redactSkillMaterials(text, materials);
    const outcome = await runSkill({ skill, inputs, rpc: options.rpc, signal,
      execute: async code => {
        if (!options.current()) throw new Error("原任务已变化，技能未继续执行。");
        // 公开事件只说明"按保存的做法执行"，不携带运行代码或本次材料原文。
        const result = await options.execute("browser_run", { code, label: skill.name },
          { params: { label: skill.name, code: SKILL_PROGRAM_PLACEHOLDER }, materials });
        const details = result.details as { value: unknown; steps: number } | undefined;
        if (!details || typeof details.steps !== "number") throw new Error("技能执行未返回可靠回执。");
        return details;
      },
    });
    if (outcome.error) outcome.error = publicText(outcome.error);
    if (outcome.ok && (outcome.value as { verified?: boolean } | undefined)?.verified !== true) {
      outcome.ok = false; outcome.error = "步骤已执行，但这份旧技能没有明确的结果核验条件，不能确认完成。";
    }
    try { await store.appendRun(skill.id, outcome); }
    catch { options.notice("本次运行记录未能保存；已执行的操作不会因此重做。"); }
    if (!options.current()) {
      finishSelection({ ...outcome, ok: false, error: "原任务已取消或改变；已发生的步骤保留在记录中，没有继续执行。" });
      return stop();
    }
    finishSelection(outcome);
    if (!outcome.ok && !selected) return { kind: "fallback", reason: outcome.error ?? "技能核验失败" };
    return { kind: "done", outcome, skillName: skill.name };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "技能路径不可用";
    const safeReason = redactSkillMaterials(reason, materials);
    if (selected) {
      const outcome = { at: Date.now(), ok: false, steps: 0, elapsedMs: 0, error: safeReason };
      finishSelection(outcome);
      return options.current() ? { kind: "done", outcome, skillName: "已保存的技能" } : stop();
    }
    return options.current() ? { kind: "fallback", reason: safeReason } : stop();
  } finally {
    if (selected && !selectedCompleted) selected.onResult?.({ at: Date.now(), ok: false, steps: 0, elapsedMs: 0, error: "技能已取消或原任务发生变化。" });
  }
}
