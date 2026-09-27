import { describe, expect, it } from "vitest";
import { asksConfirmBeforeSubmit, asksUser, claimsUnfinished, pageAwaitsEmailStep } from "../src/goal-check.js";

// 例句取自 2026-09-27 智谱真实验收的回答原文（out/acceptance/memory-proactive/）。
describe("目标核对：助手在问用户时一律等用户，不自动接着做", () => {
  it("结尾在问是否提交：等用户（哪怕问句后还有一句说明）", () => {
    expect(asksUser("邮箱已填好 yishu.test@gmail.com，接下来就差点击 SIGN UP 提交了。按你的要求先跟你确认：**要我现在点 SIGN UP 提交订阅吗？**回复\"确认\"我就提交。")).toBe(true);
    expect(asksUser("已填入 yishu.test@gmail.com，即将点击 SIGN UP 提交。请确认是否继续？")).toBe(true);
    expect(asksUser("Should I submit now?")).toBe(true);
    expect(asksUser("页面有个订阅表单（邮箱输入框 + SIGN UP 按钮），但我不知道你的邮箱地址——请把你想用来订阅的邮箱发我，我填好后会在点 SIGN UP 前给你确认。")).toBe(true);
  });

  it("把能自己做的事甩给用户、或已做完：不算在问", () => {
    expect(asksUser("订阅已提交成功！页面显示确认邮件已发到 yishu.test@gmail.com，去邮箱点一下里面的确认链接就完成订阅了。")).toBe(false);
    expect(asksUser("搞定！我打开了 Gmail 里的确认邮件，点进 \"Confirm subscription\" 链接，页面现在显示 Subscribed。")).toBe(false);
  });
});

describe("用户原话要求提交前确认：宿主据此拿住提交类点击", () => {
  it("常见说法都认得", () => {
    for (const t of ["帮我订阅这个页面的邮件，提交前让我确认。", "请帮我填写当前页面的表单，提交前让我确认。", "填好先给我看一下", "发送前问我一下", "Fill the form but ask me before you submit"]) expect(asksConfirmBeforeSubmit(t), t).toBe(true);
  });

  it("没提这个条件的不拦", () => {
    for (const t of ["帮我订阅这个页面的邮件", "直接提交吧", "我之前让你订阅过哪些邮件列表？", "现在应该到了，你再去看看"]) expect(asksConfirmBeforeSubmit(t), t).toBe(false);
  });
});

describe("停在「请去邮箱点确认链接」的页面：下一步明确在邮箱里", () => {
  it("订阅站的提交后页面算", () => {
    expect(pageAwaitsEmailStep("Almost there! We've sent a confirmation email to yishu.test@gmail.com. Please click the link in that email to confirm your subscription.")).toBe(true);
    expect(pageAwaitsEmailStep("注册成功，确认邮件已发送至你的邮箱，请查收。")).toBe(true);
  });

  it("收件箱、确认完成页、普通页面不算", () => {
    for (const t of ["Inbox (3) - yishu.test@gmail.com - Gmail Tidy Shop — Your order #4471 has shipped", "You're subscribed! Welcome to the Marianne Beaulieu mailing list", "Marianne Beaulieu Singer-songwriter from Montréal. Join the mailing list"]) expect(pageAwaitsEmailStep(t), t).toBe(false);
  });
});

describe("回答自己说还没做成：核对不能判做完", () => {
  it("09-27 智谱原话：确认邮件还没送达", () => {
    expect(claimsUnfinished("订阅表单已提交成功。但我打开 Gmail 检查了收件箱、搜索和垃圾邮件，等了约半分钟，确认邮件目前还没送达，所以还没能点确认链接。")).toBe(true);
  });

  it("真做完的回答不算", () => {
    expect(claimsUnfinished("搞定！我打开了 Gmail 里的确认邮件，点进 \"Confirm subscription\" 链接，页面现在显示 Subscribed。")).toBe(false);
  });
});
