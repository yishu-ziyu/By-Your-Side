// 走老路记做法（YIS-94）的代码裁判与存值规则。失败方式先列：
// 1 密码一类的值进了做法；2 没做完、被停下、中途改方向也存了；3 改页面的步骤失败了也存了；
// 4 有一步认不出控件也存了；5 用户这次说的值没标成「这次说的」，没说的却标了；6 用户话里的卡号留在做法里；
// 7 按文字点了这次说的那一项（卡片标题「青松」），没当成选的值，下次还点「青松」（YIS-103）。
import { describe, expect, it } from "vitest";
import { judgeRoute, noteRouteStep, type RouteDraft, type RouteNote, type RouteVerdictInput } from "../src/route-record.js";
import { redactTaskSecrets } from "../src/task-history.js";
import type { TaskHistoryEntry } from "../../shared/task-history.js";
import { routeShape, type RouteStep } from "../../shared/route.js";

const box = (name: string, role = "textbox") => ({ role, name, area: "form:", box: "" });

function draftOf(notes: RouteNote[]): RouteDraft {
  const empty: RouteDraft = { steps: [] };

  return notes.reduce(noteRouteStep, empty);
}

const booking: RouteNote[] = [
  { action: "fill", target: box("日期"), value: "2026-10-09", memory: false },
  { action: "click", target: { role: "button", name: "选择", area: "", box: "青松" }, label: "选青松", memory: false },
  { action: "fill", target: box("会议主题"), value: "周会", memory: false },
  { action: "fill", target: box("邮箱"), value: "a@example.com", memory: true },
  { action: "click", target: { role: "button", name: "预订", area: "form:", box: "" }, memory: false },
];

const ok: Omit<RouteVerdictInput, "draft"> = { outcome: "complete", revised: false, results: [], said: "订 2026-10-09 的青松，主题周会" };

describe("记做法的代码裁判", () => {
  it("做完、步骤都认得出：存下，这次说的值标「这次说的」（含在几张卡片里选的那张），记忆里的标「记忆」，其余标「固定」", () => {
    const verdict = judgeRoute({ ...ok, draft: draftOf([...booking, { action: "fill", target: box("备注"), value: "无", memory: false }]) });

    expect("route" in verdict && verdict.route.steps.map((s) => s.valueFrom)).toEqual(["said", "said", "said", "memory", undefined, "fixed"]);
    expect("route" in verdict && [verdict.route.steps[1]!.target!.box, verdict.route.steps[1]!.value]).toEqual(["青松", "青松"]);
  });

  it("密码、验证码的值不存，只记这里要填", () => {
    const draft = draftOf([{ action: "fill", target: box("登录密码"), value: "hunter2", memory: false }, { action: "fill", target: box("短信验证码"), value: "123456", memory: false }, { action: "fill", target: box("信用卡卡号"), value: "4111111111111111", memory: false }, { action: "click", target: box("登录", "button"), memory: false }]);

    expect(draft.steps.slice(0, 3).map((s) => [s.value, s.secret])).toEqual([[undefined, true], [undefined, true], [undefined, true]]);
    expect(JSON.stringify(draft)).not.toMatch(/hunter2|123456|4111/);
  });

  it.each<[string, Partial<RouteVerdictInput>]>([
    ["没做完", { outcome: "partial" as const }],
    ["被停下", { outcome: "stopped" as const }],
    ["出错", { outcome: "error" as const }],
    ["中途改方向", { revised: true }],
    ["改页面的步骤结果未知", { results: [{ tool: "click", status: "unknown" as const, evidence: null }] }],
    ["改页面的步骤没成功", { results: [{ tool: "fill", status: "blocked" as const, evidence: null }] }],
  ])("%s：不存", (_label, change) => {
    expect(judgeRoute({ ...ok, draft: draftOf(booking), ...change })).toHaveProperty("rejected");
  });

  it("有一步认不出点的是哪个控件：整份不存", () => {
    expect(judgeRoute({ ...ok, draft: draftOf([...booking.slice(0, 2), { action: "click", target: null, memory: false }, ...booking.slice(2)]) })).toEqual({ rejected: "有一步认不出点的是哪个控件（click 没有定位）" });
  });

  it("只打开了网址、没动手：不存", () => {
    expect(judgeRoute({ ...ok, draft: draftOf([{ action: "navigate", target: null, url: "https://example.com/", memory: false }]) })).toHaveProperty("rejected");
  });
});

describe("过往任务隐去用户话里的卡号", () => {
  it("用户话里的卡号填进了名字普通的一格：值去掉，记成这里要填", () => {
    const entry: TaskHistoryEntry = {
      id: "run1", conversationId: "c1", goal: "用信用卡 4111 1111 1111 1111 付款", revisions: [], hosts: ["shop.example"], outcome: "complete", summary: "付好了", unfinished: [], startedAt: 1, endedAt: 2,
      route: { recordedAt: 2, steps: [{ action: "fill", target: box("付款信息"), value: "4111 1111 1111 1111", valueFrom: "said" }, { action: "click", target: box("付款", "button") }] },
    };

    const redacted = redactTaskSecrets(entry);

    expect(redacted.route!.steps[0]).toEqual({ action: "fill", target: box("付款信息"), secret: true });
    expect(JSON.stringify(redacted)).not.toContain("4111 1111");
  });
});

describe("同一张卡片点了两次", () => {
  it("做法里只留一次（选卡片重复点没有新作用）；别的按钮点两次照记", () => {
    const pick: RouteNote = { action: "click", target: { role: "button", name: "选择", area: "region:会议室", box: "青松" }, memory: false };
    const next: RouteNote = { action: "click", target: { role: "button", name: "下一页", area: "", box: "" }, memory: false };
    const verdict = judgeRoute({ ...ok, draft: draftOf([pick, booking[2]!, pick, next, next]) });

    expect("route" in verdict && verdict.route.steps.map((s) => s.target?.name)).toEqual(["选择", "会议主题", "下一页", "下一页"]);
  });

  it("按文字点了这次说的那一项：文字就是选的值，标「这次说的」；没说过的文字照原样点", () => {
    const verdict = judgeRoute({ ...ok, draft: draftOf([booking[0]!, { action: "click", target: { role: "heading", name: "青松", area: "", box: "" }, memory: false }, { action: "click", target: { role: "heading", name: "会议室", area: "", box: "" }, memory: false }, booking[4]!]) });

    expect("route" in verdict && verdict.route.steps.slice(1, 3).map((s) => [s.value, s.valueFrom])).toEqual([["青松", "said"], [undefined, undefined]]);
  });

  it("同一类事的两份做法样子相同（值、选哪张卡片、按文字点的哪一项不算）；换了控件就不同", () => {
    const steps = (date: string, room: string, button = "预订"): RouteStep[] => [
      { action: "select_option", target: box("日期", "combobox"), value: date, valueFrom: "said" },
      { action: "click", target: { role: "button", name: "选择", area: "", box: room }, value: room, valueFrom: "said" },
      { action: "click", target: { role: "heading", name: room, area: "", box: "" }, value: room, valueFrom: "said" },
      { action: "click", target: box(button, "button") },
    ];
    const shape = (list: RouteStep[]) => routeShape({ steps: list, recordedAt: 1 });

    expect(shape(steps("10 月 8 日", "青松"))).toBe(shape(steps("10 月 15 日", "白桦")));
    expect(shape(steps("10 月 8 日", "青松"))).not.toBe(shape(steps("10 月 8 日", "青松", "预约此间")));
  });
});
