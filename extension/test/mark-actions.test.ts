import { describe, expect, it } from "vitest";
import {
  confirmLabelForDestructive,
  isAffirmativeReply,
  isDestructiveLabel,
  isMarkActionId,
  markActionUserText,
  parseMarkActions,
} from "../src/shared/mark-actions.js";

describe("parseMarkActions", () => {
  it("抽出 confirm/cancel，confirm 排在前面，文案去空白截断", () => {
    expect(
      parseMarkActions([
        { id: "cancel", label: "  取消  " },
        { id: "confirm", label: `${"删".repeat(20)}` },
      ]),
    ).toEqual([
      { id: "confirm", label: "删".repeat(16) },
      { id: "cancel", label: "取消" },
    ]);
  });

  it("空、非数组、无有效项都当成没有按钮", () => {
    expect(parseMarkActions(undefined)).toBeUndefined();
    expect(parseMarkActions([])).toBeUndefined();
    expect(parseMarkActions([{ id: "ok", label: "好" }])).toBeUndefined();
    expect(parseMarkActions([{ id: "confirm", label: "   " }])).toBeUndefined();
  });

  it("同 id 只留第一条，最多两个", () => {
    expect(
      parseMarkActions([
        { id: "confirm", label: "删除" },
        { id: "confirm", label: "真删" },
        { id: "cancel", label: "取消" },
        { id: "cancel", label: "返回" },
      ]),
    ).toEqual([
      { id: "confirm", label: "删除" },
      { id: "cancel", label: "取消" },
    ]);
  });
});

describe("markActionUserText", () => {
  it("点删除/取消与侧栏「确认」「取消」同一句话", () => {
    expect(markActionUserText("confirm")).toBe("确认");
    expect(markActionUserText("cancel")).toBe("取消");
    expect(isMarkActionId("confirm")).toBe(true);
    expect(isMarkActionId("delete")).toBe(false);
  });
});

describe("isDestructiveLabel", () => {
  it("删除 / 清空 / 支付 / 发送 及对应英文要拦", () => {
    for (const t of ["删除", "删除笔记", "清空", "清空回收站", "支付", "发送", "Delete", "Remove item", "Pay now", "Send"]) {
      expect(isDestructiveLabel(t), t).toBe(true);
    }
  });

  it("分享 / 编辑 / 更多 / payload 不拦", () => {
    for (const t of ["分享", "编辑", "更多", "复制", "payload", "payday", "sender", ""]) {
      expect(isDestructiveLabel(t), t).toBe(false);
    }
  });
});

describe("confirmLabelForDestructive", () => {
  it("按钮文案跟动作走", () => {
    expect(confirmLabelForDestructive("删除笔记")).toBe("删除");
    expect(confirmLabelForDestructive("清空回收站")).toBe("清空");
    expect(confirmLabelForDestructive("支付")).toBe("支付");
    expect(confirmLabelForDestructive("发送")).toBe("发送");
    expect(confirmLabelForDestructive("Delete file")).toBe("Delete");
  });
});

describe("isAffirmativeReply", () => {
  it("确认 / 是 / 继续 算放行", () => {
    expect(isAffirmativeReply("确认")).toBe(true);
    expect(isAffirmativeReply("是")).toBe(true);
    expect(isAffirmativeReply("继续")).toBe(true);
    expect(isAffirmativeReply("yes")).toBe(true);
  });

  it("含糊回复不算放行", () => {
    expect(isAffirmativeReply("嗯")).toBe(false);
    expect(isAffirmativeReply("好吧")).toBe(false);
    expect(isAffirmativeReply("取消")).toBe(false);
  });
});
