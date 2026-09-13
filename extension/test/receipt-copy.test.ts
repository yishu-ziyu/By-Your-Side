import { describe, expect, it } from "vitest";
import { receiptCopy } from "../src/sidepanel/receipt-copy.js";
import type { TaskReceipt } from "../../shared/task-actions.js";
const base: TaskReceipt = {requestId:"r",conversationId:"c",source:"text",action:"start",runId:"run",text:"打开页面",targetTitle:"测试任务",status:"accepted",message:"已接收新任务：打开页面",updatedAt:1};
describe("receipt hierarchy", () => {
  it("keeps the original request inspectable without repeating it by default", () => {
    expect(receiptCopy(base,"c")).toEqual({summary:"任务已接收",detail:"测试任务 · 已接收新任务：打开页面",collapsed:true});
  });
  it.each(["rejected","failed","unknown"] as const)("keeps %s results visible", status => {
    expect(receiptCopy({...base,status,message:"尚未确认是否执行"},"c")).toMatchObject({summary:"尚未确认是否执行",collapsed:false});
  });
  it("does not hide a different conversation's target", () => {
    expect(receiptCopy(base,"other")).toMatchObject({summary:"测试任务 · 已接收新任务：打开页面",collapsed:false});
  });
  it("distinguishes queued correction from delivered correction", () => {
    expect(receiptCopy({...base,action:"steer",message:"修改已保存，继续后生效：打开页面"},"c").summary).toContain("交还后生效");
    expect(receiptCopy({...base,action:"steer",message:"修改已送达当前任务：打开页面"},"c").summary).toBe("修改已送达当前任务");
  });
});
