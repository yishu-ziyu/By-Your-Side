import { describe, expect, it } from "vitest";
import { BrowserAgentSession } from "../src/session.js";
import { ToolRpc, type ToolCallFrame } from "../src/rpc.js";
import { createBrowserTools } from "../src/tools.js";

/**
 * 发送时的 context.tabId 是这次任务的缺省页面：缺省读写不随之后的 active 切页漂移。
 * 事实来源：~/.sideagent/traces/1789274847140-ffca25eb-e464-4e4a-b356-8c06230ea096.jsonl
 * （B 页发送、pre_observation 读 B，首次 browser_run 却读并点了 A）。
 */
function makeRpc() {
  const sent: ToolCallFrame[] = [];
  const rpc = new ToolRpc((frame) => sent.push(frame));
  return { rpc, sent };
}

describe("default page target", () => {
  it("fills the missing tabId with the page the user sent from", () => {
    const { rpc, sent } = makeRpc();
    rpc.setPageTarget(undefined, 29960189);
    void rpc.call("snapshot", {}).catch(() => {});
    expect(sent[0]!.params).toEqual({ tabId: 29960189 });
  });

  it("keeps an explicit tabId and never overrides the caller", () => {
    const { rpc, sent } = makeRpc();
    rpc.setPageTarget(undefined, 29960189);
    void rpc.call("snapshot", { tabId: 111, scope: "viewport" }).catch(() => {});
    expect(sent[0]!.params).toEqual({ tabId: 111, scope: "viewport" });
  });

  it("does not inject into global management tools", () => {
    const { rpc, sent } = makeRpc();
    rpc.setPageTarget(undefined, 29960189);
    void rpc.call("list_tabs", {}).catch(() => {});
    void rpc.call("get_active_tab", {}).catch(() => {});
    void rpc.call("worker_tabs", { action: "inspect" }).catch(() => {});
    expect(sent.map((frame) => frame.params)).toEqual([{}, {}, { action: "inspect" }]);
  });

  it("isolates the default page per session", () => {
    const { rpc, sent } = makeRpc();
    rpc.setPageTarget(undefined, 29960189);
    rpc.setPageTarget("worker-1", 29960182);
    void rpc.call("snapshot", {}).catch(() => {});
    void rpc.call("snapshot", {}, undefined, "worker-1").catch(() => {});
    expect(sent[0]!.params).toEqual({ tabId: 29960189 });
    expect(sent[1]!.params).toEqual({ tabId: 29960182 });
    expect(sent[1]!.sessionId).toBe("worker-1");
  });

  it("keeps the closed target instead of falling back to the active page", async () => {
    const { rpc, sent } = makeRpc();
    rpc.setPageTarget(undefined, 29960189);
    const closed = rpc.call("snapshot", {});
    rpc.handleResult(sent[0]!.id, false, undefined, "No tab with id: 29960189.");
    await expect(closed).rejects.toThrow(/No tab with id/);
    // 下一次缺省调用仍然点名 B；扩展无法把它落到当前活动页 A。
    void rpc.call("snapshot", {}).catch(() => {});
    expect(sent[1]!.params).toEqual({ tabId: 29960189 });
    expect(rpc.getPageTarget(undefined)).toBe(29960189);
  });

  it("follows a successful explicit switch and ignores a failed one", async () => {
    const { rpc, sent } = makeRpc();
    rpc.setPageTarget(undefined, 29960189);
    const ok = rpc.call("switch_tab", { tabId: 29960182 });
    rpc.handleResult(sent[0]!.id, true, { tabId: 29960182 });
    await expect(ok).resolves.toEqual({ tabId: 29960182 });
    expect(rpc.getPageTarget(undefined)).toBe(29960182);

    const failed = rpc.call("switch_tab", { tabId: 111 });
    rpc.handleResult(sent[1]!.id, false, undefined, "No tab with id: 111.");
    await expect(failed).rejects.toThrow();
    expect(rpc.getPageTarget(undefined)).toBe(29960182);
    void rpc.call("snapshot", {}).catch(() => {});
    expect(sent[2]!.params).toEqual({ tabId: 29960182 });
  });

  it("follows a successful open_tab and a successful worker_tabs claim", async () => {
    const { rpc, sent } = makeRpc();
    rpc.setPageTarget(undefined, 29960189);
    const opened = rpc.call("open_tab", { url: "https://example.com" });
    rpc.handleResult(sent[0]!.id, true, { tabId: 555, url: "https://example.com", title: "t" });
    await expect(opened).resolves.toMatchObject({ tabId: 555 });
    expect(rpc.getPageTarget(undefined)).toBe(555);

    const claimed = rpc.call("worker_tabs", { action: "claim", tabId: 777 });
    rpc.handleResult(sent[1]!.id, true, { tabId: 777, workers: [] });
    await expect(claimed).resolves.toMatchObject({ tabId: 777 });
    expect(rpc.getPageTarget(undefined)).toBe(777);

    // inspect 是查询：成功后不改缺省页。
    const inspect = rpc.call("worker_tabs", { action: "inspect" });
    rpc.handleResult(sent[2]!.id, true, { tabId: 999, workers: [] });
    await inspect;
    expect(rpc.getPageTarget(undefined)).toBe(777);
  });

  it("does not move the default page when another page is read explicitly", async () => {
    const { rpc, sent } = makeRpc();
    rpc.setPageTarget(undefined, 29960189);
    const read = rpc.call("snapshot", { tabId: 29960182 });
    rpc.handleResult(sent[0]!.id, true, { text: "A", tabId: 29960182 });
    await read;
    expect(rpc.getPageTarget(undefined)).toBe(29960189);
    void rpc.call("snapshot", {}).catch(() => {});
    expect(sent[1]!.params).toEqual({ tabId: 29960189 });
  });

  it("lets a newer default survive a late-arriving switch result", async () => {
    const { rpc, sent } = makeRpc();
    rpc.setPageTarget(undefined, 29960189);
    const stale = rpc.call("switch_tab", { tabId: 222 });
    // 旧调用还在途中，用户已经发起了针对 B 的新任务。
    rpc.setPageTarget(undefined, 29960189);
    rpc.handleResult(sent[0]!.id, true, { tabId: 222 });
    await expect(stale).resolves.toEqual({ tabId: 222 });
    expect(rpc.getPageTarget(undefined)).toBe(29960189);

    // 反向：旧缺省页的晚到失败回执也不能清掉新设置。
    const staleFail = rpc.call("switch_tab", { tabId: 333 });
    rpc.setPageTarget(undefined, 444);
    rpc.handleResult(sent[1]!.id, false, undefined, "No tab with id: 333.");
    await expect(staleFail).rejects.toThrow();
    expect(rpc.getPageTarget(undefined)).toBe(444);
  });

  it("applies a late switch result when nothing newer was set", async () => {
    const { rpc, sent } = makeRpc();
    rpc.setPageTarget(undefined, 29960189);
    const late = rpc.call("switch_tab", { tabId: 222 });
    rpc.handleResult(sent[0]!.id, true, { tabId: 222 });
    await late;
    expect(rpc.getPageTarget(undefined)).toBe(222);
  });
});

