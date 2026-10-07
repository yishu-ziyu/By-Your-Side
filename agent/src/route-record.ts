import { ROUTE_STEPS_MAX, ROUTE_TEXT_ROLES, type RouteStep, type RouteTarget, type TaskRoute } from "../../shared/route.js";
import { resultHasWriteEffect, type TaskResultItem } from "../../shared/task-results.js";

/**
 * 记做法（走老路，YIS-94）：每个动手的步骤在执行成功后记一笔；任务结束时「代码裁判」全过才把这份做法存进过往任务。
 * 规则见 docs/evals/20261007-route-record.md。
 */

/** 密码、验证码、卡号、证件号一类：值不进做法，只记「这里要填」。 */
const SECRET = /密码|口令|验证码|校验码|动态码|安全码|卡号|身份证|证件号|护照号|password|passcode|passwd|one[- ]?time|otp|\bpin\b|cvv|cvc|security code|verification code|card number|credit card/i;

/** 一步动手，由 tools.ts 在执行成功后从工具参数里取出。 */
export interface RouteNote {
  action: RouteStep["action"];
  /** 动手前读到的控件描述；没有 @N 目标、或读不出来时为 null。 */
  target: RouteTarget | null;
  label?: string;
  /** 填的值或选中的项。 */
  value?: string;
  url?: string;
  key?: string;
  /** 填的值来自本轮带上的记忆。 */
  memory: boolean;
  /** 模型写的定位（@N 或选择器），只进诊断记录。 */
  at?: string;
}

/** 一次任务里记下的步骤；broken 写明为什么这份做法不能存。 */
export interface RouteDraft {
  steps: RouteStep[];
  broken?: string;
  /** 用选择器（不是 @N）定位的步数，只进诊断记录（YIS-103）。 */
  bySelector?: number;
}

/** 把一步动手记进草稿。 */
export function noteRouteStep(draft: RouteDraft, note: RouteNote): RouteDraft {
  if (draft.broken) return draft;

  if (note.action === "navigate") return note.url ? { steps: [...draft.steps, { action: "navigate", url: note.url.slice(0, 2_000) }] } : { ...draft, broken: "打开网址这一步没有网址" };

  if (note.action === "press_key") return note.key ? { steps: [...draft.steps, { action: "press_key", key: note.key.slice(0, 40) }] } : { ...draft, broken: "按键这一步没有键名" };

  if (!note.target) return { ...draft, broken: `有一步认不出点的是哪个控件（${note.action} ${note.at?.slice(0, 80) ?? "没有定位"}）` };
  const step: RouteStep = { action: note.action, target: note.target };

  if (note.label) step.label = note.label.slice(0, 120);

  if (note.value !== undefined) {
    if (SECRET.test(`${note.target.name} ${note.label ?? ""}`)) step.secret = true;
    else {
      step.value = note.value.slice(0, 2_000);

      if (note.memory) step.valueFrom = "memory";
    }
  }

  const steps = [...draft.steps, step];
  const bySelector = (draft.bySelector ?? 0) + (note.at && !note.at.startsWith("@") ? 1 : 0);

  return steps.length > ROUTE_STEPS_MAX ? { steps: draft.steps, broken: `超过 ${ROUTE_STEPS_MAX} 步` } : bySelector ? { steps, bySelector } : { steps };
}

export interface RouteVerdictInput {
  outcome: "complete" | "partial" | "stopped" | "error";
  /** 目标之后用户又补充或改了方向。 */
  revised: boolean;
  results: readonly Pick<TaskResultItem, "tool" | "evidence" | "status">[];
  draft: RouteDraft | undefined;
  /** 用户这次说的话（目标与补充），用来认出哪些值是这次说的。 */
  said: string;
}

/** 代码裁判：全部通过才存做法；不过时写明原因（给诊断记录，不给用户）。 */
export function judgeRoute(input: RouteVerdictInput): { route: TaskRoute } | { rejected: string } {
  if (input.outcome !== "complete") return { rejected: `任务没有做完（${input.outcome}）` };

  if (input.revised) return { rejected: "中途改过方向" };

  if (!input.draft?.steps.length) return { rejected: "没有记下步骤" };

  if (input.draft.broken) return { rejected: input.draft.broken };

  if (input.results.some((item) => resultHasWriteEffect(item) && item.status !== "satisfied")) return { rejected: "有改页面的步骤失败或结果未知" };

  if (!input.draft.steps.some((step) => step.action !== "navigate")) return { rejected: "只有打开网址，没有动手" };

  const said = input.said.replace(/\s+/g, "");

  const same = (a: RouteStep, b: RouteStep) => a.action === b.action && JSON.stringify(a.target) === JSON.stringify(b.target);
  // 同一张卡片点了两次（模型自己重试时常见）：选卡片重复点没有新作用，只留第一次；照走时第二次会被当成重复操作拦下（10-07 实测）。
  const unique = input.draft.steps.filter((step, i, all) => !(step.action === "click" && step.target?.box && all.slice(0, i).some(prev => same(prev, step))));

  const steps = unique.map((raw): RouteStep => {
    // 在几张同样的卡片里点了一张：卡片名就是这一步选的值，下次照走时可以换成别的卡片（YIS-95）。
    // 按文字点了用户这次说的那一项（卡片标题「青松」）：文字就是选的值，下次换成那次说的那一项（YIS-103）。
    const step = raw.action === "click" && raw.target?.box ? { ...raw, value: raw.target.box }
      : raw.action === "click" && raw.target && ROUTE_TEXT_ROLES.has(raw.target.role) && said.includes(raw.target.name.replace(/\s+/g, "")) ? { ...raw, value: raw.target.name } : raw;

    return step.value === undefined || step.valueFrom ? step : { ...step, valueFrom: step.value.trim() && said.includes(step.value.replace(/\s+/g, "")) ? "said" : "fixed" };
  });

  return { route: { steps, recordedAt: Date.now() } };
}
