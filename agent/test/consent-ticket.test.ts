import { describe, expect, it } from "vitest";
import { CONSENT_TTL_MS, ConsentLedger } from "../src/consent-ticket.js";

describe("consent tickets", () => {
  const base = {
    conversationId: "c1",
    runId: "r1",
    controlVersion: 3,
    origin: "https://shop.example",
    operation: "fetch",
    params: { url: "https://shop.example/order", method: "POST", body: '{"price":10}' },
  };

  it("is one-time, bound to scope, and expires", () => {
    const ledger = new ConsentLedger();
    const ticket = ledger.issue({ ...base, now: 1000 });
    const first = ledger.consume({ id: ticket.id, ...base, now: 1000 });
    expect(first.ok).toBe(true);
    const again = ledger.consume({ id: ticket.id, ...base, now: 1001 });
    expect(again).toMatchObject({ ok: false });
  });

  it("rejects parameter, origin, or control version changes", () => {
    const ledger = new ConsentLedger();
    const ticket = ledger.issue({ ...base, now: 1 });
    expect(ledger.consume({ id: ticket.id, ...base, params: { ...base.params, body: '{"price":11}' }, now: 1 }).ok).toBe(false);
    const t2 = ledger.issue({ ...base, now: 2 });
    expect(ledger.consume({ id: t2.id, ...base, controlVersion: 4, now: 2 }).ok).toBe(false);
    const t3 = ledger.issue({ ...base, now: 3 });
    expect(ledger.consume({ id: t3.id, ...base, origin: "https://evil.example", now: 3 }).ok).toBe(false);
  });

  it("does not auto-renew after expiry", () => {
    const ledger = new ConsentLedger();
    const ticket = ledger.issue({ ...base, now: 10, ttlMs: CONSENT_TTL_MS });
    expect(ledger.consume({ id: ticket.id, ...base, now: 10 + CONSENT_TTL_MS + 1 }).ok).toBe(false);
  });
});
