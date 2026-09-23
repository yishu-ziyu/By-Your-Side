import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { decideBrowserCandidate, type BrowserDecisionInput } from "../src/browser-decision-model.js";

// 走真实的 readTypeSafeKey：用环境变量提供一个已知的假 key，才能断言它绝不进 trace。
// 与 display-steer-routing.test.ts 同一套做法，不 mock 模块。
const TRACE_TEST_KEY = "secret-trace-test-key";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TYPESAFE_API_KEY;
});

const input: BrowserDecisionInput = {
  goal: "Choose the second observed control", materials: [], history: ["read previous region"],
  page: { id: "obs", tabId: 7, documentId: "doc", url: "https://fixture.test", observedAt: 1, text: "页面", controls: [], source: "accessibility", truncated: false },
  candidates: [{ id: "a", operation: "click", target: "@1", label: "first" }, { id: "b", operation: "click", target: "@2", label: "second" }],
};

// Failures: the observer changes model choices, secrets leak, logged bytes differ
// from transmitted bytes, or an unused target head suppresses a legitimate choice.
it("opt-in trace contains exact request and raw probabilities, never authorization", async () => {
  let transmitted = "";
  const payload = { model: "fixture", answers: { operation: { choice: "click", confidence: .96 }, click_target: { choice: "b", confidence: .88, probabilities: { a: .1, b: .88, none: .02 } }, hover_target: { choice: "none", confidence: .2 } } };
  vi.stubGlobal("fetch", async (_url: string, options: { body: string }) => {
    transmitted = options.body;

    return { ok: true, status: 200, headers: new Headers({ "x-request-id": "fixture-request" }), json: async () => payload };
  });
  const traces: unknown[] = [];

  process.env.TYPESAFE_API_KEY = TRACE_TEST_KEY;

  const result = await decideBrowserCandidate(input, new AbortController().signal, {
    onTrace: event => { traces.push(event); },
  });

  expect(traces).toEqual(expect.arrayContaining([
    expect.objectContaining({ phase: "request", body: transmitted, bytes: Buffer.byteLength(transmitted), sha256: createHash("sha256").update(transmitted).digest("hex") }),
    expect.objectContaining({ phase: "response", data: payload, requestId: "fixture-request" }),
    expect.objectContaining({ phase: "decision", decision: expect.objectContaining({ confidence: .88, operationConfidence: .96, targetConfidence: .88 }) }),
  ]));
  expect(JSON.stringify(traces)).not.toContain("secret-trace-test-key");
  expect(result.candidateId).toBe("b");
});

it("a broken trace observer cannot change the selected action", async () => {
  vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ answers: { operation: { choice: "click", confidence: .97 }, click_target: { choice: "b", confidence: .89 } } }) }));

  process.env.TYPESAFE_API_KEY = TRACE_TEST_KEY;

  const result = await decideBrowserCandidate(input, new AbortController().signal, {
    onTrace: event => {
      if (event.phase === "response") {
        // SAFETY: a "response" trace carries the decoded Jev body, whose `answers` map is
        // declared in agent/src/browser-decision-model.ts; the fixture answered above always
        // supplies `answers.click_target.choice` as a string, so this narrowing matches the
        // schema the adapter already parses before emitting the trace.
        (event.data as { answers: { click_target: { choice: string } } }).answers.click_target.choice = "a";
      }

      throw new Error("observer failed");
    },
  });

  expect(result).toMatchObject({ candidateId: "b", confidence: .89 });
});
