// 照上次的做法走（YIS-95）。失败方式先列：
// 1 漏给「这次说的」值还照走（填进上次的值）；2 给了不存在或不可换的步骤也照走；3 在别的网站上照走；
// 4 控件找不到或分不清时猜一个继续点；5 停下后后面的步骤还在做；6「选哪一间」没换成这次的卡片；
// 7 记忆、固定的值被弄丢，或模型想改却改不了；8 走到密码一类的步骤还往下做；9 中途打开别的网站；10 某步出错后接着做。
import { describe, expect, it } from "vitest";
import { followRoute, type ReplayPort, type RouteActParams } from "../src/route-replay.js";
import type { RouteStep, RouteTarget, TaskRoute } from "../../shared/route.js";

const t = (role: string, name: string, box = ""): RouteTarget => ({ role, name, area: "", box });

const steps: RouteStep[] = [
  { action: "select_option", target: t("combobox", "日期"), value: "10 月 9 日（周四）", valueFrom: "said" },
  { action: "click", target: t("button", "选择", "青松"), value: "青松", valueFrom: "said" },
  { action: "fill", target: t("textbox", "会议主题"), value: "周会", valueFrom: "said" },
  { action: "fill", target: t("textbox", "邮箱"), value: "a@example.com", valueFrom: "memory" },
  { action: "fill", target: t("textbox", "人数"), value: "8", valueFrom: "fixed" },
  { action: "click", target: t("button", "预订") },
];

const route = (list = steps): TaskRoute => ({ steps: list, recordedAt: 1 });

const said = [{ step: 1, value: "10 月 16 日（周四）" }, { step: 2, value: "白桦" }, { step: 3, value: "复盘" }];

/** 假页面：在 site 上；missing / ambiguous 里的名字找不到或有两个；记下每次找和每次动手。 */
function page(options: { url?: string; missing?: string[]; ambiguous?: string[]; failOn?: string } = {}) {
  const found: RouteTarget[] = [];
  const acted: Array<[string, RouteActParams]> = [];

  const port: ReplayPort = {
    async find(target) {
      const url = options.url ?? "https://rooms.example.com/book";

      if (!target) return { url, ref: null, matches: 0 };
      found.push(target);

      if (options.missing?.includes(target.name)) return { url, ref: null, matches: 0 };

      if (options.ambiguous?.includes(target.name)) return { url, ref: null, matches: 2 };

      return { url, ref: `@${found.length}`, matches: 1 };
    },
    async act(name, params) {
      if (options.failOn && params.target === options.failOn) throw new Error("页面没反应");
      acted.push([name, params]);
    },
  };

  return { port, found, acted };
}

const hosts = ["rooms.example.com"];

describe("照上次的做法走", () => {
  it("值都给齐：每步按这次的值做完；「选哪一间」换成这次的卡片；记忆、固定的值照旧", async () => {
    const p = page();
    const result = await followRoute({ route: route(), hosts, values: said }, p.port);

    expect(result).toEqual({ done: 6, total: 6 });
    expect(p.found[1]).toEqual(t("button", "选择", "白桦"));
    expect(p.acted.map(([name, params]) => [name, params.values ?? params.value ?? null])).toEqual([
      ["select_option", "10 月 16 日（周四）"], ["click", null], ["fill", "复盘"], ["fill", "a@example.com"], ["fill", "8"], ["click", null],
    ]);
  });

  it("模型可以改记忆或固定的值", async () => {
    const p = page();
    await followRoute({ route: route(), hosts, values: [...said, { step: 5, value: "12" }] }, p.port);

    expect(p.acted[4]).toEqual(["fill", { target: "@5", value: "12" }]);
  });

  it("漏给「这次说的」值：一步都不做", async () => {
    const p = page();

    await expect(followRoute({ route: route(), hosts, values: said.slice(0, 2) }, p.port)).rejects.toThrow(/3/);
    expect(p.acted).toEqual([]);
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
