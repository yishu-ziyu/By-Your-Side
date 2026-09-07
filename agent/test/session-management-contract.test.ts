// @ts-nocheck 验收脚本不在 agent tsconfig include 内
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HOOK_EXPRESSION } from "../../scripts/acceptance/sw-hook.mjs";
import {
  EDUCATION_VALUE,
  SESSION_A_DRAFT,
  SESSION_B_DRAFT,
  SESSION_FIXTURE_MARKER,
  WORK_VALUE,
  buildSessionManagementExpression,
  evaluateSessionManagementRun,
} from "../../scripts/acceptance/session-management-run.mjs";

const fixture = readFileSync(
  fileURLToPath(new URL("../../extension/test/fixtures/session-management.html", import.meta.url)),
  "utf8",
);

describe("session management acceptance fixture", () => {
  it("contains independent draft, two shared fields, submit guard and real event timeline", () => {
    expect(fixture).toContain(SESSION_FIXTURE_MARKER);
    expect(fixture).toContain('id="session-draft"');
    expect(fixture).toContain('id="work-experience"');
    expect(fixture).toContain('id="education"');
    expect(fixture).toContain('id="summary"');
    expect(fixture).toContain('id="submit-resume"');
    expect(fixture).toContain('id="event-log"');
    expect(fixture).toContain('id="transaction-proof"');
    expect(fixture).toContain('field.addEventListener("focus"');
    expect(fixture).toContain('field.addEventListener("input"');
    expect(fixture).toContain('document.activeElement === field ? "focused-input" : "blurred-input"');
    expect(fixture).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/i);
  });

  it("driver writes only through production tool/control paths", () => {
    const source = buildSessionManagementExpression({ url: "http://127.0.0.1/session-management.html" });
    expect(source).toContain("__saCall");
    expect(source).toContain("__saSendClient");
    expect(source).toContain('"conversation_create"');
    expect(source).toContain('"share_tab"');
    expect(source).toContain('"page_operation"');
    expect(source).toContain("__saTakeover");
    expect(source).not.toContain("chrome.scripting.executeScript");
    expect(source).not.toContain("Input.dispatchKeyEvent");
    expect(source).not.toContain("document.querySelector");
  });

  it("hook routes conversation-scoped calls through transport raw input", () => {
    expect(HOOK_EXPRESSION).toContain("rawTransport.handleRaw");
    expect(HOOK_EXPRESSION).toContain("conversationId: conversationId");
    expect(HOOK_EXPRESSION).toContain("__saSendClient");
    expect(HOOK_EXPRESSION).toContain("executeToolCall");
  });
});

function successDriver() {
    const eventLog = "transaction-order-is-focused-input-work-experience>change-work-experience>focused-input-education>change-education";
  return {
    conversations: {
      a: "default",
      b: "conversation-b",
      list: [{ id: "default" }, { id: "conversation-b" }],
    },
    agentAssembly: { ok: true, members: ["main", "resume-worker"] },
    tabs: {
      a: 11,
      b: 12,
      sameUrl: true,
      groups: {
        a: { groupId: 101, title: "会话 A" },
        b: { groupId: 102, title: "会话 B" },
      },
    },
    operations: {
      share: { ok: true, data: { tabId: 11, collaborators: ["main", "resume-worker"] } },
      work: { ok: true, data: { verified: true } },
      education: { ok: true, data: { verified: true } },
      bAfterTakeover: { ok: true, data: { filled: true } },
    },
    snapshots: {
      a: `${SESSION_A_DRAFT}\n${WORK_VALUE}\n${EDUCATION_VALUE}\nsubmit-count-is-0\n${eventLog}`,
      b: SESSION_B_DRAFT,
      bAfterTakeover: "conversation-b-kept-running",
    },
    takeover: {
      frame: { members: [{ sessionId: "main" }, { sessionId: "resume-worker" }] },
      result: { ok: true },
      blocked: [{ ok: false, error: "页面现在归你" }, { ok: false, error: "页面现在归你" }],
    },
    abortIsolation: { bIdle: true, aStillHeld: true },
    persistence: {
      histories: [],
      workingTabs: { main: 11, "conversation-b::main": 12 },
      tabResources: { "11": { conversationId: "default" }, "12": { conversationId: "conversation-b" } },
    },
    modelRestore: { before: "provider/original", after: "provider/original", ok: true },
    error: null,
  };
}

describe("evaluateSessionManagementRun", () => {
  it("passes independent conversations, distinct groups, serialized shared writes and isolated takeover", () => {
    const evaluated = evaluateSessionManagementRun(successDriver());
    expect(evaluated.ok).toBe(true);
    expect(evaluated.checks.every((check) => check.ok)).toBe(true);
  });

  it("rejects reusing one tab for the same URL across conversations", () => {
    const driver = successDriver();
    driver.tabs.b = driver.tabs.a;
    const evaluated = evaluateSessionManagementRun(driver);
    expect(evaluated.ok).toBe(false);
    expect(evaluated.failureStage).toBe("same-url-distinct-tabs");
  });

  it("rejects focus interleaving inside one writer transaction", () => {
    const driver = successDriver();
    driver.snapshots.a = `${SESSION_A_DRAFT}\nsubmit-count-is-0\ntransaction-order-is-focused-input-work-experience>focused-input-education>change-work-experience>change-education`;
    const evaluated = evaluateSessionManagementRun(driver);
    expect(evaluated.ok).toBe(false);
    expect(evaluated.failureStage).toBe("focus-fill-readback-serialized");
  });

  it("rejects any writer that lands after shared-page takeover", () => {
    const driver = successDriver();
    driver.takeover.blocked[1] = { ok: true, data: { verified: true } };
    const evaluated = evaluateSessionManagementRun(driver);
    expect(evaluated.ok).toBe(false);
    expect(evaluated.failureStage).toBe("a-writes-blocked");
  });
});
