import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decideMemory, placeMemory, type MemoryComplete } from "../src/memory-decision.js";

/*
 * 记忆模型「一句话记成哪种」的落位，可能出错的方式：
 * 1. 用户让助手订一个带日期的票：在订之前就记成「做过的事」（事情还没发生）。
 * 2. 用户顺口说了带日期的行程、同时请助手做只读的事（查天气）：只读任务不产生过往任务记录，行程被整个丢掉。
 * 3. 纯陈述带日期的行程：没记，或有效期不是那天本地结束。
 * 4. 长期偏好被当成一次性的事，或被记成带有效期的事。
 * 5. 只对这次任务的参数（「这次先订经济舱」）被长期记住。
 * 6. 明说「记住」的带日期的事没记。
 * 7. 做任务时顺口给出的长期资料（邮箱）被当成任务参数丢掉。
 * 8. 密码、银行卡被记下。
 * 9. 给模型的 today 星期错了，「下周三」解析成错的日子。
 */

type About = { longTerm: boolean; date: string | null; onlyThisTask: boolean; explicitRequest: boolean; dateIsTheTask?: boolean };

function reply(userMessage: string, action: string, taskRequested: boolean, about: About, text = userMessage): string {
  return JSON.stringify({ action, text: action === "save" ? text : "", evidence: action === "save" ? userMessage : "", scope: { kind: "all" }, targets: [], taskRequested, about });
}

async function place(userMessage: string, modelReply: string) {
  const complete: MemoryComplete = async () => modelReply;
  const decision = await decideMemory(complete, userMessage, [], null, new AbortController().signal, [], "auto");

  return placeMemory(decision, []);
}

// 2026-10-01 是星期四（本地时间），「下周三」是 2026-10-07。
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 1, 10, 0, 0)); });

afterEach(() => { vi.useRealTimers(); });

describe("placeMemory write order", () => {
  it("does not remember a dated booking before it is done", async () => {
    const msg = "帮我订 10 月 3 日北京飞成都的机票";
    const p = await place(msg, reply(msg, "save", true, { longTerm: false, date: "2026-10-03", onlyThisTask: false, explicitRequest: false, dateIsTheTask: true }));

    expect(p.store).toBe(false);
  });

  it("treats a reply that omits dateIsTheTask as the task itself (safer default)", async () => {
    const msg = "帮我订 10 月 3 日北京飞成都的机票";
    const p = await place(msg, reply(msg, "save", true, { longTerm: false, date: "2026-10-03", onlyThisTask: false, explicitRequest: false }));

    expect(p.store).toBe(false);
  });

  it("keeps a stated trip when the task is only a weather lookup", async () => {
    const msg = "我下周三去成都出差，帮我查下那边天气";
    const p = await place(msg, reply(msg, "save", true, { longTerm: false, date: "2026-10-07", onlyThisTask: false, explicitRequest: false, dateIsTheTask: false }, "下周三（10 月 7 日）去成都出差"));

    expect(p).toMatchObject({ store: true, kind: "past", date: "2026-10-07", validity: { end: new Date(2026, 9, 7, 23, 59, 59, 999).getTime() } });
  });

  it("stores a plain dated plan until the end of that local day", async () => {
    const msg = "我 10 月 3 日飞成都";
    const p = await place(msg, reply(msg, "save", false, { longTerm: false, date: "2026-10-03", onlyThisTask: false, explicitRequest: false, dateIsTheTask: false }));

    expect(p).toMatchObject({ store: true, kind: "past", date: "2026-10-03", validity: { end: new Date(2026, 9, 3, 23, 59, 59, 999).getTime() } });
  });

  it("stores a lasting preference as about-you without an end date", async () => {
    const msg = "我坐飞机都要靠过道";
    const p = await place(msg, reply(msg, "save", false, { longTerm: true, date: null, onlyThisTask: false, explicitRequest: false, dateIsTheTask: false }));

    expect(p).toMatchObject({ store: true, kind: "profile" });
    expect(p.store && p.validity).toBeFalsy();
  });

  it("does not remember a this-time-only task parameter", async () => {
    const msg = "这次先订经济舱";
    const p = await place(msg, reply(msg, "save", true, { longTerm: false, date: null, onlyThisTask: true, explicitRequest: false, dateIsTheTask: false }));

    expect(p.store).toBe(false);
  });

  it("stores a dated plan the user explicitly asks to remember", async () => {
    const msg = "记住我 10 月 3 日飞成都";
    const p = await place(msg, reply(msg, "save", false, { longTerm: false, date: "2026-10-03", onlyThisTask: false, explicitRequest: true, dateIsTheTask: false }));

    expect(p).toMatchObject({ store: true, kind: "past", date: "2026-10-03" });
  });

  it("stores an email given while filling a form as about-you", async () => {
    const msg = "帮我填表，我邮箱是 x@y.com";
    const p = await place(msg, reply(msg, "save", true, { longTerm: true, date: null, onlyThisTask: false, explicitRequest: false, dateIsTheTask: false }, "邮箱：x@y.com"));

    expect(p).toMatchObject({ store: true, kind: "profile" });
  });

  it("never stores a secret", async () => {
    const msg = "记住我的银行卡密码是 123456";
    const p = await place(msg, reply(msg, "save", false, { longTerm: true, date: null, onlyThisTask: false, explicitRequest: true, dateIsTheTask: false }));

    expect(p).toMatchObject({ store: false, kind: "secret" });
  });

  it("gives the model today's date with the correct weekday", async () => {
    let input = "";

    const complete: MemoryComplete = async (_system, i) => {
      input = i;

      return reply("你好", "none", false, { longTerm: false, date: null, onlyThisTask: false, explicitRequest: false });
    };

    await decideMemory(complete, "你好", [], null, new AbortController().signal, [], "auto");
    expect(JSON.parse(input).today).toBe("2026-10-01 星期四");
  });
});
