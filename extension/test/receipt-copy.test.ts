import { describe, expect, it } from "vitest";
import { receiptCopy } from "../src/sidepanel/receipt-copy.js";
import { isTaskReceipt, type TaskReceipt } from "../../shared/task-actions.js";

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
    expect(receiptCopy({...base,action:"steer",message:"修改已保存，继续后生效：打开页面"},"c").summary).toContain("点「交还」后生效");
    expect(receiptCopy({...base,action:"steer",message:"修改已送达当前任务：打开页面"},"c").summary).toBe("修改已送达当前任务");
  });
});

describe("T04 修改回执分层与差异展示", () => {
  it("applied steer 摘要明确已应用并核对，不冒充已完成原任务", () => {
    const receipt: TaskReceipt = {...base,action:"steer",status:"applied",message:"修改已直接应用并核对：译文已改成宋体。原任务继续。"};
    const copy = receiptCopy(receipt,"c");
    expect(copy.summary).toBe("修改已应用并核对");
    expect(copy.collapsed).toBe(true);
    expect(copy.summary).not.toContain("已完成");
  });
  it("有宿主差异时展示旧值→新值与读回核验的保留项", () => {
    const receipt: TaskReceipt = {...base,action:"steer",status:"applied",message:"修改已直接应用并核对：译文已改成宋体。原任务继续。",diff:{target:"文章",changed:[{attribute:"字体",from:"原字体",to:"宋体"}],preserved:["显示模式"]}};
    const copy = receiptCopy(receipt,"c");
    expect(copy.detail).toContain("文章：字体：原字体 → 宋体；显示模式保持不变");
  });
  it("没有差异依据时不伪造“保持不变”类描述", () => {
    const receipt: TaskReceipt = {...base,action:"steer",status:"accepted",message:"语音修改已送达当前任务：把预算改成600"};
    const copy = receiptCopy(receipt,"c");
    expect(copy.summary).toBe("修改已送达当前任务");
    expect(copy.detail).not.toContain("保持不变");
    expect(copy.detail).not.toContain("→");
  });
  it("旧回执（无 diff 字段）继续可校验、可渲染", () => {
    const legacy: TaskReceipt = {requestId:"old",conversationId:"c",source:"text",action:"steer",runId:null,text:"改字体",targetTitle:"旧任务",status:"accepted",message:"修改已送达当前任务",updatedAt:1};
    expect(isTaskReceipt(legacy)).toBe(true);
    expect(receiptCopy(legacy,"c").summary).toBe("修改已送达当前任务");
  });
  it("畸形 diff 不通过协议校验，不进回执通道", () => {
    const receipt: TaskReceipt = {...base,action:"steer",status:"applied",message:"x"};
    expect(isTaskReceipt({...receipt,diff:{target:"",changed:[{attribute:"字体",from:"原字体",to:"宋体"}],preserved:[]}})).toBe(false);
    expect(isTaskReceipt({...receipt,diff:{target:"页",changed:[],preserved:[]}})).toBe(false);
  });
});

// Failure cases: successful resume looks like a warning; failures disappear; another task's receipt is moved into this task.
describe("恢复回执的呈现归属", () => {
  it("本会话成功恢复进入过程，保留原始回执内容", () => {
    const message = "已从检查点继续原任务；先重新读取当前页面，再处理未完成项。";
    expect(receiptCopy({...base, action: "resume", message}, "c")).toMatchObject({
      summary: "已继续原任务", detail: expect.stringContaining(message), collapsed: false, inProcess: true,
    });
  });
  it.each(["failed", "rejected", "unknown"] as const)("恢复 %s 仍是可见反馈", status => {
    const copy = receiptCopy({...base, action: "resume", status, message: "尚未确认恢复"}, "c");
    expect(copy.collapsed).toBe(false);
    expect(copy.inProcess).not.toBe(true);
  });
  it("别的会话恢复不归到当前执行过程", () => {
    const copy = receiptCopy({...base, action: "resume"}, "other");
    expect(copy.collapsed).toBe(false);
    expect(copy.inProcess).not.toBe(true);
  });
});

describe("#103 停下只说一次", () => {
  it.each(["accepted","applied"] as const)("本会话停止 %s：不再另起一条「任务已终止」", status => {
    expect(receiptCopy({...base,action:"abort",status,message:"任务已终止。"},"c").collapsed).toBe(true);
  });
  it("停止失败照旧露出", () => {
    expect(receiptCopy({...base,action:"abort",status:"failed",message:"停止没成功"},"c").collapsed).toBe(false);
  });
});
