import { memoryHostOfUrl } from "../../shared/memory.js";
import type { RouteAction, RouteTarget, TaskRoute } from "../../shared/route.js";
import type { CheckField, CheckVerdict } from "./route-check.js";
import type { TaskHistoryStore } from "./task-history.js";

/**
 * 照上次的做法走（走老路，YIS-95）：同一网站、同一类事，换进这次的值，逐步找回控件照做；对不上就停下交回模型。
 * 走到提交一类的步骤前先核对（YIS-96）。规则见 docs/evals/20261007-route-replay.md、docs/evals/20261007-route-check.md。
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
  /** 交给原有的点、填、选、按键、打开网址工具执行；at 给侧栏写「第 N/M 步」。 */
  act(name: RouteAction, params: RouteActParams, at: { step: number; of: number }): Promise<void>;
  /** 读回一个控件现在的值；找不到时为 null。 */
  read(target: RouteTarget): Promise<{ value?: string; displayValue?: string } | null>;
  /** 提交前核对：要交出去的值是不是用户这次要的；抛错算没核对成。 */
  check(input: { fields: CheckField[]; submit: string }): Promise<CheckVerdict>;
}

export interface ReplayResult {
  done: number;
  total: number;
  /** 停下的原因（给模型）；走完时没有。 */
  stop?: string;
  /** 给侧栏的一行（控件对不上、核对没过、要问用户）。 */
  notice?: string;
}

/** 名字像提交、付款、发送、删除这类会把东西交出去的按钮。 */
const SUBMIT = /提交|预订|预约|付款|支付|购买|下单|发送|删除|确认|保存|报名|登记|submit|book|reserve|pay|purchase|order|send|delete|remove|confirm|save|place/i;

/** 值不齐、步骤号不对、不在这个网站：抛错，一步都不做。 */
function checkInput(route: TaskRoute, values: ReadonlyArray<{ step: number; value: string }>, asked: readonly string[]): Map<number, string> {
  const given = new Map<number, string>();

  for (const { step, value } of values) {
    const target = route.steps[step - 1];

    if (!target || target.value === undefined) throw new Error(`Step ${step} has no value to change; nothing was done. Only steps that show a value can take one.`);
    given.set(step, value);
  }

  // 用户这次原话里又说了上次的值（「还是青松」）：模型没再传也照用，不必整个退回一步步做（10-07 实测）。
  const words = asked.join("\n").replace(/\s+/g, "");

  for (const [i, step] of route.steps.entries()) {
    if (step.valueFrom === "said" && step.value?.trim() && !given.has(i + 1) && words.includes(step.value.replace(/\s+/g, ""))) given.set(i + 1, step.value);
  }

  const missing = route.steps.flatMap((step, i) => (step.valueFrom === "said" && !given.has(i + 1) ? [i + 1] : []));

  if (missing.length) throw new Error(`Give this time's value for step ${missing.join(", ")} (the user says it each time); nothing was done.`);

  return given;
}

