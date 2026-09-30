/**
 * 学习资格的语义判断：这条要求能不能被"这份做法本身"完整交付？
 *
 * 编译出来的做法只会执行保存下来的那几步，并交付它核对过的结果。用户可能在同一句里
 * 还要别的交付（"并告诉我会员等级"、"列出结果"、"翻译说明"、"导出"），或者带条件/附加筛选。
 * 这些要求不在做法里，复用只会回一句通用完成回执——所以不能生成可自动复用的候选。
 *
 * 原先由 TypeSafe/Jev 判断（不是关键词黑名单）；Jev 已随本机模式退役，现在没有默认判断：
 * 判不出来、超时或服务不可用时一律当作没覆盖（回退到不自动启用），绝不当作通过。
 */
import { skillWorkflowActions, type Skill } from "../../shared/skill.js";

export interface DeliverableContractInput {
  /** 用户这次的要求；材料已用 {{槽位}} 占位，判断不依赖具体值。 */
  request: string;
  /** 这份做法实际会做的动作（人话，逐条），来自编译后的步骤。 */
  actions: string[];
}

export type DeliverableContractJudge = (input: DeliverableContractInput, signal?: AbortSignal) => Promise<number>;

/**
 * 判断输入：要求用 {{槽位}} 形式（不含本次材料），动作取自编译后的步骤，
 * 并带上做法跑完后的核对——那也是这份做法会做的事。
 */
export function deliverableContractInput(skill: Skill): DeliverableContractInput {
  return { request: skill.requestTemplate ?? skill.intent, actions: [...skillWorkflowActions(skill), skill.check.text] };
}

/**
 * 学习门限独立于自动执行路由。问法必须描述真实的通用完成回执，
 * 不能假设执行器会向用户呈现读到的页面内容。校准记录见集成验收。
 */
export const DELIVERABLE_MIN = .80;

/** 没有注入判断时的默认：判断不可用，学习资格按「不可用」处理，不生成可自动复用的候选。 */
export const unavailableDeliverableJudge: DeliverableContractJudge = async () => {
  throw new Error("做法覆盖判断不可用");
};
