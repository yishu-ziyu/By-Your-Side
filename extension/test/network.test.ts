import { describe, expect, it } from "vitest";
import {
  NETWORK_CAPACITY,
  appendNetworkEntry,
  entryDurationMs,
  formatBytes,
  formatNetworkEntryLine,
  formatNetworkReport,
  networkEventToUpdate,
  patchNetworkEntry,
  redactUrlCredentials,
  restartNetworkEntry,
  selectNetworkEntries,
  type NetworkEntry,
} from "../../shared/network.js";

const entry = (overrides: Partial<NetworkEntry> = {}): NetworkEntry => ({
  requestId: "r1",
  method: "GET",
  url: "https://api.example.com/list?page=2",
  resourceType: "xhr",
  startedAt: 1_000,
  ...overrides,
});

describe("network 事件 → 条目", () => {
  it("requestWillBeSent 建条目，类型统一小写", () => {
    const update = networkEventToUpdate("Network.requestWillBeSent", {
      requestId: "r1",
      type: "XHR",
      timestamp: 10.5,
      request: { url: "https://api.example.com/list", method: "post" },
    }, 1_000);
    expect(update).toMatchObject({
      kind: "start",
      entry: { requestId: "r1", method: "post", url: "https://api.example.com/list", resourceType: "xhr", startedTs: 10.5, startedAt: 1_000 },
    });
  });

  it("responseReceived / loadingFinished / loadingFailed 只 patch，不编造读数", () => {
    expect(networkEventToUpdate("Network.responseReceived", { requestId: "r1", response: { status: 200, mimeType: "application/json; charset=utf-8", fromDiskCache: true } })).toEqual({
      kind: "patch",
      requestId: "r1",
      patch: { status: 200, mimeType: "application/json", fromCache: true },
    });
    expect(networkEventToUpdate("Network.loadingFinished", { requestId: "r1", encodedDataLength: 2048, timestamp: 12.25 })).toEqual({
      kind: "patch",
      requestId: "r1",
      patch: { encodedBytes: 2048, endedTs: 12.25 },
    });
    expect(networkEventToUpdate("Network.loadingFailed", { requestId: "r1", errorText: "net::ERR_FAILED", canceled: true, timestamp: 11 })).toEqual({
      kind: "patch",
      requestId: "r1",
      patch: { failed: "net::ERR_FAILED", canceled: true, endedTs: 11 },
    });
  });

  it("无关事件与缺 requestId 的事件返回 null", () => {
    expect(networkEventToUpdate("Network.dataReceived", { requestId: "r1", dataLength: 10 })).toBeNull();
    expect(networkEventToUpdate("Runtime.consoleAPICalled", {})).toBeNull();
    expect(networkEventToUpdate("Network.responseReceived", { response: { status: 200 } })).toBeNull();
  });

  it("data:/blob: 这类伪 URL 不进缓冲（真实运行里会把 base64 拖进上下文）", () => {
    expect(networkEventToUpdate("Network.requestWillBeSent", { requestId: "d", type: "Image", request: { url: "data:image/png;base64,iVBORw0KGgo=" } })).toBeNull();
    expect(networkEventToUpdate("Network.requestWillBeSent", { requestId: "b", type: "Media", request: { url: "blob:https://example.com/abc" } })).toBeNull();
    expect(networkEventToUpdate("Network.requestWillBeSent", { requestId: "h", type: "XHR", request: { url: "HTTPS://api.example.com/x" } })?.kind).toBe("start");
  });

  it("重定向按同一 requestId 替换旧条目并记跳数", () => {
    const first = appendNetworkEntry({ entries: [], dropped: 0 }, entry({ requestId: "r1", status: 302 }));
    const second = restartNetworkEntry(first, entry({ requestId: "r1", url: "https://cdn.example.com/a.js", resourceType: "script" }));
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0]).toMatchObject({ url: "https://cdn.example.com/a.js", redirects: 1 });
  });

  it("条目不在缓冲里时 patch 不生效", () => {
    const ring = appendNetworkEntry({ entries: [], dropped: 0 }, entry());
    expect(patchNetworkEntry(ring, "missing", { status: 500 })).toBe(ring);
  });

  it("超容量丢最旧并累计 dropped", () => {
    let ring = { entries: [] as NetworkEntry[], dropped: 0 };
    for (let i = 0; i < NETWORK_CAPACITY + 3; i += 1) ring = appendNetworkEntry(ring, entry({ requestId: `r${i}` }));
    expect(ring.entries).toHaveLength(NETWORK_CAPACITY);
    expect(ring.dropped).toBe(3);
    expect(ring.entries[0]!.requestId).toBe("r3");
  });

  it("耗时只在两侧时钟都有时给出", () => {
    expect(entryDurationMs(entry({ startedTs: 10, endedTs: 10.21 }))).toBe(210);
    expect(entryDurationMs(entry({ startedTs: 10 }))).toBeUndefined();
    expect(entryDurationMs(entry({ startedTs: 11, endedTs: 10 }))).toBeUndefined();
  });
});

