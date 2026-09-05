import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT } from "../src/prompt.js";

describe("Safety 段：一只手拿住（C 案）契约", () => {
  it("危险控件必须直接 click，执行层会拿住等确认", () => {
    expect(SYSTEM_PROMPT).toMatch(/click the CURRENT target directly/i);
    expect(SYSTEM_PROMPT).toMatch(/execution layer will hold/i);
    expect(SYSTEM_PROMPT).toMatch(/name pill/i);
  });

  it("禁止打开站点自身菜单冒充就地确认、禁止只圈不点", () => {
    expect(SYSTEM_PROMPT).toMatch(/Do NOT open the site's own menus/i);
    expect(SYSTEM_PROMPT).toMatch(/do NOT only circle the target without clicking/i);
  });

  it("不再出现「按钮在框外」的旧视觉描述", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/outside the box/i);
    expect(SYSTEM_PROMPT).not.toMatch(/outside the mark/i);
  });

  it("mark 必须圈当前目标，actions 契约保留", () => {
    expect(SYSTEM_PROMPT).toMatch(/mark must circle the current target/i);
    expect(SYSTEM_PROMPT).toContain('id:"confirm"');
    expect(SYSTEM_PROMPT).toContain('id:"cancel"');
  });

  it("包含 archive 与 归档 危险词提示", () => {
    expect(SYSTEM_PROMPT).toMatch(/archive/i);
    expect(SYSTEM_PROMPT).toContain("归档");
  });
});
