import { describe, expect, it } from "vitest";
import { createBrowserTools } from "../src/tools.js";

/** 按方法名回应的假宿主：navigate 只回网址与就绪状态，snapshot 回页面文字。 */
function programTool(readiness: "interactive" | "timeout", calls: string[]) {
  const rpc: any = {
    call: async (name: string) => {
      calls.push(name);

      if (name === "navigate") return { url: "https://example.com/a", title: "A", readiness };

      if (name === "snapshot") return { text: "heading \"公司 A\"", tabId: 7 };

      return {};
    },
  };

  const tools = createBrowserTools(rpc, undefined, undefined, undefined, { epoch: () => 0, canWrite: () => true, assertCall: () => {} });

  return tools.find((tool) => tool.name === "browser_run")!;
}

/** 执行 browser_run 程序，返回工具结果（details.value 是程序返回值）。 */
function runProgram(readiness: "interactive" | "timeout", calls: string[], code: string) {
  // SAFETY: browser_run 的 execute 不读第五个参数（扩展上下文），空对象只占位。
  return programTool(readiness, calls).execute("call-1", { code }, new AbortController().signal, undefined, {} as never);
}

describe("程序里的 browser.navigate 与直调一致：就绪后带回新页面文字", () => {
  it("页面就绪时，navigate 的结果里有 text，程序不必再调 snapshot", async () => {
    const calls: string[] = [];
    const result = await runProgram("interactive", calls, "return (await browser.navigate({url:'https://example.com/a'})).text;");
    expect(result.details).toMatchObject({ value: 'heading "公司 A"' });
  });

  it("页面超时时不补读，结果里没有 text", async () => {
    const calls: string[] = [];
    const result = await runProgram("timeout", calls, "const r = await browser.navigate({url:'https://example.com/a'}); return { readiness: r.readiness, text: r.text ?? null };");
    expect(result.details).toMatchObject({ value: { readiness: "timeout", text: null } });
    expect(calls).not.toContain("snapshot");
  });
});