describe("network 筛选", () => {
  const entries = [
    entry({ requestId: "a", resourceType: "xhr", url: "https://api.example.com/List?page=1" }),
    entry({ requestId: "b", resourceType: "script", url: "https://cdn.example.com/app.js" }),
    entry({ requestId: "c", resourceType: "fetch", url: "https://api.example.com/detail?id=9" }),
    entry({ requestId: "d", resourceType: "document", url: "https://example.com/" }),
  ];

  it("默认只看 xhr/fetch", () => {
    expect(selectNetworkEntries(entries).shown.map((e) => e.requestId)).toEqual(["a", "c"]);
  });

  it("types=all 看全部；数组按小写匹配", () => {
    expect(selectNetworkEntries(entries, { types: "all" }).shown.map((e) => e.requestId)).toEqual(["a", "b", "c", "d"]);
    expect(selectNetworkEntries(entries, { types: ["Document"] }).shown.map((e) => e.requestId)).toEqual(["d"]);
  });

  it("urlContains 大小写不敏感", () => {
    const { shown, matched } = selectNetworkEntries(entries, { urlContains: "API.EXAMPLE" });
    expect(shown.map((e) => e.requestId)).toEqual(["a", "c"]);
    expect(matched).toBe(2);
  });

  it("limit 取最近 N 条且保持时间顺序", () => {
    const { shown, matched } = selectNetworkEntries(entries, { types: "all", limit: 2 });
    expect(shown.map((e) => e.requestId)).toEqual(["c", "d"]);
    expect(matched).toBe(4);
  });

  it("limit 非数值/越界时回到默认与钳制，不会失去限制", () => {
    expect(selectNetworkEntries(entries, { types: "all", limit: Number.NaN }).shown).toHaveLength(4);
    expect(selectNetworkEntries(entries, { types: "all", limit: 0 }).shown.map((e) => e.requestId)).toEqual(["d"]);
    expect(selectNetworkEntries(entries, { types: "all", limit: 1e9 }).shown).toHaveLength(4);
  });
});

describe("URL 凭据隐去", () => {
  it("user:pass@ 折叠", () => {
    expect(redactUrlCredentials("https://alice:s3cret@example.com/x")).toBe("https://[redacted]@example.com/x");
  });

  it("敏感查询参数只留键名，业务参数不误伤", () => {
    const url = redactUrlCredentials("https://api.example.com/x?access_token=abc123&bvid=BV1xm376WEc5&order=20260911-01&sign=deadbeef&page=2");
    expect(url).toContain("access_token=[redacted]");
    expect(url).toContain("sign=[redacted]");
    expect(url).toContain("bvid=BV1xm376WEc5");
    expect(url).toContain("order=20260911-01");
    expect(url).toContain("page=2");
  });

  it("无查询串原样返回，畸形 URL 不抛错", () => {
    expect(redactUrlCredentials("https://example.com/a")).toBe("https://example.com/a");
    expect(redactUrlCredentials("not a url token=x")).toBe("not a url token=x");
  });
});

describe("network 回执", () => {
  it("空缓冲给出原因与下一步，不编造", () => {
    const text = formatNetworkReport([], { total: 0, matched: 0, dropped: 0 });
    expect(text).toContain("No network requests recorded");
    expect(text).toContain("network again");
  });

  it("有记录但没有匹配时报清楚过滤条件", () => {
    const text = formatNetworkReport([], { total: 5, matched: 0, dropped: 0, types: ["xhr"], urlContains: "nope" });
    expect(text).toContain("none match");
    expect(text).toContain('url~"nope"');
  });

  it("明细行区分 pending / failed / cache / 大小与耗时", () => {
    const text = formatNetworkReport(
      [
        entry({ requestId: "p", url: "https://api.example.com/pending" }),
        entry({ requestId: "f", failed: "net::ERR_ABORTED", canceled: true, endedTs: 1.2, startedTs: 1 }),
        entry({ requestId: "c", status: 200, fromCache: true, encodedBytes: 2048, mimeType: "application/json", endedTs: 2, startedTs: 1.5 }),
      ],
      { total: 3, matched: 3, dropped: 2, capacity: 300 },
    );
    expect(text).toContain("dropped at capacity 300");
    expect(text).toContain("pending GET https://api.example.com/pending");
    expect(text).toContain("failed GET");
    expect(text).toContain("(net::ERR_ABORTED)");
    expect(text).toContain("(canceled)");
    expect(text).toContain("200 GET");
    expect(text).toContain("2.0KB");
    expect(text).toContain("500ms");
    expect(text).toContain("(cache)");
    expect(text).toContain("Use fetch");
  });

  it("格式化的 URL 已过凭据隐去", () => {
    const text = formatNetworkReport([entry({ url: "https://api.example.com/x?token=abc" })], { total: 1, matched: 1, dropped: 0 });
    expect(text).toContain("token=[redacted]");
    expect(text).not.toContain("token=abc");
  });

  it("超长 URL 截断，不拿跟踪串撑上下文", () => {
    const long = `https://api.example.com/track?${"x".repeat(400)}`;
    const line = formatNetworkEntryLine(entry({ url: long }), 1);
    expect(line.length).toBeLessThan(320);
    expect(line.endsWith("…") || line.includes("… ")).toBe(true);
    expect(line).toContain(`${"x".repeat(20)}`);
  });

  it("字节格式", () => {
    expect(formatBytes(512)).toBe("512B");
    expect(formatBytes(2048)).toBe("2.0KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0MB");
  });
});
