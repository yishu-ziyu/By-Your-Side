import { describe, expect, it } from "vitest";
import {
  StepChain,
  chipState,
  describeTool,
  formatDuration,
  loaderSubtitle,
  openedPageTitle,
  recentSteps,
  betweenStepsTitle,
  workerEventRunPolicy,
  isLiveViewportPinned,
  liveViewportOverflows,
} from "../src/sidepanel/steps.js";

describe("describeTool 人性化动作描述", () => {
  it("click 带 label 参数", () => {
    expect(describeTool("click", { label: "开始学习" }).full).toBe("点击「开始学习」");
    expect(describeTool("click", { target: "@3" }).full).toBe("点击元素");
  });
  it("navigate/open_tab 提取 url 域名", () => {
    expect(describeTool("navigate", { url: "https://console.cloud.google.com/billing" }).full).toBe(
      "打开页面 console.cloud.google.com",
    );
    expect(describeTool("open_tab", { url: "example.com/path" }).full).toBe("打开标签页 example.com");
    expect(describeTool("navigate", {}).full).toBe("打开页面");
  });
  it("mark 带 label，press_key 带键名", () => {
    expect(describeTool("mark", { label: "搜索框" }).full).toBe("标注「搜索框」");
    expect(describeTool("press_key", { key: "Enter" }).full).toBe("按键「Enter」");
  });
  it("静态动作名与未知工具回退", () => {
    expect(describeTool("snapshot", {}).full).toBe("读取页面结构");
    expect(describeTool("clear_marks", {}).full).toBe("清除标注");
    // 没登记的工具不露原始名
    expect(describeTool("mystery_tool", {}).full).toBe("处理这一步");
    expect(describeTool("fetch", {}).full).toBe("发送网络请求");
    expect(describeTool("ask_user_to_point", {}).full).toBe("等你在页面上点选");
  });
  it("并行请人：创建前不猜名字，等待不暴露协议类别", () => {
    const spawn = describeTool("spawn_worker", { id: "wiki" }).full;
    expect(spawn).toBe("安排助手");
    expect(spawn).not.toMatch(/工人/);
    expect(describeTool("post", { to: "feishu", kind: "notes" }).full).toMatch(/^发送消息给 /);
    expect(describeTool("post", { to: "feishu", kind: "notes" }).full).not.toMatch(/工人/);
    expect(describeTool("await_message", { kind: "notes" }).full).toBe("等待助手结果");
    expect(describeTool("stop_worker", { id: "wiki" }).full).toMatch(/^让 .+ 停下$/);
  });
  it("超长 label 截断", () => {
    const long = "这是一个非常非常非常长的按钮标签文字";
    expect(describeTool("click", { label: long }).full.length).toBeLessThan(long.length + 4);
  });
});

describe("StepChain 步骤链", () => {
  it("相邻重复去重", () => {
    const c = new StepChain();
    c.push("思考");
    c.push("思考");
    c.push("读取页面结构");
    c.push("思考");
    expect(c.render()).toBe("思考 → 读取页面结构 → 思考");
  });
  it("超长只保留最近几步并加省略前缀", () => {
    const c = new StepChain();

    for (const s of ["思考", "点击", "滚动页面", "思考", "截图"]) c.push(s);
    expect(c.render(3)).toBe("… → 思考 → 思考 → 截图".replace("思考 → 思考", "滚动页面 → 思考"));
  });
  it("空链渲染为空串", () => {
    expect(new StepChain().render()).toBe("");
  });
});

describe("formatDuration 耗时格式化", () => {
  it("小于 10s 一位小数", () => {
    expect(formatDuration(1400)).toBe("1.4s");
    expect(formatDuration(300)).toBe("0.3s");
  });
  it("10-60s 整数秒", () => {
    expect(formatDuration(12_000)).toBe("12s");
  });
  it("超过一分钟用 m s", () => {
    expect(formatDuration(148_000)).toBe("2m 28s");
  });
  it("负值钳到 0", () => {
    expect(formatDuration(-5)).toBe("0.0s");
  });
});

describe("chipState chip 状态映射", () => {
  it("未结束一律运行中", () => {
    expect(chipState(false, false)).toBe("running");
    expect(chipState(false, true)).toBe("running");
  });
  it("结束后按 isError 分完成/失败", () => {
    expect(chipState(true, false)).toBe("done");
    expect(chipState(true, true)).toBe("error");
  });
});

