/**
 * 做法（走老路，YIS-94）：在网站上做成一件事后记下的步骤，下次同一类事照着走。
 * 控件按无障碍树的「角色 + 名字 + 所在区域」认，不存一次性编号；为什么见 docs/evals/20261007-route-record.md。
 */

/** 认控件用的描述；记下与找回用同一套算法（extension/src/background/route-target.ts）。 */
export interface RouteTarget {
  role: string;
  name: string;
  /** 往上最近的有名字的区域（表单、行、对话框…），形如 `row:青松`；没有为空。 */
  area: string;
  /** 页面上有同名控件时：只装着它一个同名控件的最小容器里，第一段不是它自己名字的文字；不重名为空。 */
  box: string;
}

/** 有名字的文字块（不是控件）：模型按文字点（text=青松 点到卡片标题）时也认得出（YIS-103）。 */
export const ROUTE_TEXT_ROLES: ReadonlySet<string> = new Set(["heading", "paragraph", "LabelText", "cell", "gridcell", "rowheader", "columnheader", "image"]);

export type RouteAction = "click" | "fill" | "select_option" | "press_key" | "navigate";

export interface RouteStep {
  action: RouteAction;
  target?: RouteTarget;
  /** 填的值或选的项；密码一类不存（secret）。 */
  value?: string;
  /** 值是用户这次说的（下次换成那次说的）、来自记忆，还是页面上固定要填的。 */
  valueFrom?: "said" | "memory" | "fixed";
  secret?: true;
  key?: string;
  url?: string;
  /** 模型给这一步起的短名（「选青松」），给人看。 */
  label?: string;
}

export interface TaskRoute {
  steps: RouteStep[];
  recordedAt: number;
}

/** 这次照着走的是哪一次（YIS-97）：那次的任务、开始时间与用时；中途对不上停下时，这次做法从第几步起（0 起）是重新想的。 */
export interface RouteSource {
  id: string;
  at: number;
  ms: number;
  freshFrom?: number;
}

/**
 * 做法的「样子」：每步做什么、点哪个控件，不含这次的值（选哪张卡片、按文字点的那一项也算值）。
 * 同一网站上样子相同的两份做法是同一类事，只留最新的（YIS-97：问过用户后一步步做完又记一份，「下次别照旧」只删掉一份）。
 */
export function routeShape(route: TaskRoute): string {
  return JSON.stringify(route.steps.map((s) => {
    const picked = s.action === "click" && s.value !== undefined;

    return [s.action, s.target?.role ?? "", picked && !s.target?.box ? "" : s.target?.name ?? "", s.target?.area ?? "", picked ? "" : s.target?.box ?? "", s.key ?? "", s.action === "navigate" ? s.url?.split(/[?#]/)[0] ?? "" : ""];
  }));
}

/**
 * 照上次的做法走（YIS-91）先关着：对照实验不到提速门槛（docs/evals/20261007-route-ab.md）。关着时不存做法、不给模型照走工具、提示里不列做法。
 * 代码留着，等「经验怎么变成更快的执行」的新调研定方向后再删或改。
 */
export const ROUTE_REPLAY_ON = false;

export const ROUTE_STEPS_MAX = 40;

const TEXT_MAX = 300;

function isShortText(value: unknown, max = TEXT_MAX): value is string | undefined {
  return value === undefined || (typeof value === "string" && value.length <= max);
}

function isRouteTarget(value: unknown): value is RouteTarget {
  if (!value || typeof value !== "object") return false;
  // SAFETY: 只当待核对的对象读字段，逐个检查类型后才返回 true。
  const t = value as RouteTarget;

  return typeof t.role === "string" && t.role.length > 0 && t.role.length <= 40 && typeof t.name === "string" && t.name.length > 0 && isShortText(t.name)
    && typeof t.area === "string" && isShortText(t.area) && typeof t.box === "string" && isShortText(t.box);
}

const ACTIONS = new Set(["click", "fill", "select_option", "press_key", "navigate"]);

const FROM = new Set(["said", "memory", "fixed"]);

function isRouteStep(value: unknown): value is RouteStep {
  if (!value || typeof value !== "object") return false;
  // SAFETY: 同上。
  const s = value as RouteStep;

  return ACTIONS.has(s.action) && (s.target === undefined || isRouteTarget(s.target)) && isShortText(s.value, 2_000) && (s.valueFrom === undefined || FROM.has(s.valueFrom))
    && (s.secret === undefined || s.secret === true) && isShortText(s.key, 40) && isShortText(s.url, 2_000) && isShortText(s.label, 120);
}

export function isTaskRoute(value: unknown): value is TaskRoute {
  if (!value || typeof value !== "object") return false;
  // SAFETY: 同上。
  const r = value as TaskRoute;

  return Number.isFinite(r.recordedAt) && Array.isArray(r.steps) && r.steps.length > 0 && r.steps.length <= ROUTE_STEPS_MAX && r.steps.every(isRouteStep);
}

export function isRouteSource(value: unknown): value is RouteSource {
  if (!value || typeof value !== "object") return false;
  // SAFETY: 同上。
  const s = value as RouteSource;

  return typeof s.id === "string" && s.id.length > 0 && s.id.length <= 200 && Number.isFinite(s.at) && Number.isFinite(s.ms) && s.ms >= 0
    && (s.freshFrom === undefined || (Number.isInteger(s.freshFrom) && s.freshFrom >= 0 && s.freshFrom <= ROUTE_STEPS_MAX));
}
