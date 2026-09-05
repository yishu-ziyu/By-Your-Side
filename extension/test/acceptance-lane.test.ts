// @ts-nocheck scripts/ 不在 extension tsconfig include 内
import { describe, expect, it } from "vitest";
import {
  COUNTER_AFTER,
  COUNTER_BEFORE,
  FILL_AFTER,
  FILL_BEFORE,
  FILL_VALUE,
  HOOK_EXPRESSION,
  INC_BUTTON_LABEL,
  PHASE_CHANGED,
  PHASE_CLICKED,
  PHASE_IDLE,
  UNIQUE_TEXT,
  buildDriverExpression,
  classifyBrowserCommand,
  classifyFailure,
  discoverChromeMain,
  evaluateRun,
  findServiceWorker,
  formatRun,
  formatStep,
  isBrowserMainProcess,
  loadFixtureHtml,
  parseLsofListenPids,
  parsePsLine,
  parseRemoteDebuggingPort,
} from "../../scripts/acceptance/index.mjs";

function snap(parts: string[]): string {
  return parts.join("\n");
}

describe("acceptance fixture", () => {
  const html = loadFixtureHtml();

  it("has unique text, counter, fillable input, and a non-destructive click target", () => {
    expect(html).toContain(UNIQUE_TEXT);
    expect(html).toContain('id="inc-btn"');
    expect(html).toContain(INC_BUTTON_LABEL);
    expect(html).toContain('id="note-input"');
    expect(html).toContain(COUNTER_BEFORE);
    expect(html).toContain(FILL_BEFORE);
    expect(html).toContain(PHASE_IDLE);
    expect(html).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/i);
  });

  it("does not use destructive button copy that would hold a click", () => {
    expect(html).not.toMatch(/删除|清空|支付|发送|Delete|Remove|Pay|Send/);
  });
});

describe("evaluateRun success / step failure", () => {
  const successDriver = {
    snapshots: {
      before: snap([UNIQUE_TEXT, COUNTER_BEFORE, FILL_BEFORE, PHASE_IDLE]),
      afterClick: snap([UNIQUE_TEXT, COUNTER_AFTER, PHASE_CLICKED]),
      afterFill: snap([UNIQUE_TEXT, COUNTER_AFTER, FILL_AFTER, PHASE_CHANGED]),
    },
    durationsMs: { snapshot: 11, click: 40, fill: 18, resnapshot: 18 },
    startedAt: 1,
    elapsedMs: 80,
  };

  it("passes when unique text, click counter, fill value, and changed phase are all present", () => {
    const evaluated = evaluateRun(successDriver);
    expect(evaluated.ok).toBe(true);
    expect(evaluated.failureCategory).toBeNull();
    expect(evaluated.steps.map((s: { name: string }) => s.name)).toEqual(["snapshot", "click", "fill", "resnapshot"]);
    expect(evaluated.steps.every((s: { ok: boolean }) => s.ok)).toBe(true);
    const printed = formatRun(1, evaluated);
    expect(printed).toContain("PASS run 1");
    expect(printed).toContain("PASS snapshot");
    expect(printed).toContain("PASS click");
    expect(printed).toContain("PASS fill");
    expect(printed).toContain("PASS resnapshot");
  });

  it("fails snapshot when unique text is missing", () => {
    const evaluated = evaluateRun({
      ...successDriver,
      snapshots: { ...successDriver.snapshots, before: snap([COUNTER_BEFORE, PHASE_IDLE]) },
    });
    expect(evaluated.ok).toBe(false);
    expect(evaluated.failureStage).toBe("snapshot");
    expect(evaluated.failureCategory).toBe("snapshot_mismatch");
    expect(formatStep(evaluated.steps[0]!)).toMatch(/^FAIL snapshot/);
  });

  it("fails click when the counter does not change", () => {
    const evaluated = evaluateRun({
      ...successDriver,
      snapshots: {
        ...successDriver.snapshots,
        afterClick: snap([UNIQUE_TEXT, COUNTER_BEFORE, PHASE_IDLE]),
      },
    });
    expect(evaluated.ok).toBe(false);
    expect(evaluated.failureStage).toBe("click");
    expect(evaluated.failureCategory).toBe("click_no_change");
  });

  it("fails fill when the expected value is absent", () => {
    const evaluated = evaluateRun({
      ...successDriver,
      snapshots: {
        ...successDriver.snapshots,
        afterFill: snap([UNIQUE_TEXT, COUNTER_AFTER, FILL_BEFORE, PHASE_CHANGED]),
      },
    });
    expect(evaluated.ok).toBe(false);
    expect(evaluated.failureStage).toBe("fill");
    expect(evaluated.failureCategory).toBe("fill_mismatch");
  });

  it("fails resnapshot when the page did not reach the changed phase", () => {
    const evaluated = evaluateRun({
      ...successDriver,
      snapshots: {
        ...successDriver.snapshots,
        afterFill: snap([UNIQUE_TEXT, COUNTER_AFTER, FILL_AFTER, PHASE_CLICKED]),
      },
    });
    expect(evaluated.ok).toBe(false);
    expect(evaluated.failureStage).toBe("resnapshot");
    expect(evaluated.failureCategory).toBe("resnapshot_mismatch");
  });

  it("maps a driver-stage error without treating it as success", () => {
    const evaluated = evaluateRun({
      error: "service worker evaluate: extension not loaded",
      stage: "sw_evaluate",
      snapshots: {},
    });
    expect(evaluated.ok).toBe(false);
    expect(evaluated.failureStage).toBe("sw_evaluate");
    expect(evaluated.failureCategory).toBe("extension_not_found");
  });
});

