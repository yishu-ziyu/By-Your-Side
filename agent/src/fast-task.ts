import type { Skill, SkillRun } from '../../shared/skill.js';

/**
 * 已保存做法作为快捷任务候选时的输入形状（skill-fast-loop 产出）。
 * 原先由 Jev 在切换标签页、译文显示和已保存做法之间整句判断（decideFastTask），
 * 已随本机模式退役；已保存做法仍由 skill-fast-loop 的精确/模板匹配直接执行。
 */
export interface FastTaskSkillOption {
  skill: Skill;
  runs: SkillRun[];
  selected: boolean;
  suppliedInputs?: Record<string, string>;
  allowStale?: boolean;
}
