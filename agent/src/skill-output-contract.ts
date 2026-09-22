/**
 * 学习资格的语义判断：这条要求能不能被"这份做法本身"完整交付？
 *
 * 编译出来的做法只会执行保存下来的那几步，并交付它核对过的结果。用户可能在同一句里
 * 还要别的交付（"并告诉我会员等级"、"列出结果"、"翻译说明"、"导出"），或者带条件/附加筛选。
 * 这些要求不在做法里，复用只会回一句通用完成回执——所以不能生成可自动复用的候选。
 *
 * 按 TypeSafe 判断（不是关键词黑名单）：只判"这条要求是否被这些动作 + 其核对结果完整覆盖"。
 * 判不出来、超时或服务不可用时一律当作没覆盖（回退到不自动启用），绝不当作通过。
 */
import { readTypeSafeKey } from "./typesafe-auth.js";
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

const CALL_TIMEOUT_MS = 2000;

export async function judgeDeliverableContract(input: DeliverableContractInput, signal?: AbortSignal): Promise<number> {
  const key = readTypeSafeKey();

  if (!key) throw new Error("TypeSafe 凭据不可用");
  const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);

  const response = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    body: JSON.stringify({
      model: "jev-1.13.0",
      state: { request: input.request, workflowActions: input.actions,
        userVisibleReply: "已完成，结果已核对。", reportsPageContents: false },
      questions: {
        workflow_only: {
          type: "noul",
          instructions: "Would performing exactly `workflowActions` and showing ONLY `userVisibleReply` fully satisfy `request`? The reply is a generic completion acknowledgment. It NEVER reports page contents, search results, field values, lists, translations, or summaries, even if the workflow reads them privately to verify execution. A request to search and CHECK/VERIFY the result can be satisfied by doing the check and acknowledging completion. A request to TELL/SHOW/REPORT the result or any information from the page cannot: the generic acknowledgment does not deliver that information. Also reject extra operations, filters, scope changes or conditions not performed by workflowActions.",
          criteria: {
            true: "Only the listed actions and their private verification are requested; a generic completion acknowledgment is enough",
            false: "User needs page/result information in the reply, or an additional action/filter/scope/condition; a generic acknowledgment is insufficient",
          },
        },
      },
    }),
  });

  if (!response.ok) throw new Error(`TypeSafe HTTP ${response.status}`);
  const raw = await response.json() as { answers?: Record<string, { noul?: number }> };
  const value = raw.answers?.workflow_only?.noul;

  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error("TypeSafe 未返回可用的判断");

  return value;
}
