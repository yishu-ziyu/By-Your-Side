import { describe, expect, it } from "vitest";
import { completeSideText } from "../src/side-completion.js";

// 先列失败方式，再写实现：
// 1. 只有思考、被截断（length）：第一次预算被思考吃光，应立即用 8000 再来一次。
// 2. 只有思考、正常结束（stop）：同上。
// 3. 文本只有空白：算没有文本，同上。
// 4. 第二次仍没文本：抛现有的“记忆判断失败”，交给补判队列。
// 5. 第二次请求出错（error）：抛错。
// 6. 信号已中止：不重试。
// 7. 正常有文本：恰好一次请求，预算 1600。
// 8. 第一次出错/中止：照旧抛错，不重试。

type Part = { type: "text"; text: string } | { type: "thinking"; thinking: string };

type Reply = { stopReason: string; content: Part[] };


const think: Part = { type: "thinking", thinking: "hmm" };

const text = (t: string): Part => ({ type: "text", text: t });

const FAIL = "记忆判断失败，尚未修改记忆";

function fake(replies: Reply[], controller = new AbortController()) {
  const budgets: number[] = [];

  const run = (maxTokens: number) => {
    budgets.push(maxTokens);

    const next = replies[budgets.length - 1];

    if (!next) throw new Error("unexpected extra call");
    // 第一次回复后模拟用户中止：用于“信号已中止”用例。

    return Promise.resolve(next);
  };

  return { budgets, run, controller };
}

describe("侧调用：回复没有文本时放大预算重试一次", () => {
  it("只有思考且被截断：第二次用 8000 拿到文本", async () => {
    const f = fake([{ stopReason: "length", content: [think] }, { stopReason: "stop", content: [text('{"a":1}')] }]);
    await expect(completeSideText(f.run, f.controller.signal)).resolves.toBe('{"a":1}');
    expect(f.budgets).toEqual([1600, 8000]);
  });

  it("只有思考但正常结束：同样重试", async () => {
    const f = fake([{ stopReason: "stop", content: [think] }, { stopReason: "stop", content: [text("ok")] }]);
    await expect(completeSideText(f.run, f.controller.signal)).resolves.toBe("ok");
    expect(f.budgets).toEqual([1600, 8000]);
  });

  it("文本只有空白：算没有文本", async () => {
    const f = fake([{ stopReason: "stop", content: [text("  \n ")] }, { stopReason: "stop", content: [text("ok")] }]);
    await expect(completeSideText(f.run, f.controller.signal)).resolves.toBe("ok");
    expect(f.budgets.length).toBe(2);
  });

  it("第二次仍没文本：抛失败，不再继续请求", async () => {
    const f = fake([{ stopReason: "length", content: [think] }, { stopReason: "length", content: [think] }]);
    await expect(completeSideText(f.run, f.controller.signal)).rejects.toThrow(FAIL);
    expect(f.budgets.length).toBe(2);
  });

  it("第二次请求出错：抛失败", async () => {
    const f = fake([{ stopReason: "length", content: [think] }, { stopReason: "error", content: [] }]);
    await expect(completeSideText(f.run, f.controller.signal)).rejects.toThrow(FAIL);
    expect(f.budgets.length).toBe(2);
  });

  it("信号已中止：没文本也不重试", async () => {
    const f = fake([{ stopReason: "length", content: [think] }]);
    f.controller.abort();
    await expect(completeSideText(f.run, f.controller.signal)).rejects.toThrow(FAIL);
    expect(f.budgets.length).toBe(1);
  });

  it("正常有文本：只请求一次，预算 1600，多段文本用换行连接", async () => {
    const f = fake([{ stopReason: "stop", content: [think, text("a"), text("b")] }]);
    await expect(completeSideText(f.run, f.controller.signal)).resolves.toBe("a\nb");
    expect(f.budgets).toEqual([1600]);
  });

  it("第一次出错或被中止：照旧抛错，不重试", async () => {
    for (const stopReason of ["error", "aborted"]) {
      const f = fake([{ stopReason, content: [] }]);
      await expect(completeSideText(f.run, f.controller.signal)).rejects.toThrow(FAIL);
      expect(f.budgets.length).toBe(1);
    }
  });
});
