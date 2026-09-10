import { describe, expect, it } from "vitest";
import {
  candidates, defaultIntent, describePattern, hasSensitiveAnchor, isSensitiveHost, mergeRun,
  shouldPropose, signatureOf, trimPatterns, worthObserving, MAX_HOSTS,
  type ObservedPattern, type ObservedRun,
} from "../../shared/observe.js";
import type { DemoAnchor } from "../../shared/demo-record.js";

const click = (name: string, tag = "a"): DemoAnchor => ({ tag, name });
const run = (hostname: string, anchors: DemoAnchor[], at: number): ObservedRun => ({ hostname, anchors, at });
const DAY = 24 * 60 * 60 * 1000;

describe("骨架与签名", () => {
  it("签名只由点了什么决定，和顺序有关；没名字的点不参与", () => {
    expect(signatureOf([click("筛选"), click("第一条记录")])).toBe("a|筛选>a|第一条记录");
    expect(signatureOf([click("第一条记录"), click("筛选")])).not.toBe(signatureOf([click("筛选"), click("第一条记录")]));
    expect(signatureOf([click("筛选"), { tag: "div" }])).toBe("a|筛选");
  });

  it("太短的不算任务：至少两步", () => {
    expect(worthObserving(run("x.com", [click("A")], 0))).toBe(false);
    expect(worthObserving(run("x.com", [click("A"), click("B")], 0))).toBe(true);
  });

  it("敏感站点不观察；空站点名也当敏感", () => {
    expect(isSensitiveHost("mail.google.com")).toBe(true);
    expect(isSensitiveHost("www.bankofchina.com")).toBe(true);
    expect(isSensitiveHost("alipay.com")).toBe(true);
    expect(isSensitiveHost("mail.qq.com")).toBe(true);
    expect(isSensitiveHost("localhost")).toBe(true);
    expect(isSensitiveHost("")).toBe(true);
    expect(isSensitiveHost("www.bilibili.com")).toBe(false);
    expect(isSensitiveHost("app.example.com")).toBe(false);
  });

  it("带密码的骨架整条丢掉", () => {
    expect(hasSensitiveAnchor([click("登录"), { tag: "input", inputType: "password" }])).toBe(true);
    expect(hasSensitiveAnchor([click("登录")])).toBe(false);
  });
});

describe("重复检测", () => {
  it("做过三次且跨两天才值得问", () => {
    let patterns: ObservedPattern[] = [];
    const anchors = [click("筛选"), click("第一条记录")];
    patterns = mergeRun(patterns, run("x.com", anchors, 0));
    patterns = mergeRun(patterns, run("x.com", anchors, DAY));
    expect(candidates(patterns)).toHaveLength(0);   // 才两次
    patterns = mergeRun(patterns, run("x.com", anchors, 3 * DAY));
    const found = candidates(patterns);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ hostname: "x.com", count: 3 });
  });

  it("三次都在同一天不算：频率不等于习惯", () => {
    let patterns: ObservedPattern[] = [];
    const anchors = [click("筛选"), click("第一条记录")];
    for (const at of [0, 60_000, 120_000]) patterns = mergeRun(patterns, run("x.com", anchors, at));
    expect(candidates(patterns)).toHaveLength(0);
  });

  it("忽略过的不再打扰", () => {
    let patterns: ObservedPattern[] = [];
    const anchors = [click("筛选"), click("第一条记录")];
    patterns = mergeRun(patterns, run("x.com", anchors, 0));
    patterns = mergeRun(patterns, run("x.com", anchors, DAY));
    patterns = mergeRun(patterns, run("x.com", anchors, 3 * DAY));
    patterns = patterns.map(p => ({ ...p, dismissed: true as const }));
    patterns = mergeRun(patterns, run("x.com", anchors, 4 * DAY));
    expect(candidates(patterns)).toHaveLength(0);
    expect(patterns[0]?.dismissed).toBe(true);
  });

  it("不同站点、不同顺序各自计数", () => {
    let patterns: ObservedPattern[] = [];
    const a = [click("筛选"), click("第一条记录")];
    const b = [click("第一条记录"), click("筛选")];
    patterns = mergeRun(patterns, run("x.com", a, 0));
    patterns = mergeRun(patterns, run("y.com", a, 0));
    patterns = mergeRun(patterns, run("x.com", b, 0));
    expect(patterns).toHaveLength(3);
    expect(patterns.every(p => p.count === 1)).toBe(true);
  });
});

describe("有界与文案", () => {
  it("站点数有上限：观察不能变成新的配额事故", () => {
    let patterns: ObservedPattern[] = [];
    for (let i = 0; i < MAX_HOSTS + 5; i += 1) {
      patterns = mergeRun(patterns, run(`host${i}.com`, [click("A"), click("B")], i * 1000));
    }
    const hosts = new Set(patterns.map(p => p.hostname));
    expect(hosts.size).toBe(MAX_HOSTS);
    // 留下的应该是最近用过的那些
    expect(patterns.some(p => p.hostname === `host${MAX_HOSTS + 4}.com`)).toBe(true);
    expect(patterns.some(p => p.hostname === "host0.com")).toBe(false);
  });

  it("trim 保留每站最近常用的若干条", () => {
    const many: ObservedPattern[] = Array.from({ length: 40 }, (_, i) => ({
      hostname: "x.com", signature: `s${i}`, anchors: [click("A")], count: 1, firstSeen: i, lastSeen: i,
    }));
    expect(trimPatterns(many)).toHaveLength(30);
  });

  it("说人话：只讲事实，不解释", () => {
    let patterns: ObservedPattern[] = [];
    const anchors = [click("筛选"), click("打开第一条记录")];
    patterns = mergeRun(patterns, run("x.com", anchors, 0));
    patterns = mergeRun(patterns, run("x.com", anchors, DAY));
    patterns = mergeRun(patterns, run("x.com", anchors, 3 * DAY));
    const text = describePattern(patterns[0]!, a => `点击${a.name}`);
    expect(text).toBe("你在 x.com 这样做了 3 次（跨 3 天）：点击筛选 → 点击打开第一条记录");
    expect(defaultIntent(patterns[0]!, a => `点击${a.name}`)).toBe("x.com：点击筛选，点击打开第一条记录");
  });

  it("shouldPropose 是三条门槛的合取", () => {
    const base: ObservedPattern = { hostname: "x.com", signature: "s", anchors: [click("A"), click("B")], count: 3, firstSeen: 0, lastSeen: 3 * DAY };
    expect(shouldPropose(base)).toBe(true);
    expect(shouldPropose({ ...base, count: 2 })).toBe(false);
    expect(shouldPropose({ ...base, lastSeen: DAY })).toBe(false);
    expect(shouldPropose({ ...base, anchors: [click("A")] })).toBe(false);
    expect(shouldPropose({ ...base, dismissed: true })).toBe(false);
  });
});
