import { describe, expect, it } from "vitest";
import { CONSENT_TTL_MS, ConsentLedger, hashConsentParams } from "../src/consent-ticket.js";

// 下列 hash 字面量来自共享 canonical helper 之前的旧实现，用于锁住既有授权指纹的字节兼容。
const LOCKED_PARAMS: Record<string, unknown> = {
  url: "https://shop.example/order",
  method: "POST",
  body: '{"price":10}',
  nested: { beta: 1, alpha: 2, omit: undefined },
  tags: ["a", "b"],
  consent: "confirm-1",
  drop: undefined,
};
const LOCKED_HASH = "25bb3c6113b98b06e2a160d6220372ee5cbbc65534c18e56d553ebf8965025e8";
const REORDERED_PARAMS: Record<string, unknown> = {
  tags: ["a", "b"],
  consent: "confirm-2",
  nested: { alpha: 2, beta: 1 },
  body: '{"price":10}',
  method: "POST",
  url: "https://shop.example/order",
  drop: undefined,
};

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

  it("keeps the recorded canonical hash for nested key order and top-level consent", () => {
    expect(hashConsentParams(LOCKED_PARAMS)).toBe(LOCKED_HASH);
    expect(hashConsentParams(REORDERED_PARAMS)).toBe(LOCKED_HASH);
    expect(hashConsentParams({ consent: "x", drop: undefined })).toBe(
      "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    );
  });

  it("still rejects reordered arrays and real parameter changes", () => {
    expect(hashConsentParams({ ...LOCKED_PARAMS, tags: ["b", "a"] })).toBe(
      "10e4159cf590d541479470e599d934ddee5649795103bc43164e33eb42e991b9",
    );
    expect(hashConsentParams({ ...LOCKED_PARAMS, body: '{"price":11}' })).toBe(
      "98a16378a82dfc6ad6735ddbcd144c4a11e71f2a95e731b1267c5200f6108474",
    );
  });

  it("authorizes the same request across key order and consent wording, one time only", () => {
    const ledger = new ConsentLedger();
    const ticket = ledger.issue({ ...base, params: REORDERED_PARAMS, now: 7 });
    expect(ledger.consume({ id: ticket.id, ...base, params: LOCKED_PARAMS, now: 7 }).ok).toBe(true);
    expect(ledger.consume({ id: ticket.id, ...base, params: REORDERED_PARAMS, now: 7 }).ok).toBe(false);
    const arrayTicket = ledger.issue({ ...base, params: LOCKED_PARAMS, now: 8 });
    expect(
      ledger.consume({ id: arrayTicket.id, ...base, params: { ...LOCKED_PARAMS, tags: ["b", "a"] }, now: 8 }).ok,
    ).toBe(false);
    const changedTicket = ledger.issue({ ...base, params: LOCKED_PARAMS, now: 9 });
    expect(
      ledger.consume({ id: changedTicket.id, ...base, params: { ...LOCKED_PARAMS, body: '{"price":11}' }, now: 9 }).ok,
    ).toBe(false);
  });
});
