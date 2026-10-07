// 照上次的做法走（YIS-95）。失败方式先列：
// 1 漏给「这次说的」值还照走（填进上次的值）；2 给了不存在或不可换的步骤也照走；3 在别的网站上照走；
// 4 控件找不到或分不清时猜一个继续点；5 停下后后面的步骤还在做；6「选哪一间」没换成这次的卡片；
// 7 记忆、固定的值被弄丢，或模型想改却改不了；8 走到密码一类的步骤还往下做；9 中途打开别的网站；10 某步出错后接着做。
// 提交前核对（YIS-96）：11 核对没过或没跑成也点了提交；12 页面上的值和要写的不一样也提交；13 没写过新值也核对、多等；
// 14 交给核对的值标错来源（模型改过的标成「这次说的」）；15 对不上时侧栏没有那一行；16 侧栏拿不到「第 N/M 步」；
// 17 换了值，步骤名还写着上次的值（点白桦却写「选青松」）；18 模型抄错做法编号就只能放弃，不知道有哪些可选；
// 21 用户这次又原样说了上次的值（「青松」「周会」），模型没再传一遍，就整个拒绝、退回一步步做；
// 19 写过值后中途停下（还没到提交），交回时不核对，模型自己提交了错的值（10-07 实测订错日期）；20 同一张卡片点两次被当成重复操作停下。
import { describe, expect, it } from "vitest";
import { followRoute, routeOfTask, type ReplayPort, type RouteActParams } from "../src/route-replay.js";
import type { TaskHistoryEntry } from "../../shared/task-history.js";
import type { RouteStep, RouteTarget, TaskRoute } from "../../shared/route.js";
import type { CheckField, CheckVerdict } from "../src/route-check.js";

const t = (role: string, name: string, box = ""): RouteTarget => ({ role, name, area: "", box });

const steps: RouteStep[] = [
  { action: "select_option", target: t("combobox", "日期"), value: "10 月 8 日（周四）", valueFrom: "said" },
  { action: "click", target: t("button", "选择", "青松"), value: "青松", valueFrom: "said", label: "选青松" },
  { action: "fill", target: t("textbox", "会议主题"), value: "周会", valueFrom: "said" },
  { action: "fill", target: t("textbox", "邮箱"), value: "a@example.com", valueFrom: "memory" },
  { action: "fill", target: t("textbox", "人数"), value: "8", valueFrom: "fixed" },
  { action: "click", target: t("button", "预订") },
];

const route = (list = steps): TaskRoute => ({ steps: list, recordedAt: 1 });

const said = [{ step: 1, value: "10 月 15 日（周四）" }, { step: 2, value: "白桦" }, { step: 3, value: "复盘" }];

/**
 * 假页面：在 site 上；missing / ambiguous 里的名字找不到或有两个；pageValues 改写读回的值（默认读回写进去的值）；
 * verdict 是提交前核对的结论（抛错表示核对没跑成）。记下每次找、每次动手、每次核对。
 */
function page(options: { url?: string; missing?: string[]; ambiguous?: string[]; failOn?: string; pageValues?: Record<string, string>; verdict?: CheckVerdict | Error } = {}) {
  const found: RouteTarget[] = [];
  const acted: Array<[string, RouteActParams]> = [];
  const progress: string[] = [];
  const checks: Array<{ fields: CheckField[]; submit: string }> = [];
  const written = new Map<string, string>();

  const port: ReplayPort = {
    async find(target) {
      const url = options.url ?? "https://rooms.example.com/book";

      if (!target) return { url, ref: null, matches: 0 };
      found.push(target);

      if (options.missing?.includes(target.name)) return { url, ref: null, matches: 0 };

      if (options.ambiguous?.includes(target.name)) return { url, ref: null, matches: 2 };

      return { url, ref: `@${found.length}`, matches: 1 };
    },
    async act(name, params, at) {
      if (options.failOn && params.target === options.failOn) throw new Error("页面没反应");
      acted.push([name, params]);
      progress.push(`${at.step}/${at.of}`);
    },
    async read(target) {
      const value = options.pageValues?.[target.name] ?? written.get(target.name);

      return value === undefined ? null : { value };
    },
    async check(input) {
      checks.push(input);

      if (options.verdict instanceof Error) throw options.verdict;

      return options.verdict ?? { ok: true };
    },
  };

  // 读回默认是刚写进去的值：按动手顺序记下填和选的值。
  const act = port.act.bind(port);
  port.act = async (name, params, at) => {
    await act(name, params, at);
    const target = params.target ? found[Number(params.target.slice(1)) - 1] : undefined;

    if (target && (params.value ?? params.values) !== undefined) written.set(target.name, String(params.value ?? params.values));
  };

  return { port, found, acted, progress, checks };
}

const hosts = ["rooms.example.com"];

