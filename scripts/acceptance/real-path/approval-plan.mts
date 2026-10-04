// 脚本模型验收的确认卡判定：像用户一样只批准“这一轮预先声明要做的事”。
// 模型发起的卡与当前任务的脚本步骤逐项比对，扩展补充的参数单独放行；宿主自己发起的只认读练习站页面与接管练习站标签页。
// 其余一律拒绝并算测量失败，不为单张卡就地补丁。
import { isDeepStrictEqual } from "node:util";
import type { JsonRecord as Rec } from "./harness.mts";
import type { Step } from "./scripted-model.mts";

/** 扩展在模型参数之外补充的键；值不来自模型，不参与和脚本步骤的比对。 */
const HOST_ADDED = new Set(["tabId", "formRequirements", "userValueProvided", "userValueHostname"]);

export type CardInput = {
  cardId: string;
  selected: string;
  details: string;
  now: number;
  /** 原生 consent_request.request。 */
  request: Rec | undefined;
  /** 原生协议历史，已展开为 { seq, conversationId, item }。 */
  history: Rec[];
  conversations: Rec[] | undefined;
  /** 最近一次发给脚本模型的完整请求文本。 */
  lastModelRequest: string | undefined;
};

export type ApprovalPlan = {
  /** 当前这一轮由验收输入的用户原话。 */
  task: string;
  /** 本场景里验收输入过的全部原话；用来认出属于验收的 run。 */
  enteredTasks: ReadonlySet<string>;
  /** 当前任务的脚本步骤。 */
  steps: readonly Step[];
  fixtureTabs: readonly number[];
  /** 当前任务批处理步骤内声明的动作。 */
  nested?: readonly NestedGroup[];
  /** 可选：扩展附带的字段规则必须等于此值（替换场景用来确认生效的是当前规则）。 */
  formRequirements?: Rec["formRequirements"];
};

export type Decision = { allow: boolean; fail: boolean; kind: string; reason: string };

/** 批处理步骤（browser_run）内部会各自弹卡的动作：网页操作写工具名与模型参数，网络请求写方法、地址与正文。 */
export type NestedCard = { tool: string; args: Rec } | { fetch: { method: "GET" | "POST"; url: string; body?: string } };

export type NestedGroup = { parent: { name: string; args: Rec }; cards: readonly NestedCard[] };

// SAFETY: history entries are native protocol records; every field read from the result is checked before use.
const eventOf = (x: Rec) => ((x.item as Rec | undefined)?.msg as Rec | undefined)?.event as Rec | undefined;

const keysWithin = (o: Rec, allowed: string[]) => Object.keys(o).every(k => allowed.includes(k));