describe("session sets the task default page", () => {
  function sessionWith(rpc: ToolRpc, streaming: boolean) {
    const prompts: string[] = [];
    const steers: string[] = [];
    const fake = {
      model: { id: "fake" },
      isStreaming: streaming,
      prompt: async (text: string) => { prompts.push(text); },
      steer: async (text: string) => { steers.push(text); },
    };
    const session = new (BrowserAgentSession as any)(
      fake, null, { emit: () => {}, setStatus: () => {} }, null, null, 30_000, null, rpc,
    );
    return { session, prompts, steers };
  }

  const autoRpc = () => {
    const sent: ToolCallFrame[] = [];
    const rpc = new ToolRpc((frame) => {
      sent.push(frame);
      queueMicrotask(() => rpc.handleResult(frame.id, true, { text: "page text", tabId: frame.params.tabId }));
    });
    return { rpc, sent };
  };

  it("adopts the page the user sent from and keeps unqualified reads there", async () => {
    const { rpc, sent } = autoRpc();
    const { session, prompts } = sessionWith(rpc, false);
    session.sendUserMessage("只操作当前B测试页", { tabId: 29960189, title: "B", url: "http://x/?scenario=b" });
    expect(rpc.getPageTarget(undefined)).toBe(29960189);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prompts).toHaveLength(1);
    // 用户随后切到 A：模型不带 tabId 的读取仍然落在 B。
    void rpc.call("snapshot", {}).catch(() => {});
    expect(sent.at(-1)!.params).toEqual({ tabId: 29960189 });
  });

  it("keeps the default page when a plain in-flight correction carries the active page", async () => {
    const { rpc } = autoRpc();
    const { session } = sessionWith(rpc, true);
    rpc.setPageTarget(undefined, 29960189);
    await session.steerCurrentTask("预算改成 200", { tabId: 111, title: "A", url: "http://x/?scenario=a" });
    expect(rpc.getPageTarget(undefined)).toBe(29960189);
  });
});

describe("default page reaches both tool paths", () => {
  const toolRpc = () => {
    const sent: ToolCallFrame[] = [];
    const rpc = new ToolRpc((frame) => {
      sent.push(frame);
      queueMicrotask(() => rpc.handleResult(frame.id, true, { text: "page text", tabId: frame.params.tabId ?? 0, clicked: true }));
    });
    return { rpc, sent };
  };

  it("fills the default page inside browser_run substeps and in plain tool calls", async () => {
    const { rpc, sent } = toolRpc();
    rpc.setPageTarget(undefined, 29960189);
    const tools = createBrowserTools(rpc, undefined, undefined, () => true, { epoch: () => 0, canWrite: () => true });
    const program = tools.find((tool) => tool.name === "browser_run")!;
    await program.execute("program-1", {
      code: 'const s = await browser.snapshot(); await browser.click({target:"#a"}); return { text: s.text };',
    }, undefined, undefined, {} as never);
    expect(sent.find((frame) => frame.name === "snapshot")!.params).toEqual({ tabId: 29960189 });
    // 直接动作也接收固定目标，不能只修读取。
    expect(sent.find((frame) => frame.name === "click")!.params).toEqual({ target: "#a", tabId:29960189 });

    const read = tools.find((tool) => tool.name === "read_element")!;
    await read.execute("call-1", { target: "body" }, undefined, undefined, {} as never);
    expect(sent.find((frame) => frame.name === "read_element")!.params).toEqual({ target: "body", tabId: 29960189 });
  });
});


it("点击后已跟随的新标签成为后续缺省目标",async()=>{
  const {rpc,sent}=makeRpc();rpc.setPageTarget(undefined,91);
  const click=rpc.call("click",{target:"#link"});
  rpc.handleResult(sent[0]!.id,true,{clicked:true,newTab:{tabId:92}});await click;
  expect(rpc.getPageTarget()).toBe(92);
});
