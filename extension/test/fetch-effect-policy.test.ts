import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ControlGate, USER_BLOCKED_ERROR } from "../../shared/control.js";
import { ConsentLedger } from "../../agent/src/consent-ticket.js";
import { CONSENT_REQUIRED_ERROR } from "../../agent/src/consent-ticket.js";
import { needsConsentTicket } from "../../shared/effect-policy.js";
import { installFetchTestOrigin } from "../../shared/fetch.js";
import { fetchUrl } from "../src/background/exec/fetch-url.js";
import { createBrowserTools } from "../../agent/src/tools.js";

async function withCounter<T>(fn: (origin: string, counts: { n: number }) => Promise<T>): Promise<T> {
  const counts = { n: 0 };

  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/count") counts.n += 1;

    if (req.method === "GET" && req.url === "/count") counts.n += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ n: counts.n }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  const restore = installFetchTestOrigin(origin);

  try {
    return await fn(origin, counts);
  } finally {
    restore();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

describe("fetch side-effect boundary", () => {
  afterEach(() => {
    installFetchTestOrigin("http://invalid.example")();
  });

  it("does not let a disguised POST increment the fixture while the user has the page", async () => {
    await withCounter(async (origin, counts) => {
      const gate = new ControlGate();
      await gate.takeover();
      await expect(
        gate.run("post-1", "fetch", () => fetchUrl({ url: `${origin}/count`, method: "POST", body: "{}" }), "main", {
          url: `${origin}/count`,
          method: "POST",
          body: "{}",
        }),
      ).rejects.toThrow(USER_BLOCKED_ERROR);
      expect(counts.n).toBe(0);
    });
  });

  it("does not let fetch POST through tools without a consent ticket", async () => {
    await withCounter(async (origin, counts) => {
      const calls: unknown[] = [];

      const tools = createBrowserTools(
        { call: async (name: string, params: Record<string, unknown>) => { calls.push([name, params]);

 return { url: origin, status: 200, ok: true, contentType: "application/json", bytes: 2, truncated: false, text: "{}" }; } } as any,
        undefined,
        undefined,
        undefined,
        { epoch: () => 1, canWrite: () => true },
      );

      const fetch = tools.find((t) => t.name === "fetch")!;
      await expect(fetch.execute("1", { url: `${origin}/count`, method: "POST", body: "{}" }, undefined, undefined, {} as any)).rejects.toThrow(CONSENT_REQUIRED_ERROR);
      expect(calls).toEqual([]);
      expect(counts.n).toBe(0);
    });
  });

  it("invalidates consent when POST body changes", () => {
    const ledger = new ConsentLedger();
    const params = { url: "https://shop.example/pay", method: "POST", body: '{"n":1}' };
    const ticket = ledger.issue({ conversationId: "c", runId: "r", controlVersion: 1, origin: "https://shop.example", operation: "fetch", params, now: 1 });
    expect(needsConsentTicket("fetch", params)).toBe(true);
    expect(ledger.consume({ id: ticket.id, conversationId: "c", runId: "r", controlVersion: 1, origin: "https://shop.example", operation: "fetch", params: { ...params, body: '{"n":2}' }, now: 1 }).ok).toBe(false);
  });
});