export function decideCard(card: CardInput, plan: ApprovalPlan): Decision {
  const r = card.request;
  const reject = (kind: string, reason: string, fail = true): Decision => ({ allow: false, fail, kind, reason });

  if (!r || r.id !== card.cardId) return reject("unbound", "卡片与原生请求对不上");

  // 三类卡：网页操作（write+activation）、发送网络请求（fetch，kind 可省略）、核对后重设（write 无 purpose，本规则不覆盖）。
  const isFetch = r.kind === undefined || r.kind === "fetch";

  if (!isFetch && r.purpose !== "activation") return reject("undeclared", "核对后重设类确认卡不在本规则范围");

  if (r.conversationId !== card.selected) return reject("unbound", "不是当前选中会话的卡");

  if (Number(r.expiresAt) <= card.now) return reject("unbound", "卡片已过期");

  // SAFETY: receipt fields are compared by value below; a malformed receipt simply fails to match.
  const receipt = card.history.map(x => ({ seq: Number(x.seq), conversationId: x.conversationId, receipt: eventOf(x)?.receipt as Rec | undefined }))
    .findLast(x => x.conversationId === r.conversationId && x.receipt?.runId === r.runId
      && plan.enteredTasks.has(String(x.receipt?.text)) && x.receipt?.status === "accepted");

  if (!receipt) return reject("unbound", "run 不属于验收输入的任务");

  const currentRun = card.conversations?.some(c => c.id === r.conversationId && c.runId === r.runId) === true;

  /** 这一轮模型确实调用了这个工具（原生 tool_start 在本任务回执之后），且最近一次模型请求属于本任务与 run。 */
  const modelCalled = (name: string, args: Rec): Decision | null => {
    const native = card.history.some(x => {
      const e = eventOf(x);

      return x.conversationId === r.conversationId && Number(x.seq) > receipt.seq
        && e?.kind === "tool_start" && e.name === name && isDeepStrictEqual(e.params, args);
    });

    if (!native) return reject("undeclared", "原生历史里没有对应的模型工具调用");

    const fromModel = !!card.lastModelRequest?.includes(plan.task) && card.lastModelRequest.includes(`"runId":"${String(r.runId)}"`);

    return fromModel ? null : reject("undeclared", "最近一次模型请求不是这个任务和 run");
  };

  /** 批处理步骤内部动作：须在声明里，且所属批处理步骤确实由模型调用。 */
  const nestedCard = (matches: (c: NestedCard) => boolean, label: string): Decision => {
    const group = plan.nested?.find(g => g.cards.some(matches));

    if (!group) return reject("undeclared", `当前任务的脚本步骤里没有这张卡：${label}`);

    return modelCalled(group.parent.name, group.parent.args) ?? { allow: true, fail: false, kind: "model-nested", reason: `批处理步骤内声明的动作：${label}` };
  };

  if (isFetch) {
    if (!currentRun) return reject("stale", "旧 run 的请求卡");

    if (receipt.receipt?.text !== plan.task) return reject("undeclared", "卡片所在 run 不是当前任务");

    return nestedCard(c => "fetch" in c && c.fetch.method === r.method && c.fetch.url === r.url && c.fetch.body === r.body, `${String(r.method)} ${String(r.url)}`);
  }

  let params: Rec;

  try {
    // SAFETY: request.value is the extension's JSON parameter text; a parse failure rejects the card.
    params = JSON.parse(String(r.value)) as Rec;
  } catch { return reject("unbound", "参数不是完整 JSON"); }

  if (!card.details.includes(String(r.value))) return reject("unbound", "侧栏展示的参数与原生请求不同");

  const onFixture = plan.fixtureTabs.some(t => t === params.tabId);

  if (r.tool === "snapshot" && keysWithin(params, ["tabId", "decision"]) && onFixture) {
    // 只读练习站，不论属于当前任务还是上一任务收尾的核对都放行；已不是会话当前 run 的迟到卡拒绝但不算失败。
    return currentRun ? { allow: true, fail: false, kind: "host-read", reason: "读练习站页面" } : reject("stale-read", "旧 run 的读页卡", false);
  }

  if (!currentRun) return reject("stale", "旧 run 的操作卡");

  if (r.tool === "worker_tabs" && params.action === "claim" && keysWithin(params, ["action", "tabId", "expectedConversationId"]) && onFixture) {
    return { allow: true, fail: false, kind: "host-claim", reason: "接管练习站标签页" };
  }

  if (receipt.receipt?.text !== plan.task) return reject("undeclared", "卡片所在 run 不是当前任务");

  if ("tabId" in params && !onFixture) return reject("undeclared", "目标不是练习站标签页");

  if (plan.formRequirements !== undefined && "formRequirements" in params && !isDeepStrictEqual(params.formRequirements, plan.formRequirements)) {
    return reject("undeclared", "扩展附带的字段规则不是当前规则");
  }

  const modelArgs = Object.fromEntries(Object.entries(params).filter(([k]) => !HOST_ADDED.has(k)));
  const step = plan.steps.find(s => "tool" in s && s.tool.name === r.tool && isDeepStrictEqual(s.tool.args, modelArgs));

  if (!step || !("tool" in step)) return nestedCard(c => "tool" in c && c.tool === r.tool && isDeepStrictEqual(c.args, modelArgs), String(r.tool));

  return modelCalled(step.tool.name, step.tool.args) ?? { allow: true, fail: false, kind: "model-step", reason: "与脚本步骤一致" };
}
