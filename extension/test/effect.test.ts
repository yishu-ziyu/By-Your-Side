import { describe, expect, it } from "vitest";
import {
  diffEffect,
  formatEffectReport,
  settleEffectReport,
  type EffectBaseline,
  type EffectReport,
  type EffectStats,
} from "../../shared/effect.js";

function base(over: Partial<EffectBaseline> = {}): EffectBaseline {
  return {
    els: 100,
    bodyKids: 5,
    active: "button#a",
    bodyTextLen: 1000,
    target: { gone: false, tag: "video", text: "暂停", value: "", checked: "false", selected: "", expanded: "false", disabled: "false", paused: "false", ended: "false", cls: "btn" },
    targetActive: false,
    scopeKids: 20,
    scopeTextLen: 200,
    alerts: [],
    volatile: false,
    ...over,
  };
}

function now(over: Partial<EffectStats> = {}): EffectStats {
  const { volatile: _volatile, ...rest } = base(over as Partial<EffectBaseline>);
  return rest;
}

const unchanged = (): EffectReport => ({ changed: false, evidence: [], weak: [], volatile: false, alerts: [] });

describe("动作效果证据：强/弱分级", () => {
  it("没有变化时不算有反应，也不编造证据", () => {
    const report = diffEffect(base(), now());
    expect(report).toEqual(unchanged());
  });

  it("目标自身状态变化是强证据（不改 DOM 节点数也算）", () => {
    const report = diffEffect(base(), now({ target: { ...base().target, expanded: "true" } }));
    expect(report.changed).toBe(true);
    expect(report.evidence).toContain("expanded false → true");
  });

  it("目标自身文本变化是强证据（暂停 → 播放这类改名）", () => {
    const report = diffEffect(base(), now({ target: { ...base().target, text: "播放" } }));
    expect(report.changed).toBe(true);
    expect(report.evidence).toContain('text 暂停 → 播放');
  });

  it("媒体状态变化是强证据（原生控件点击不改 DOM）", () => {
    const report = diffEffect(base(), now({ target: { ...base().target, paused: "true" } }));
    expect(report.changed).toBe(true);
    expect(report.evidence).toContain("paused false → true");
  });

  it("目标被移除是强证据", () => {
    const report = diffEffect(base(), now({ target: { gone: true, tag: "" } }));
    expect(report.changed).toBe(true);
    expect(report.evidence).toContain("target removed from the page");
  });

  it("新出现的页面提示是强证据（校验错误在长页面下方也抓得到）", () => {
    const report = diffEffect(base(), now({ alerts: ["手机号格式不正确"] }));
    expect(report.changed).toBe(true);
    expect(report.evidence.join(" ")).toContain("手机号格式不正确");
    expect(report.alerts).toEqual(["手机号格式不正确"]);
  });

  it("body 顶层增减算强证据（弹窗/抽屉/Toast）", () => {
    expect(diffEffect(base(), now({ bodyKids: 6 })).evidence.join(" ")).toContain("top level +1");
    expect(diffEffect(base(), now({ bodyKids: 4 })).evidence.join(" ")).toContain("top level -1");
  });

  it("目标区块节点数是强证据；区块文本变化在没有别的强证据时才算", () => {
    expect(diffEffect(base(), now({ scopeKids: 23 })).evidence.join(" ")).toContain("target region DOM +3");
    const textOnly = diffEffect(base(), now({ scopeTextLen: 229 }));
    expect(textOnly.changed).toBe(true);
    expect(textOnly.evidence.join(" ")).toContain("target region text +29");
  });

  it("全局数字只是弱证据：动了很多也不据此判 changed", () => {
    const report = diffEffect(base(), now({ els: 140, bodyTextLen: 1300 }));
    expect(report.changed).toBe(false);
    expect(report.weak).toEqual(["DOM +40 node(s)", "body text +300 char(s)"]);
  });

  it("正文小抖动不报（阈值 4 字）", () => {
    expect(diffEffect(base(), now({ bodyTextLen: 1003 })).weak).toEqual([]);
  });

  it("焦点落到被点元素自己不算证据，移到别处才算弱证据", () => {
    const self = diffEffect(base({ active: "button#a", targetActive: false }), now({ active: "button#a", targetActive: true }));
    expect(self).toEqual(unchanged());
    const moved = diffEffect(base(), now({ active: "input#email" }));
    expect(moved.changed).toBe(false);
    expect(moved.weak).toContain("focus → input#email");
  });

  it("页面自身在动时保留 volatile 标记，判定仍只认强证据", () => {
    const report = diffEffect(base({ volatile: true }), now({ els: 160 }));
    expect(report.changed).toBe(false);
    expect(report.volatile).toBe(true);
  });
});

describe("模型可见的回执文案", () => {
  it("有变化时给变化清单", () => {
    const text = formatEffectReport({ changed: true, evidence: ["expanded false → true"], weak: [], volatile: false, alerts: [] });
    expect(text).toContain("Page reacted");
    expect(text).toContain("expanded false → true");
  });

  it("无反应时明说归因失败并阻止盲目重试", () => {
    const text = formatEffectReport({ changed: false, evidence: [], weak: ["DOM +7 node(s)"], volatile: false, alerts: [] });
    expect(text).toContain("Nothing on the page changed");
    expect(text).toContain("Do not blindly click the same target again");
    expect(text).toContain("DOM +7 node(s)");
  });

  it("页面自己在动时换成对应措辞", () => {
    const text = formatEffectReport({ changed: false, evidence: [], weak: [], volatile: true, alerts: [] });
    expect(text).toContain("page itself keeps changing");
  });

  it("拿不到证据时不编文案", () => {
    expect(formatEffectReport(undefined)).toBe("");
  });
});

describe("早停轮询", () => {
  const run = async (poll: (n: number) => Promise<EffectReport | null | undefined>, timeoutMs = 600) => {
    let t = 0;
    const sleeps: number[] = [];
    let calls = 0;
    const report = await settleEffectReport(async () => poll(++calls), {
      now: () => t,
      sleep: async (ms) => { sleeps.push(ms); t += ms; },
      timeoutMs,
      intervalMs: 100,
    });
    return { report, sleeps, calls };
  };

  it("出现强证据立即返回，不再等满窗口", async () => {
    const { report, sleeps, calls } = await run(async (n) => (n >= 2
      ? { changed: true, evidence: ["checked false → true"], weak: [], volatile: false, alerts: [] }
      : unchanged()));
    expect(calls).toBe(2);
    expect(sleeps).toEqual([100]);
    expect(report?.evidence).toEqual(["checked false → true"]);
  });

  it("始终没有强证据时等到超时，返回最后一次读数", async () => {
    const { report, calls } = await run(async () => ({ ...unchanged(), weak: ["DOM +3 node(s)"] }));
    expect(calls).toBe(7);
    expect(report?.weak).toEqual(["DOM +3 node(s)"]);
    expect(report?.changed).toBe(false);
  });

  it("一次读数都取不到时返回 undefined，不把「拿不到」说成「没变化」", async () => {
    const { report } = await run(async () => null);
    expect(report).toBeUndefined();
  });
});