export async function followRoute(input: { route: TaskRoute; hosts: readonly string[]; values: ReadonlyArray<{ step: number; value: string }>; /** 用户这次说的话（目标与补充）。 */ asked?: readonly string[] }, port: ReplayPort): Promise<ReplayResult> {
  const { route, hosts } = input;
  const given = checkInput(route, input.values, input.asked ?? []);
  const total = route.steps.length;
  const here = memoryHostOfUrl((await port.find()).url);

  if (!here || !hosts.includes(here)) throw new Error(`The current page (${here ?? "no site"}) is not on the site this route was recorded on (${hosts.join(", ")}); nothing was done.`);
  const lastClick = route.steps.map((step, i) => (step.action === "click" && step.value === undefined ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
  /** 已经写进页面的值；pending 是上次核对之后新写的（要读回）。 */
  const fields: Array<CheckField & { target: RouteTarget; readable: boolean }> = [];
  let pending = 0;
  const picked = new Set<string>();

  for (const [i, step] of route.steps.entries()) {
    const n = i + 1;

    const stop = (why: string, notice?: string): ReplayResult => {
      const result: ReplayResult = { done: i, total, stop: `Stopped before step ${n}: ${why}` };

      if (notice) result.notice = notice;

      return result;
    };

    // 中途停下、已经写过值：交回前也核对一次。模型接手后会自己提交，写错的值得先告诉它（10-07 实测：没核对就交回，订错了日期）。
    const halt = async (why: string, notice?: string): Promise<ReplayResult> => {
      if (pending === 0) return stop(why, notice);
      const verdict = await port.check({ fields: fields.map(({ step: at, field, value: v, from }) => ({ step: at, field, value: v, from })), submit: "" }).catch(() => null);
      const found = !verdict ? " The values written so far could not be checked: compare them with what the user asked before submitting." : verdict.ok ? "" : ` The values written so far were checked against the request: ${verdict.problem}. Fix that before submitting.`;

      return stop(`${why}${found}`, notice);
    };

    if (step.secret) return await halt(`it needs "${step.target?.name}", which is asked from the user each time. Ask the user, then continue from step ${n} yourself.`, `第 ${n} 步要填「${step.target?.name ?? ""}」，这一项每次问你`);
    const value = given.get(n) ?? step.value;
    const submit = (step.action === "press_key" && /enter/i.test(step.key ?? "")) || (step.action === "click" && step.value === undefined && (SUBMIT.test(step.target?.name ?? "") || i === lastClick));

    // 提交前核对：先读回新写的值，再看是不是用户这次要的。没过或没核对成都停在提交前，并告诉模型提交按钮现在是哪个，改完一步就能提交。
    if (submit && pending > 0) {
      const submitRef = async () => {
        const where = step.target ? await port.find(step.target).catch(() => null) : null;

        return where?.ref ? ` The submit control "${step.target!.name}" is ${where.ref}.` : "";
      };

      for (const field of fields.slice(-pending).filter(item => item.readable)) {
        const now = await port.read(field.target).catch(() => null);

        if (!now || (now.value?.trim() !== field.value.trim() && now.displayValue?.trim() !== field.value.trim())) {
          return stop(`step ${field.step} ("${field.field}") should be "${field.value}" but the page shows "${now?.displayValue ?? now?.value ?? "nothing"}". Fix it, then submit yourself.${await submitRef()}`, `第 ${field.step} 步「${field.field}」页面上不是「${field.value}」，改为一步步看`);
        }
      }

      const label = step.target?.name ?? step.key ?? "";
      const verdict = await port.check({ fields: fields.map(({ step: at, field, value: v, from }) => ({ step: at, field, value: v, from })), submit: label }).catch((error: Error) => ({ ok: false as const, problem: "", error }));

      if (!verdict.ok) {
        return "error" in verdict
          ? stop(`the check before submitting could not run (${verdict.error.message}). Look at the page, compare the values with what the user asked, then submit yourself.${await submitRef()}`, "提交前核对没能完成，改为一步步看")
          : stop(`the check before submitting found: ${verdict.problem}. Fix it, then submit yourself.${await submitRef()}`, `提交前核对没过：${verdict.problem}，改为一步步看`);
      }

      pending = 0;
    }

    try {
      if (step.action === "navigate") {
        if (!step.url || !hosts.includes(memoryHostOfUrl(step.url) ?? "")) return await halt("it opens a page on another site.");
        await port.act("navigate", { url: step.url }, { step: n, of: total });
        continue;
      }

      if (step.action === "press_key") {
        await port.act("press_key", { key: step.key }, { step: n, of: total });
        continue;
      }

      if (!step.target) return await halt("the route does not say which control.");
      // 「选哪一间」：值就是所在卡片的名字，换值即换卡片。
      // 选的值在卡片名（box）上，或按文字点的就是文字本身（名字）。
      const want = step.action !== "click" || step.value === undefined ? step.target : step.target.box ? { ...step.target, box: value ?? step.target.box } : { ...step.target, name: value ?? step.target.name };

      // 同一张卡片这次已经选过：不再点（会被当成重复操作拦下），旧做法里可能记了两次。
      if (step.action === "click" && step.value !== undefined && picked.has(JSON.stringify(want))) continue;
      const found = await port.find(want);

      if (!found.ref) {
        return await halt(`${found.matches ? `${found.matches} controls look like` : "the page has no"} ${want.role} "${want.name}"${want.box ? ` in "${want.box}"` : ""}${want.area ? ` (${want.area})` : ""}. The page may have changed; look at it and continue from step ${n} yourself.`,
          `第 ${n} 步对不上：${found.matches ? "分不清" : "找不到"}上次点的「${want.name}」，改为一步步看`);
      }

      const params: RouteActParams = { target: found.ref };

      // 步骤名里带着上次的值（「选青松」）：换了值就跟着换，侧栏不写错。没有步骤名的填和选，用控件名起一个（选的写上选项，填的值不写）。
      if (step.label) params.label = step.value && value && value !== step.value ? step.label.split(step.value).join(value) : step.label;
      else if (step.action === "select_option") params.label = `${want.name} ${value ?? ""}`.trim();
      else if (step.action === "fill") params.label = want.name;

      if (step.action === "fill") params.value = value;

      if (step.action === "select_option") params.values = value;
      await port.act(step.action, params, { step: n, of: total });

      if (step.action === "click" && step.value !== undefined) picked.add(JSON.stringify(want));

      if (value !== undefined) {
        // 选卡片：字段名用所在区域（「会议室」），读不回值；填和选的值要读回核对。
        const field = step.action === "click" ? want.area.split(":").slice(1).join(":") || want.name : want.name;
        const from = given.has(n) ? (step.valueFrom === "said" ? "said" : "changed") : step.valueFrom ?? "fixed";
        fields.push({ step: n, field, value, from, target: want, readable: step.action !== "click" });
        pending += 1;
      }
    } catch (error) {
      return await halt(`it failed: ${error instanceof Error ? error.message : String(error)}. Check the page; the result of step ${n} is unknown.`);
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

  return `  route ${routeHandle(taskId)} (for the same kind of task here, call follow_route instead of redoing these steps yourself; it is much faster):\n${lines.join("\n")}`;
}

/** 带给模型的做法编号：任务 id 的前 8 位。完整的 id 太长，模型会抄错或拿别的 id 顶上（10-07 实测）。 */
export const routeHandle = (taskId: string) => taskId.slice(0, 8);

/** 照走用：按编号取一条过往任务记下的做法和网站；对不上时给出现有的做法，好让模型重选。 */
export async function routeOfTask(history: Pick<TaskHistoryStore, "list"> | undefined, handle: string): Promise<{ route: TaskRoute; hosts: string[] } | { choices: string[] }> {
  const routed = ((await history?.list()) ?? []).filter(entry => entry.route);
  const key = handle.trim().replace(/^route\s+/i, "");
  const hits = key ? routed.filter(entry => entry.id.startsWith(key) || routeHandle(entry.id) === key) : [];

  if (hits.length === 1 && hits[0]!.route) return { route: hits[0]!.route, hosts: hits[0]!.hosts };

  return { choices: routed.slice(0, 6).map(entry => `${routeHandle(entry.id)} (${entry.hosts.join(", ")}: ${entry.goal.slice(0, 60)})`) };
}
