import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Motion Language 契约：3 个时长 + 3 条曲线，配 6 个动作动词。
 * 这套语法是产品手感的地基，散落的数值一旦回潮，整体又会变得"说不清哪里怪"。
 * 因此这里锁住 token、按压统一、以及四条落地动作的关键实现。
 */
const css = readFileSync(resolve(__dirname, "../src/sidepanel/styles.css"), "utf-8");
const mainTs = readFileSync(resolve(__dirname, "../src/sidepanel/main.ts"), "utf-8");
const cursorTs = readFileSync(resolve(__dirname, "../src/content/cursor.ts"), "utf-8");
const orbTs = readFileSync(resolve(__dirname, "../src/sidepanel/orb.ts"), "utf-8");

describe("Motion Language tokens", () => {
  it("3 个时长 + 3 条曲线齐全", () => {
    for (const token of ["--m-quick:", "--m-move:", "--m-morph:", "--e-swift:", "--e-spring:", "--e-glide:"]) {
      expect(css).toContain(token);
    }
  });

  it("旧的弹簧别名指向统一曲线，不再各自写值", () => {
    expect(css).toMatch(/--spring-bounce:\s*var\(--e-spring\)/);
    expect(css).toMatch(/--spring-fluid:\s*var\(--e-swift\)/);
  });
});