describe("loaderSubtitle 当前动作副标题", () => {
  it("有最近工具用其中文动作名", () => {
    expect(loaderSubtitle("读取页面结构")).toBe("读取页面结构");
  });
  it("尚无工具回退「思考」", () => {
    expect(loaderSubtitle(null)).toBe("思考");
  });
});

describe("workerEventRunPolicy 结束后不得开新处理中块", () => {
  it("当前 run 还在，工人事件进当前块", () => {
    expect(workerEventRunPolicy({ hasCurrentRun: true, graphRunning: true, hasLastRun: false })).toBe("current");
    expect(workerEventRunPolicy({ hasCurrentRun: true, graphRunning: false, hasLastRun: true })).toBe("current");
  });
  it("图还在跑但 currentRun 被收掉了，允许新建", () => {
    expect(workerEventRunPolicy({ hasCurrentRun: false, graphRunning: true, hasLastRun: true })).toBe("new");
  });
  it("全员 idle 后的 agent_end 复用刚收掉的块，不开新 loader", () => {
    expect(workerEventRunPolicy({ hasCurrentRun: false, graphRunning: false, hasLastRun: true })).toBe("reuse-last");
  });
  it("没有 run 也没有图，丢弃", () => {
    expect(workerEventRunPolicy({ hasCurrentRun: false, graphRunning: false, hasLastRun: false })).toBe("drop");
  });
});

// Layout is exercised in scripts/acceptance/steps-layout.mts against Chromium computed geometry.

describe("执行中过程视窗限高", () => {
  it("钉在底部才跟，离开底部则停", () => {
    expect(isLiveViewportPinned(400, 500, 100)).toBe(true);
    expect(isLiveViewportPinned(200, 500, 100)).toBe(false);
    expect(liveViewportOverflows(400, 320)).toBe(true);
    expect(liveViewportOverflows(200, 320)).toBe(false);
  });

});

// #102 进行中看得见进展：页面名、最近几步、动作之间的标题。
describe("openedPageTitle 打开页面后取页面标题", () => {
  it("程序里的 navigate：结果是 JSON", () => {
    expect(openedPageTitle('{"url":"http://127.0.0.1:53623/company/lumen","title":"Lumen 光子 · 公司资料","readiness":"complete"}')).toBe("Lumen 光子 · 公司资料");
  });
  it("单独的 navigate：结果是一行说明加快照", () => {
    expect(openedPageTitle("Navigation result: https://hamel.dev/blog/posts/evals-faq/ — AI Evals FAQ; document: complete\n\nFresh snapshot …")).toBe("AI Evals FAQ");
  });
  it("JSON 被截断、标题含转义引号也能取到", () => {
    expect(openedPageTitle('{"url":"https://a.test/","title":"他说 \\"好\\" 的那页","readiness":"comp')).toBe('他说 "好" 的那页');
  });
  it("没有标题、空标题、标题就是网址时不给（沿用域名）", () => {
    expect(openedPageTitle('{"url":"https://a.test/","readiness":"complete"}')).toBeNull();
    expect(openedPageTitle('{"url":"https://a.test/","title":"  "}')).toBeNull();
    expect(openedPageTitle('{"url":"https://a.test/x","title":"https://a.test/x"}')).toBeNull();
    expect(openedPageTitle("Navigation timed out")).toBeNull();
    expect(openedPageTitle("")).toBeNull();
  });
  it("超长标题截短", () => {
    const t = openedPageTitle(`{"title":"${"长".repeat(80)}"}`);
    expect(t?.length).toBeLessThanOrEqual(30);
    expect(t?.endsWith("…")).toBe(true);
  });
});

describe("recentSteps 进行中只露最近 3 步", () => {
  const step = (n: number) => ({ text: `第${n}步`, dur: "0.5s", failed: false });
  it("不足 3 步全露，没有「前面」", () => {
    expect(recentSteps([step(1), step(2)])).toEqual({ shown: [step(1), step(2)], earlier: 0 });
    expect(recentSteps([])).toEqual({ shown: [], earlier: 0 });
  });
  it("超过 3 步只露最后 3 步，其余计数", () => {
    expect(recentSteps([step(1), step(2), step(3), step(4), step(5)])).toEqual({ shown: [step(3), step(4), step(5)], earlier: 2 });
  });
});

describe("betweenStepsTitle 两步之间的标题", () => {
  it("还没做事时就是「正在思考」", () => {
    expect(betweenStepsTitle(0)).toBe("正在思考");
  });
  it("做过事后带上进度，不退回光秃秃的「正在思考」", () => {
    expect(betweenStepsTitle(3)).toBe("正在思考 · 已做 3 件事");
  });
});