describe("照上次的做法走", () => {
  it("值都给齐：每步按这次的值做完；「选哪一间」换成这次的卡片；记忆、固定的值照旧", async () => {
    const p = page();
    const result = await followRoute({ route: route(), hosts, values: said }, p.port);

    expect(result).toEqual({ done: 6, total: 6 });
    expect(p.found[1]).toEqual(t("button", "选择", "白桦"));
    expect(p.acted.map(([, params]) => params.label)).toEqual(["日期 10 月 15 日（周四）", "选白桦", "会议主题", "邮箱", "人数", undefined]);
    expect(p.acted.map(([name, params]) => [name, params.values ?? params.value ?? null])).toEqual([
      ["select_option", "10 月 15 日（周四）"], ["click", null], ["fill", "复盘"], ["fill", "a@example.com"], ["fill", "8"], ["click", null],
    ]);
  });

  it("模型可以改记忆或固定的值", async () => {
    const p = page();
    await followRoute({ route: route(), hosts, values: [...said, { step: 5, value: "12" }] }, p.port);

    expect(p.acted[4]).toEqual(["fill", { target: "@5", value: "12", label: "人数" }]);
  });

  it("漏给「这次说的」值：一步都不做", async () => {
    const p = page();

    await expect(followRoute({ route: route(), hosts, values: said.slice(0, 2) }, p.port)).rejects.toThrow(/3/);
    expect(p.acted).toEqual([]);
  });

  it("没传的「这次说的」值，用户这次原话里又说了一遍：照用上次的值", async () => {
    const p = page();
    const result = await followRoute({ route: route(), hosts, values: said.slice(0, 1), asked: ["下周四再订一次，还是青松，主题还是周会"] }, p.port);

    expect(result).toEqual({ done: 6, total: 6 });
    expect(p.acted[2]).toEqual(["fill", { target: "@3", value: "周会", label: "会议主题" }]);
    await expect(followRoute({ route: route(), hosts, values: said.slice(0, 1), asked: ["下周四再订一次青松"] }, page().port)).rejects.toThrow(/step 3/);
  });

  it("给了不存在或没有值可换的步骤：一步都不做", async () => {
    for (const bad of [{ step: 9, value: "x" }, { step: 6, value: "x" }]) {
      const p = page();

      await expect(followRoute({ route: route(), hosts, values: [...said, bad] }, p.port)).rejects.toThrow(new RegExp(String(bad.step)));
      expect(p.acted).toEqual([]);
    }
  });

  it("当前页面不在记下做法的网站：一步都不做", async () => {
    const p = page({ url: "https://other.example.org/" });

    await expect(followRoute({ route: route(), hosts, values: said }, p.port)).rejects.toThrow(/other\.example\.org/);
    expect(p.acted).toEqual([]);
  });

  it("控件找不到或分不清：停在那一步，后面不做", async () => {
    for (const options of [{ missing: ["选择"] }, { ambiguous: ["选择"] }]) {
      const p = page(options);
      const result = await followRoute({ route: route(), hosts, values: said }, p.port);

      expect(result.done).toBe(1);
      expect(result.stop).toMatch(/step 2/);
      expect(p.acted).toHaveLength(1);
    }
  });

  it("走到密码一类的步骤：前面照做，停在它前面", async () => {
    const p = page();
    const withSecret = [...steps.slice(0, 3), { action: "fill" as const, target: t("textbox", "密码"), secret: true as const }, ...steps.slice(3)];
    const result = await followRoute({ route: route(withSecret), hosts, values: said }, p.port);

    expect(result.done).toBe(3);
    expect(result.stop).toMatch(/step 4.*ask the user/i);
    expect(p.acted).toHaveLength(3);
  });

  it("中途要打开别的网站：停下", async () => {
    const p = page();
    const result = await followRoute({ route: route([{ action: "navigate", url: "https://evil.example.net/" }, ...steps]), hosts, values: said.map((v) => ({ ...v, step: v.step + 1 })) }, p.port);

    expect(result.done).toBe(0);
    expect(p.acted).toEqual([]);
  });

  it("某步出错：停下，说清是哪一步，后面不做", async () => {
    const p = page({ failOn: "@3" });
    const result = await followRoute({ route: route(), hosts, values: said }, p.port);

    expect(result.done).toBe(2);
    expect(result.stop).toMatch(/step 3.*页面没反应/);
    expect(p.acted).toHaveLength(2);
  });
});