describe("classifyFailure", () => {
  it("maps connect / extension / step errors to stable categories", () => {
    expect(classifyFailure("local.yishu.chrome-main missing", "connect")).toBe("chrome_main_not_found");
    expect(classifyFailure("json/version failed", "cdp")).toBe("cdp_connect_failed");
    expect(classifyFailure("service worker missing", "extension")).toBe("extension_not_found");
    expect(classifyFailure("unique text missing", "snapshot")).toBe("snapshot_mismatch");
    expect(classifyFailure("count-is-0 still", "click")).toBe("click_no_change");
    expect(classifyFailure(`missing ${FILL_VALUE}`, "fill")).toBe("fill_mismatch");
    expect(classifyFailure("phase-changed missing", "resnapshot")).toBe("resnapshot_mismatch");
  });
});

describe("chrome-main discovery guards", () => {
  const dirs = {
    chromeMainDir: "/Users/me/Library/Application Support/Google/ChromeMain",
    defaultChromeDir: "/Users/me/Library/Application Support/Google/Chrome",
  };

  it("accepts ChromeMain and rejects default Chrome / Playwright / helpers", () => {
    const main =
      "8103 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222 --user-data-dir=/Users/me/Library/Application Support/Google/ChromeMain";
    const def =
      "9000 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/me/Library/Application Support/Google/Chrome";
    const helper =
      "59076 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/152.0.7977.65/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --user-data-dir=/Users/me/Library/Application Support/Google/ChromeMain --remote-debugging-port=9222";
    const testing =
      "90078 /Users/me/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing --remote-debugging-port=9223 --headless=new";

    expect(classifyBrowserCommand(parsePsLine(main)!.command, dirs)).toBe("chrome-main");
    expect(classifyBrowserCommand(parsePsLine(def)!.command, dirs)).toBe("default-chrome");
    expect(isBrowserMainProcess(parsePsLine(helper)!.command)).toBe(false);
    expect(isBrowserMainProcess(parsePsLine(testing)!.command)).toBe(false);
    expect(parseRemoteDebuggingPort(parsePsLine(main)!.command)).toBe(9222);
    expect(parseLsofListenPids("COMMAND PID USER FD TYPE\nGoogle 8103 me 92u IPv4 TCP 127.0.0.1:9222 (LISTEN)\n")).toEqual([
      8103,
    ]);
  });

  it("discoverChromeMain refuses a missing wrapper and a default-only Chrome", () => {
    expect(() =>
      discoverChromeMain({
        exists: () => false,
        wrapperApp: "/tmp/missing-chrome-wrapper.app",
      }),
    ).toThrow(/local\.yishu\.chrome-main/);

    expect(() =>
      discoverChromeMain({
        exists: (p: string) => String(p).includes("Chrome.app"),
        readFile: () =>
          "<key>CFBundleIdentifier</key><string>local.yishu.chrome-main</string>",
        exec: (file: string) => {
          if (file === "ps") {
            return "9000 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/me/Library/Application Support/Google/Chrome\n";
          }
          return "";
        },
        chromeMainDir: "/Users/me/Library/Application Support/Google/ChromeMain",
        defaultChromeDir: "/Users/me/Library/Application Support/Google/Chrome",
        wrapperApp: "/Users/me/Applications/Chrome.app",
      }),
    ).toThrow(/不会连接或控制/);
  });
});

describe("executeToolCall path (no copied handlers)", () => {
  it("hook injects uplink.handleRaw tool_call and requires executeToolCall", () => {
    expect(HOOK_EXPRESSION).toContain("uplink.handleRaw");
    expect(HOOK_EXPRESSION).toContain('type: "tool_call"');
    expect(HOOK_EXPRESSION).toContain("executeToolCall");
    expect(HOOK_EXPRESSION).not.toContain("Input.dispatchMouseEvent");
    expect(HOOK_EXPRESSION).not.toContain("Accessibility.getFullAXTree");
  });

  it("SW driver only calls __saCall, does not reimplement click/fill/snapshot", () => {
    const src = buildDriverExpression({
      url: "http://127.0.0.1/index.html",
      incSelector: "#inc-btn",
      inputSelector: "#note-input",
      fillValue: FILL_VALUE,
    });
    expect(src).toContain("__saCall");
    expect(src).toContain('tool("snapshot"');
    expect(src).toContain('tool("click"');
    expect(src).toContain('tool("fill"');
    expect(src).not.toContain("Input.dispatchMouseEvent");
    expect(src).not.toContain("Accessibility.getFullAXTree");
    expect(src).not.toContain("content-domops.js");
  });
});

describe("findServiceWorker", () => {
  it("picks SideAgent background.js and ignores other extensions", () => {
    const ext = "fnbjglhppbkgmjeehablkfilmmefjolo";
    const sw = findServiceWorker(
      [
        { type: "page", url: "https://example.com" },
        { type: "service_worker", url: "chrome-extension://aaaa/background.js" },
        { type: "service_worker", url: `chrome-extension://${ext}/background.js`, targetId: "sw-1" },
      ],
      ext,
    );
    expect(sw?.targetId).toBe("sw-1");
    expect(findServiceWorker([], ext)).toBeUndefined();
  });
});
