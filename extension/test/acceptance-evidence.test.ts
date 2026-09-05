// @ts-nocheck scripts/ 不在 extension tsconfig include 内
import { describe, expect, it } from "vitest";
import { assertNoSecrets, buildResultJson, redactEvidence } from "../../scripts/acceptance/index.mjs";

describe("evidence redaction", () => {
  it("strips cookie, token, authorization, history and page html keys", () => {
    const redacted = redactEvidence({
      ok: true,
      cookie: "sid=abc",
      cookies: [{ name: "sid", value: "abc" }],
      token: "secret-token",
      access_token: "aaaa",
      authorization: "Bearer xyz",
      history: ["https://mail.example/inbox"],
      html: "<html>inbox</html>",
      pageContent: "private note",
      innerHTML: "<b>x</b>",
      steps: [{ name: "snapshot", ok: true, expected: "unique", actual: { unique: true } }],
      connection: { pid: 8103, port: 9222, wrapperBundleId: "local.yishu.chrome-main" },
    });
    expect(redacted.cookie).toBe("[redacted]");
    expect(redacted.cookies).toBe("[redacted]");
    expect(redacted.token).toBe("[redacted]");
    expect(redacted.access_token).toBe("[redacted]");
    expect(redacted.authorization).toBe("[redacted]");
    expect(redacted.history).toBe("[redacted]");
    expect(redacted.html).toBe("[redacted]");
    expect(redacted.pageContent).toBe("[redacted]");
    expect(redacted.innerHTML).toBe("[redacted]");
    expect(redacted.ok).toBe(true);
    expect(redacted.connection).toEqual({
      pid: 8103,
      port: 9222,
      wrapperBundleId: "local.yishu.chrome-main",
    });
    const steps = redacted.steps as Array<{ name: string }>;
    expect(steps[0]?.name).toBe("snapshot");
    assertNoSecrets(redacted);
  });

  it("redacts secret-looking strings even under safe keys", () => {
    const redacted = redactEvidence({
      note: "Authorization: Bearer abc.def",
      query: "token=super-secret",
    });
    expect(redacted.note).toBe("[redacted]");
    expect(redacted.query).toBe("[redacted]");
  });

  it("buildResultJson never keeps cookies or full page dumps", () => {
    const json = buildResultJson({
      ok: false,
      startedAt: 1,
      elapsedMs: 2,
      runs: [{ cookie: "a=b", html: "<p>x</p>", token: "nope", steps: [{ name: "click", ok: false }] }],
      connection: { pid: 1, port: 9222 },
      execution: { via: "sideagent-service-worker" },
      failureCategory: "click_no_change",
      failureStage: "click",
      evidenceDir: "/tmp/example",
      screenshots: ["before.png"],
    });
    expect(json).not.toHaveProperty("token");
    const run0 = (json as { runs: Array<Record<string, unknown>> }).runs[0];
    expect(run0?.cookie).toBe("[redacted]");
    expect(run0?.html).toBe("[redacted]");
    expect(run0?.token).toBe("[redacted]");
    expect(json.failureCategory).toBe("click_no_change");
    expect(json.screenshots).toEqual(["before.png"]);
    assertNoSecrets(json);
  });
});
