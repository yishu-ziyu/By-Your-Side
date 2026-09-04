import { describe, expect, it } from "vitest";
import {
  StepChain,
  chipState,
  describeTool,
  formatDuration,
  loaderSubtitle,
  pixelDelay,
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
    expect(describeTool("mystery_tool", {}).full).toBe("mystery_tool");
  });
  it("并行工人工具中文名", () => {
    expect(describeTool("spawn_worker", { id: "wiki" }).full).toBe("派出工人 wiki");
    expect(describeTool("post", { to: "feishu", kind: "notes" }).full).toBe("投递 notes → feishu");
    expect(describeTool("await_message", { kind: "notes" }).full).toBe("等待「notes」");
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

describe("pixelDelay 像素格相位波纹", () => {
  it("按 (x+y)*0.12s 错相", () => {
    expect(pixelDelay(0)).toBe(0);
    expect(pixelDelay(1)).toBeCloseTo(0.12);
    expect(pixelDelay(5)).toBeCloseTo(0.12); // 第二行第一列 x=0,y=1
    expect(pixelDelay(24)).toBeCloseTo(0.96); // 右下角 x=4,y=4
  });
});
