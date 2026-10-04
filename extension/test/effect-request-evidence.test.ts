// 点击窗口内的页面请求何时算点击效果（docs/evals/20261004-honest-completion.md R2，F3/F4）。
// 期望值按验收规则手写，不由实现推出。
import { describe, expect, it } from "vitest";
import { requestEvidence, type EffectRequest } from "../../shared/effect.js";

const PAGE = "https://v.flomoapp.com/mine";

const req = (method: string, url: string, resourceType = "fetch", startedAt = 1_000): EffectRequest => ({ method, url, resourceType, startedAt });

describe("requestEvidence", () => {
  it("同站的保存请求算效果，只写方法、主机与路径", () => {
    expect(requestEvidence([req("POST", "https://flomoapp.com/api/v1/memo?token=abc")], 900, 1_600, PAGE)).toEqual(["page sent POST flomoapp.com/api/v1/memo"]);
  });

  it("原生表单提交（document）算效果", () => {
    expect(requestEvidence([req("post", "https://v.flomoapp.com/save", "document")], 900, 1_600, PAGE)).toEqual(["page sent POST v.flomoapp.com/save"]);
  });

  it("取数、打点、预检、安全报告不算", () => {
    const quiet = [req("GET", "https://flomoapp.com/api/list"), req("POST", "https://flomoapp.com/ping", "ping"), req("OPTIONS", "https://flomoapp.com/api"), req("POST", "https://flomoapp.com/csp", "cspviolationreport")];

    expect(requestEvidence(quiet, 900, 1_600, PAGE)).toEqual([]);
  });

  it("窗口外开始的请求不算（页面自己的定时后台请求）", () => {
    expect(requestEvidence([req("POST", "https://flomoapp.com/api/memo", "fetch", 2_600), req("POST", "https://flomoapp.com/api/memo", "fetch", 800)], 900, 1_600, PAGE)).toEqual([]);
  });

  it("别的网站的写请求不算（第三方统计）", () => {
    expect(requestEvidence([req("POST", "https://www.google-analytics.com/g/collect")], 900, 1_600, PAGE)).toEqual([]);
  });

  it("路径里像密钥的段被隐去（如 Flomo 的写入链接）", () => {
    expect(requestEvidence([req("POST", "https://flomoapp.com/iwh/MTIzNDU2/5f2c8e7a9b1d4c3e8f7a6b5c4d3e2f1a/")], 900, 1_600, PAGE)).toEqual(["page sent POST flomoapp.com/iwh/*/*/"]);
  });

  it("超过 3 条只列前 3 条并说明还有几条", () => {
    const many = [1, 2, 3, 4, 5].map(i => req("POST", `https://flomoapp.com/api/memo${i}`));

    expect(requestEvidence(many, 900, 1_600, PAGE)).toEqual(["page sent POST flomoapp.com/api/memo1", "page sent POST flomoapp.com/api/memo2", "page sent POST flomoapp.com/api/memo3", "and 2 more request(s)"]);
  });

  it("本机练习站（IP 或单段主机）按主机名比较", () => {
    expect(requestEvidence([req("POST", "http://flomo.test/api/memo")], 900, 1_600, "http://flomo.test/")).toEqual(["page sent POST flomo.test/api/memo"]);
    expect(requestEvidence([req("POST", "http://127.0.0.1:9000/x")], 900, 1_600, "http://127.0.0.1:9000/")).toEqual(["page sent POST 127.0.0.1:9000/x"]);
  });
});
