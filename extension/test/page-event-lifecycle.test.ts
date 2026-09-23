import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal("chrome", {
    debugger: { sendCommand: vi.fn(async () => ({})), onEvent: { addListener: vi.fn() } },
    tabs: { onCreated: { addListener: vi.fn() }, onRemoved: { addListener: vi.fn() } },
  });
});

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

// Failure cases before implementation: failed arming leaks a lease; an old
// session releases another session's lease; detach leaves an old token usable.
it("failed chooser setup leaves no attach hold", async () => {
  let holds = 0;
  const events = await import("../src/background/page-events.js");
  events.bindAttachHolds(() => { holds += 1; }, () => { holds -= 1; });
  vi.mocked(chrome.debugger.sendCommand).mockImplementation(async (_target, method) => {
    if (method === "Page.setInterceptFileChooserDialog") throw new Error("interception refused");

    return {};
  });
  await expect(events.armEventForTab({ tabId: 7, sessionKey: "a", type: "filechooser" })).rejects.toThrow();
  expect(holds).toBe(0);
});

it("stopping an already-disarmed session cannot release a different active arm", async () => {
  let holds = 0;
  const events = await import("../src/background/page-events.js");
  events.bindAttachHolds(() => { holds += 1; }, () => { holds -= 1; });
  const old = await events.armEventForTab({ tabId: 7, sessionKey: "old", type: "popup" });
  await events.disarmArmedEvent(old.token);
  const current = await events.armEventForTab({ tabId: 7, sessionKey: "current", type: "popup" });
  events.stopSessionPageEvents("old");
  events.stopSessionPageEvents("old");
  expect(holds).toBe(1);
  await events.disarmArmedEvent(current.token);
  expect(holds).toBe(0);
});

it("stopping a consumed historical session cannot disable a newer chooser interception", async () => {
  const events = await import("../src/background/page-events.js");
  events.bindAttachHolds(() => {}, () => {});
  const old = await events.armEventForTab({ tabId: 7, sessionKey: "old", type: "filechooser" });
  await events.disarmArmedEvent(old.token);
  await events.armEventForTab({ tabId: 7, sessionKey: "new", type: "filechooser" });
  vi.mocked(chrome.debugger.sendCommand).mockClear();
  events.stopSessionPageEvents("old");
  await vi.advanceTimersByTimeAsync(0);
  expect(chrome.debugger.sendCommand).not.toHaveBeenCalled();
});

it("detach invalidates the armed token and promptly rejects its waiter", async () => {
  let holds = 0;
  const events = await import("../src/background/page-events.js");
  events.bindAttachHolds(() => { holds += 1; }, () => { holds -= 1; });
  const arm = await events.armEventForTab({ tabId: 7, sessionKey: "a", type: "popup" });
  const pending = events.waitArmedEvent(arm.token).then(() => "unexpected success", e => String(e));
  events.notePageEventsDetached(7);
  await vi.advanceTimersByTimeAsync(0);
  const result = await Promise.race([pending, Promise.resolve("waiter still pending")]);
  expect(result).toMatch(/CAPTURE_INCOMPLETE/);
  expect(holds).toBe(0);
});
