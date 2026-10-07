import { memoryHostOfUrl } from "../../shared/memory.js";
import type { RouteAction, RouteTarget, TaskRoute } from "../../shared/route.js";
import type { TaskHistoryStore } from "./task-history.js";

/**
 * 照上次的做法走（走老路，YIS-95）：同一网站、同一类事，换进这次的值，逐步找回控件照做；对不上就停下交回模型。
 * 规则见 docs/evals/20261007-route-replay.md。
 */

/** 交给原有工具的参数：点、填、选用 target（@N），打开网址用 url，按键用 key。 */
export interface RouteActParams {
  target?: string;
  label?: string;
  value?: string;
  values?: string;
  url?: string;
  key?: string;
}

export interface ReplayPort {
  /** 在当前页找四项都相同的控件；不给 target 时只回当前网址。 */
  find(target?: RouteTarget): Promise<{ url: string; ref: string | null; matches: number }>;
  /** 交给原有的点、填、选、按键、打开网址工具执行。 */
  act(name: RouteAction, params: RouteActParams): Promise<void>;
}

export interface ReplayResult {
  done: number;
  total: number;
  /** 停下的原因（给模型）；走完时没有。 */
  stop?: string;
}

/** 值不齐、步骤号不对、不在这个网站：抛错，一步都不做。 */
function checkInput(route: TaskRoute, values: ReadonlyArray<{ step: number; value: string }>): Map<number, string> {
  const given = new Map<number, string>();

  for (const { step, value } of values) {
    const target = route.steps[step - 1];

    if (!target || target.value === undefined) throw new Error(`Step ${step} has no value to change; nothing was done. Only steps that show a value can take one.`);
    given.set(step, value);
  }

  const missing = route.steps.flatMap((step, i) => (step.valueFrom === "said" && !given.has(i + 1) ? [i + 1] : []));

  if (missing.length) throw new Error(`Give this time's value for step ${missing.join(", ")} (the user says it each time); nothing was done.`);

  return given;
}

export async function followRoute(input: { route: TaskRoute; hosts: readonly string[]; values: ReadonlyArray<{ step: number; value: string }> }, port: ReplayPort): Promise<ReplayResult> {
  const { route, hosts } = input;
  const given = checkInput(route, input.values);
  const total = route.steps.length;
  const here = memoryHostOfUrl((await port.find()).url);

  if (!here || !hosts.includes(here)) throw new Error(`The current page (${here ?? "no site"}) is not on the site this route was recorded on (${hosts.join(", ")}); nothing was done.`);

  for (const [i, step] of route.steps.entries()) {
    const n = i + 1;
    const stop = (why: string): ReplayResult => ({ done: i, total, stop: `Stopped before step ${n}: ${why}` });

    if (step.secret) return stop(`it needs "${step.target?.name}", which is asked from the user each time. Ask the user, then continue from step ${n} yourself.`);
    const value = given.get(n) ?? step.value;

    try {
      if (step.action === "navigate") {
        if (!step.url || !hosts.includes(memoryHostOfUrl(step.url) ?? "")) return stop("it opens a page on another site.");
        await port.act("navigate", { url: step.url });
        continue;
      }

      if (step.action === "press_key") {
        await port.act("press_key", { key: step.key });
        continue;
      }

      if (!step.target) return stop("the route does not say which control.");
      // 「选哪一间」：值就是所在卡片的名字，换值即换卡片。
      const want = step.action === "click" && step.value !== undefined ? { ...step.target, box: value ?? step.target.box } : step.target;
      const found = await port.find(want);

      if (!found.ref) return stop(`${found.matches ? `${found.matches} controls look like` : "the page has no"} ${want.role} "${want.name}"${want.box ? ` in "${want.box}"` : ""}${want.area ? ` (${want.area})` : ""}. The page may have changed; look at it and continue from step ${n} yourself.`);
      const params: RouteActParams = { target: found.ref };

      if (step.label) params.label = step.label;

      if (step.action === "fill") params.value = value;

      if (step.action === "select_option") params.values = value;
      await port.act(step.action, params);
    } catch (error) {
      return stop(`it failed: ${error instanceof Error ? error.message : String(error)}. Check the page; the result of step ${n} is unknown.`);
    }
  }

  return { done: total, total };
}

/** 带给模型的做法：每步一行，标出值从哪来；「这次说的」要由模型给出这次的值。 */
export function describeRoute(taskId: string, route: TaskRoute): string {
  const lines = route.steps.map((step, i) => {
    if (step.action === "navigate") return `    ${i + 1} navigate ${step.url ?? ""}`;

    if (step.action === "press_key") return `    ${i + 1} press_key ${step.key ?? ""}`;
    const t = step.target;
    const where = t ? `${t.role} "${t.name}"${t.box ? ` in card "${t.box}"` : ""}` : "";
    const value = step.secret ? " [secret: ask the user]" : step.value === undefined ? "" : ` = ${JSON.stringify(step.value)} [${step.valueFrom ?? "fixed"}]`;

    return `    ${i + 1} ${step.action} ${where}${value}`;
  });

  return `  route ${taskId} (for the same kind of task here, call follow_route instead of redoing these steps yourself; it is much faster):\n${lines.join("\n")}`;
}

/** 照走用：取一条过往任务记下的做法和网站；没有这条任务或没记做法时为 undefined。 */
export async function routeOfTask(history: TaskHistoryStore | undefined, taskId: string): Promise<{ route: TaskRoute; hosts: string[] } | undefined> {
  const task = (await history?.list())?.find(entry => entry.id === taskId);

  return task?.route ? { route: task.route, hosts: task.hosts } : undefined;
}
