import { describe, expect, it } from "vitest";
import { FetchRefused, normalizeFetchRequest, readCappedText, FETCH_MAX_BYTES } from "../../shared/fetch.js";

const req = (raw: Record<string, unknown>) => normalizeFetchRequest(raw);

describe("fetch 边界", () => {
  it("只允许 http(s)，规范化成完整地址", () => {
    expect(req({ url: "https://api.example.com/list?p=2" }).url).toBe("https://api.example.com/list?p=2");
    expect(() => req({ url: "file:///etc/passwd" })).toThrow(FetchRefused);
    expect(() => req({ url: "javascript:alert(1)" })).toThrow(/只支持 http/);
    expect(() => req({ url: "not a url" })).toThrow(FetchRefused);
  });

  it("拒绝本地/私网地址", () => {
    for (const host of ["127.0.0.1", "localhost", "10.0.0.5", "192.168.1.2", "172.20.0.1", "169.254.1.1", "printer.local", "svc.internal", "[::1]"]) {
      expect(() => req({ url: `http://${host}/x` }), host).toThrow(/拒绝本地\/私网/);
    }

    expect(req({ url: "https://8.8.8.8/x" }).url).toContain("8.8.8.8");
  });

  it("只允许 GET/POST，GET 不带 body", () => {
    expect(req({ url: "https://a.com", method: "post" }).method).toBe("POST");
    expect(() => req({ url: "https://a.com", method: "DELETE" })).toThrow(/只允许 GET\/POST/);
    expect(() => req({ url: "https://a.com", body: "x" })).toThrow(/GET 不带 body/);
  });

  it("cookie/host 由浏览器决定，不采纳调用方覆盖", () => {
    const headers = req({ url: "https://a.com", headers: { Cookie: "a=1", Host: "evil", "X-Token": "t" } }).headers;
    expect(headers).toEqual({ "X-Token": "t" });
  });

  it("超过上限截断并明确标记", async () => {
    const big = new Response("x".repeat(FETCH_MAX_BYTES + 100), { headers: { "content-length": String(FETCH_MAX_BYTES + 100) } });
    const { text, retainedBytes, readBytes, totalBytes, truncated, stoppedReason } = await readCappedText(big);
    expect(truncated).toBe(true);
    expect(text.length).toBe(FETCH_MAX_BYTES);
    expect(retainedBytes).toBe(FETCH_MAX_BYTES);
    expect(readBytes).toBeGreaterThanOrEqual(FETCH_MAX_BYTES);
    expect(totalBytes).toBe(FETCH_MAX_BYTES + 100);
    expect(stoppedReason).toBe("limit");
    const small = await readCappedText(new Response("ok"));
    expect(small).toMatchObject({ text: "ok", bytes: 2, truncated: false, stoppedReason: "complete" });
  });

  it("stops an endless stream without buffering the whole body", async () => {
    let pulls = 0;

    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(64 * 1024).fill(97));
      },
    });

    const response = new Response(body);
    const result = await readCappedText(response, 8 * 1024);
    expect(result.retainedBytes).toBe(8 * 1024);
    expect(result.stoppedReason).toBe("limit");
    expect(pulls).toBeLessThan(20);
  });

  it("honours abort and does not invent a total length", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024).fill(98));
      },
    });

    const ac = new AbortController();
    const pending = readCappedText(new Response(body), FETCH_MAX_BYTES, { signal: ac.signal });
    ac.abort();
    const result = await pending;
    expect(result.stoppedReason).toBe("abort");
    expect(result.totalBytes).toBeNull();
  });

  it("decodes UTF-8 across chunk boundaries", async () => {
    const bytes = new TextEncoder().encode("你好");

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 1));
        controller.enqueue(bytes.subarray(1));
        controller.close();
      },
    });

    const result = await readCappedText(new Response(body));
    expect(result.text).toBe("你好");
    expect(result.stoppedReason).toBe("complete");
  });
});
