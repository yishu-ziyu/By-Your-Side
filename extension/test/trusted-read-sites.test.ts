// 受信任网站的范围与授予（docs/evals/20261004-trusted-read-sites.md R1–R3，F1/F3/F4）。期望按规则手写。
import { describe, expect, it, vi } from "vitest";
import { parseTrustedSites, siteOfUrl, trustSiteFor } from "../../shared/trusted-sites.js";
import { ActivationConsent } from "../src/background/activation-consent.js";

describe("siteOfUrl：整个域名，按公共后缀表", () => {
  it("同一网站的不同子域名归为一个", () => {
    expect(siteOfUrl("https://zh.wikipedia.org/wiki/MCP")).toBe("wikipedia.org");
    expect(siteOfUrl("https://en.wikipedia.org/")).toBe("wikipedia.org");
    expect(siteOfUrl("https://www.bbc.co.uk/news")).toBe("bbc.co.uk");
  });

  it("人人可建子站的后缀下，每个子站各算一个（F1）", () => {
    expect(siteOfUrl("https://alice.github.io/")).toBe("alice.github.io");
    expect(siteOfUrl("https://bob.github.io/")).toBe("bob.github.io");
  });

  it("非网页、IP 与坏网址不能被信任", () => {
    for (const url of ["chrome://settings", "file:///Users/a.html", "http://127.0.0.1:8080/", "not a url", "javascript:alert(1)"]) expect(siteOfUrl(url)).toBeNull();
  });
});

describe("trustSiteFor：只免只看不动的动作（F3）", () => {
  const page = "https://zh.wikipedia.org/wiki/MCP";

  it("读取按当前页所在网站，开新标签按目标网址", () => {
    for (const tool of ["snapshot", "read_element", "read_elements", "screenshot"]) expect(trustSiteFor(tool, undefined, page)).toBe("wikipedia.org");
    expect(trustSiteFor("open_tab", "https://x.com/search?q=MCP", page)).toBe("x.com");
  });

  it("写入、脚本、请求、在当前页跳转、切换标签都不免", () => {
    for (const tool of ["click", "fill", "type_text", "select_option", "press_key", "js", "fetch", "navigate", "switch_tab", "close_tab", "accept_dialog", "scroll"]) {
      expect(trustSiteFor(tool, "https://zh.wikipedia.org/", page)).toBeNull();
    }
  });

  it("读取时不知道当前页，或开标签没有网址，不免", () => {
    expect(trustSiteFor("snapshot", undefined, undefined)).toBeNull();
    expect(trustSiteFor("open_tab", undefined, page)).toBeNull();
  });
});

it("parseTrustedSites 只认去重的域名字符串", () => {
  expect(parseTrustedSites(["wikipedia.org", "wikipedia.org", 3, "", null, "x.com"])).toEqual(["wikipedia.org", "x.com"]);
  expect(parseTrustedSites("wikipedia.org")).toEqual([]);
});

describe("ActivationConsent：只有批准真正成功且选了信任，才写入卡上的域名（R3/F4）", () => {
  const input = { conversationId: "c", runId: "r", controlVersion: 0, goal: "g", tool: "snapshot", target: "当前页面", value: "{}", context: "ctx" };

  function setup(read: () => Promise<string> = async () => "ctx") {
    const trusted = vi.fn(), emitted: Array<{ type: string; request?: { id: string } }> = [];
    // SAFETY: the test only records emitted server messages and reads type/request.id from them.
    const consent = new ActivationConsent(message => emitted.push(message as never), 20_000, trusted);
    const decision = consent.request({ ...input, trustSite: "wikipedia.org" }, read);
    const id = emitted.find(m => m.type === "consent_request")!.request!.id;

    return { consent, trusted, decision, id };
  }

  it("允许并信任：写入卡上的域名", async () => {
    const h = setup();

    h.consent.decide(h.id, true, true);
    expect(await h.decision).toBe(true);
    expect(h.trusted).toHaveBeenCalledWith("wikipedia.org");
  });

  it("只允许一次：不写入", async () => {
    const h = setup();

    h.consent.decide(h.id, true);
    expect(await h.decision).toBe(true);
    expect(h.trusted).not.toHaveBeenCalled();
  });

  it("拒绝，或批准时页面已变而作废：都不写入", async () => {
    const declined = setup();

    declined.consent.decide(declined.id, false, true);
    expect(await declined.decision).toBe(false);

    const changed = setup(async () => "page changed");

    changed.consent.decide(changed.id, true, true);
    expect(await changed.decision).toBe(false);
    expect(declined.trusted).not.toHaveBeenCalled();
    expect(changed.trusted).not.toHaveBeenCalled();
  });

  it("卡上没有域名时，带信任的批准也不写入", async () => {
    const trusted = vi.fn(), emitted: Array<{ type: string; request?: { id: string } }> = [];
    // SAFETY: same message recorder as setup().
    const consent = new ActivationConsent(message => emitted.push(message as never), 20_000, trusted);
    const decision = consent.request({ ...input, tool: "click" }, async () => "ctx");

    consent.decide(emitted[0]!.request!.id, true, true);
    expect(await decision).toBe(true);
    expect(trusted).not.toHaveBeenCalled();
  });
});