describe("01 press：所有可点控件同一种力度", () => {
  it("不再残留 0.86 / 0.94 / 0.96 的按压值", () => {
    expect(css).not.toMatch(/:active\s*\{[^}]*transform:\s*scale\(0\.86\)/);
    expect(css).not.toMatch(/:active\s*\{[^}]*transform:\s*scale\(0\.94\)/);
    expect(css).not.toMatch(/:active\s*\{[^}]*transform:\s*scale\(0\.96\)/);
  });

  it("按下走 quick+swift，松手回弹走 move+spring", () => {
    const sendActive = css.match(/#send-btn\.kinetic-morph-button:active\s*\{[^}]*\}/)?.[0] ?? "";
    expect(sendActive).toMatch(/scale\(0\.95\)/);
    expect(sendActive).toMatch(/transform var\(--m-quick\) var\(--e-swift\)/);
    const sendBase = css.match(/#send-btn\.kinetic-morph-button\s*\{[^}]*\}/)?.[0] ?? "";
    expect(sendBase).toMatch(/transform var\(--m-move\) var\(--e-spring\)/);
  });

  it("发送箭头用反相色，深色模式下不会写成浅底白图标", () => {
    const sendBase = css.match(/#send-btn\.kinetic-morph-button\s*\{[^}]*\}/)?.[0] ?? "";
    expect(sendBase).toMatch(/color:\s*var\(--content-bg\)/);
    expect(sendBase).not.toMatch(/color:\s*#fff/);
  });
});

describe("03 reveal：面板从触发它的按钮长出来", () => {
  it("展开走 move+swift，旧的回弹入场已移除", () => {
    expect(css).toMatch(/#model-popover\s*\{[^}]*animation:\s*modelPopoverIn var\(--m-move\) var\(--e-swift\)/);
    expect(css).not.toContain("popoverSpringIn");
  });

  it("缩放原点由按钮中点算出，且列表项只在展开那一次依次落位", () => {
    expect(mainTs).toMatch(/function alignModelPopoverOrigin/);
    expect(mainTs).toMatch(/function playPopoverOpening/);
    expect(css).toContain("#model-popover.opening .model-list > *");
  });
});

describe("04 settle：完成是收束，不是替换", () => {
  // 2026-09-11 用户批准的收敛：运行中不再有像素格等待态，状态行只留一个光球和耗时。
  it("finishRun 让状态行的球停下来、文案落定", () => {
    expect(mainTs).toMatch(/run\.orb\.setRunning\(false\)/);
    expect(mainTs).toMatch(/title\.textContent = "查看执行过程"/);
    expect(mainTs).not.toContain("px-wrap");
    expect(css).not.toContain(".px-grid");
  });

  it("chip 完成时点收束、耗时读数推入", () => {
    expect(mainTs).toMatch(/entry\.dot\.classList\.add\("settling"\)/);
    expect(css).toContain("@keyframes dotSettle");
    expect(css).toContain("@keyframes durIn");
  });
});

describe("06 trace：定位高亮出现→保持→消退", () => {
  it("高亮走三段节奏，不再是 500ms 内连消退一起播完", () => {
    expect(cursorTs).toMatch(/animation:\s*highlightTrace 1800ms/);
    expect(cursorTs).not.toContain("highlight-breathe");
    expect(cursorTs).toContain("@keyframes highlightTrace");
  });

  it("操作完成后标记消退，不原地长留", () => {
    expect(cursorTs).toMatch(/classList\.add\("fading"\)/);
    expect(cursorTs).toContain("@keyframes targetFade");
  });
});

describe("05 breathe：执行面板的光球", () => {
  const vendorJs = readFileSync(resolve(__dirname, "../src/vendor/thinking-orbs.js"), "utf-8");

  it("引擎按 MIT 原样 vendor，许可与来源都在", () => {
    expect(vendorJs).toContain("MIT License, Copyright (c) 2026 Jakub Antalik");
    expect(vendorJs).toContain("从 npm 包 dist/engine.es.js 原样拷入，未做任何修改");
    expect(vendorJs).toContain("export {");
    expect(existsSync(resolve(__dirname, "../src/vendor/thinking-orbs.LICENSE"))).toBe(true);
  });

  it("只认三个身份，且映射就是定稿的那三个", () => {
    expect(orbTs).toContain('"composing" | "solving" | "connecting"');
    expect(mainTs).toMatch(/createOrb\("composing"/);
    expect(mainTs).toMatch(/createOrb\("solving"/);
    expect(mainTs).toMatch(/createOrb\("connecting"/);
  });

  it("跑完定格：思考块收、chip 结束、折叠时都把球停下", () => {
    expect(mainTs).toMatch(/orbByHost\.get\(currentThinkingDetails\)\?\.setRunning\(false\)/);
    expect(mainTs).toMatch(/orbByHost\.get\(currentLeadDraftDetails\)\?\.setRunning\(false\)/);
    expect(mainTs).toMatch(/entry\.orb\.setRunning\(false\)/);
  });

  it("只有正在跑的球占 rAF，其余让出", () => {
    expect(orbTs).toMatch(/if \(anyLive\) raf = requestAnimationFrame\(tick\)/);
    expect(orbTs).toMatch(/const next = running && !prefersReduce\(\)/);
  });

  it("球有专用墨色——次要文字色会被 alpha 稀释到看不清", () => {
    expect(css).toContain("--orb-ink:");
    expect(orbTs).toMatch(/--orb-ink/);
  });

  it("历史回放不转：回放路径不点亮球", () => {
    expect(mainTs).toMatch(/if \(!applyingHistory\) orb\.setRunning\(true\)/);
    expect(mainTs).toMatch(/if \(!applyingHistory\) chipOrb\.setRunning\(true\)/);
  });
});

describe("07 live：运行中的那一步有生命（A+B）", () => {
  it("运行中的光球呼吸、结束收束，只用 transform/opacity", () => {
    expect(orbTs).toMatch(/canvas\.classList\.add\("orb-live"\)/);
    expect(orbTs).toMatch(/canvas\.classList\.add\("orb-settle"\)/);
    expect(orbTs).toMatch(/window\.setTimeout\(\(\) => canvas\.classList\.remove\("orb-settle"\)/);
    const live = css.match(/canvas\.orb-live\s*\{[^}]*\}/)?.[0] ?? "";
    const settle = css.match(/canvas\.orb-settle\s*\{[^}]*\}/)?.[0] ?? "";
    expect(live).toMatch(/animation:\s*orbBreathe/);
    expect(settle).toMatch(/animation:\s*orbSettle/);
    const breatheFrames = css.slice(css.indexOf("@keyframes orbBreathe"), css.indexOf("@keyframes orbBreathe") + 160);
    const settleFrames = css.slice(css.indexOf("@keyframes orbSettle"), css.indexOf("@keyframes orbSettle") + 160);
    expect(breatheFrames).toContain("scale(1)");
    expect(breatheFrames).toContain("scale(1.111)");
    expect(settleFrames).toContain("scale(1.111)");
    expect(settleFrames).toContain("scale(1)");
  });

  it("运行中思考行的竖线长出来并呼吸，落定后回到常态", () => {
    expect(css).toMatch(/details\.thinking::before\s*\{[^}]*background:\s*var\(--border\)[^}]*transform-origin:\s*top/);
    expect(css).toMatch(/details\.thinking\.streaming::before\s*\{[^}]*spineGrow[^}]*spineBreathe/);
    expect(css).toMatch(/@keyframes spineGrow/);
    expect(css).toMatch(/details\.thinking\.streaming summary\s*\{[^}]*color:\s*var\(--apple-blue\)/);
  });

  it("跑着的 chip 有运行态样式，跑完退回常态", () => {
    expect(css).toMatch(/\.chip\.running\s*\{[^}]*border-color:\s*color-mix/);
    expect(mainTs).toMatch(/if \(!applyingHistory\) chip\.classList\.add\("running"\)/);
    expect(mainTs).toMatch(/entry\.chip\.classList\.remove\("running"\)/);
  });

  it("文案落定是一次性的，不反向播放", () => {
    expect(mainTs).toMatch(/label\.classList\.add\("settle-once"\)/);
    expect(css).toMatch(/\.settle-once\s*\{[^}]*animation:\s*settleIn/);
  });

  it("减少动态时新动效全部关掉", () => {
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(/canvas\.orb-live/);
    expect(reduced).toMatch(/canvas\.orb-settle/);
    expect(reduced).toMatch(/details\.thinking\.streaming::before/);
    expect(reduced).toMatch(/\.settle-once/);
    expect(orbTs).toMatch(/const next = running && !prefersReduce\(\)/);
    expect(orbTs).toMatch(/if \(!prefersReduce\(\)\) \{/);
  });

  it("新增规则不写 transition: all", () => {
    for (const block of [css.match(/\.chip\.running\s*\{[^}]*\}/)?.[0] ?? "", css.match(/details\.thinking summary\s*\{[^}]*\}/)?.[0] ?? ""]) {
      expect(block).not.toContain("transition: all");
    }
  });
});