describe("提交前核对", () => {
  it("写过值、走到提交前：先核对一次；交给核对的值标明来源（这次说的、模型改过、记忆、上次的）", async () => {
    const p = page();
    await followRoute({ route: route(), hosts, values: [...said, { step: 5, value: "12" }] }, p.port);

    expect(p.checks).toHaveLength(1);
    expect(p.checks[0]!.submit).toBe("预订");
    expect(p.checks[0]!.fields.map((f) => [f.step, f.value, f.from])).toEqual([
      [1, "10 月 15 日（周四）", "said"], [2, "白桦", "said"], [3, "复盘", "said"], [4, "a@example.com", "memory"], [5, "12", "changed"],
    ]);
    expect(p.acted.at(-1)?.[0]).toBe("click");
  });

  it("核对没过：不点提交，停在它前面，说清哪一项", async () => {
    const p = page({ verdict: { ok: false, problem: "日期现在是「10 月 8 日」，你这次说的是「10 月 15 日」" } });
    const result = await followRoute({ route: route(), hosts, values: said }, p.port);

    expect(result.done).toBe(5);
    expect(result.stop).toMatch(/step 6.*10 月 8 日.*"预订" is @\d+/);
    expect(result.notice).toMatch(/提交前核对没过/);
    expect(p.acted).toHaveLength(5);
  });

  it("核对没跑成（超时、出错）：按没核对过处理，不点提交", async () => {
    const p = page({ verdict: new Error("超时") });
    const result = await followRoute({ route: route(), hosts, values: said }, p.port);

    expect(result.done).toBe(5);
    expect(p.acted).toHaveLength(5);
  });

  it("页面上读回的值和要写的不一样：不问判断，直接停在提交前", async () => {
    const p = page({ pageValues: { 会议主题: "周" } });
    const result = await followRoute({ route: route(), hosts, values: said }, p.port);

    expect(result.done).toBe(5);
    expect(result.stop).toMatch(/会议主题/);
    expect(result.notice).toBe("第 3 步「会议主题」页面上不是「复盘」，改为一步步看");
    expect(p.checks).toEqual([]);
  });

  it("前面没写过新值的提交类步骤不核对；两次提交之间没写新值，只核对一次", async () => {
    const p = page();
    const clicksOnly = [{ action: "click" as const, target: t("button", "确认") }, ...steps, { action: "click" as const, target: t("button", "确认") }];
    await followRoute({ route: route(clicksOnly), hosts, values: said.map((v) => ({ ...v, step: v.step + 1 })) }, p.port);

    expect(p.checks).toHaveLength(1);
    expect(p.acted).toHaveLength(8);
  });

  it("写过值后中途停下：交回前也核对一次，对不上的写进交回的话里", async () => {
    const p = page({ missing: ["邮箱"], verdict: { ok: false, problem: "日期现在是「10 月 8 日」，你这次说的是「10 月 15 日」" } });
    const result = await followRoute({ route: route(), hosts, values: said }, p.port);

    expect(result.done).toBe(3);
    expect(p.checks).toHaveLength(1);
    expect(result.stop).toMatch(/step 4.*10 月 8 日.*before submitting/);
  });

  it("同一张卡片点第二次：已经选上了，跳过，不停下", async () => {
    const p = page();
    const twice = [...steps.slice(0, 3), steps[1]!, ...steps.slice(3)];
    const result = await followRoute({ route: route(twice), hosts, values: [...said, { step: 4, value: "白桦" }] }, p.port);

    expect(result).toEqual({ done: 7, total: 7 });
    expect(p.acted.filter(([name]) => name === "click")).toHaveLength(2);
  });

  it("侧栏拿得到「第 N/M 步」；控件对不上时给出那一行", async () => {
    const p = page({ missing: ["选择"] });
    const result = await followRoute({ route: route(), hosts, values: said }, p.port);

    expect(p.progress).toEqual(["1/6"]);
    expect(result.notice).toBe("第 2 步对不上：找不到上次点的「选择」，改为一步步看");
  });
});

describe("按编号取做法", () => {
  const entry = (id: string, routed = true): TaskHistoryEntry => {
    const task: TaskHistoryEntry = { id, conversationId: "c", goal: `订会议室 ${id}`, hosts: ["rooms.example.com"], revisions: [], outcome: "complete", summary: "", unfinished: [], startedAt: 1, endedAt: 2 };

    if (routed) task.route = route();

    return task;
  };

  const history = { list: async () => [entry("003c3b41-2278-46dc-bdb6-ded772bc59f8"), entry("3de9e164-bde7-4b36-a19a-05c55193b5b7"), entry("1d35c4fd-905a-4867-a1b2-7b0391e43c30", false)] };

  it("8 位编号和完整编号都认得", async () => {
    expect(await routeOfTask(history, "003c3b41")).toHaveProperty("route");
    expect(await routeOfTask(history, "route 3de9e164-bde7-4b36-a19a-05c55193b5b7")).toHaveProperty("route");
  });

  it("编号不对或那条没记做法：列出现有的做法让模型重选", async () => {
    for (const wrong of ["1d35c4fd", "ffffffff", ""]) {
      const found = await routeOfTask(history, wrong);

      expect(found).toEqual({ choices: ["003c3b41 (rooms.example.com: 订会议室 003c3b41-2278-46dc-bdb6-ded772bc59f8)", "3de9e164 (rooms.example.com: 订会议室 3de9e164-bde7-4b36-a19a-05c55193b5b7)"] });
    }
  });
});
