/**
 * CAP-02A 反例：arm/token/匹配/消费生命周期。
 * 期望值来自任务书可观察行为，不用实现重算冒充通过。
 */
import { describe, expect, it } from "vitest";
import {
  applyDownloadProgress,
  armPageEvent,
  cancelArm,
  consumeArm,
  consumeBufferedEvents,
  createPageEventLedger,
  disposeSessionArms,
  findDownload,
  isHostEventToken,
  matchDownloadBegin,
  matchFileChooser,
  matchPopup,
  markArmTimedOut,
  requireArm,
  setPendingDialog,
  clearPendingDialog,
} from "../../shared/page-event-ledger.js";

describe("CAP-02A page-event ledger", () => {
  it("host token 可识别；模型伪造 token 被拒", () => {
    const ledger = createPageEventLedger();
    const arm = armPageEvent(ledger, { kind: "popup", tabId: 1, sessionKey: "s1" });
    expect(isHostEventToken(arm.token)).toBe(true);
    expect(isHostEventToken("evt_popup_1_1_abc")).toBe(true);
    expect(isHostEventToken("I-made-this-token")).toBe(false);
    expect(isHostEventToken("evt_popup_x_1_abc")).toBe(false);
    expect(() => requireArm(ledger, "forged-token")).toThrow(/model-minted|unknown/i);
  });

  it("瞬时 popup：先 arm 再匹配才可 consume；先点后听会丢掉", () => {
    const ledger = createPageEventLedger();
    // 先点后听：无可匹配的 arm → 事件不可被后续 wait 消费
    expect(matchPopup(ledger, { openerTabId: 10, popupTabId: 11, url: "https://x.test/p" })).toBeUndefined();
    const late = armPageEvent(ledger, { kind: "popup", tabId: 10, sessionKey: "s" });
    expect(() => consumeArm(ledger, late.token)).toThrow(/EVENT_PENDING/);

    const armed = armPageEvent(ledger, { kind: "popup", tabId: 20, sessionKey: "s" });
    const matched = matchPopup(ledger, { openerTabId: 20, popupTabId: 21, url: "https://x.test/new", targetId: "t21" });
    expect(matched?.token).toBe(armed.token);
    const consumed = consumeArm(ledger, armed.token);
    expect(consumed.popupTabId).toBe(21);
    expect(consumed.popupUrl).toBe("https://x.test/new");
    expect(() => consumeArm(ledger, armed.token)).toThrow(/already consumed/);
  });

  it("两页同名下载：各 tab 独立 downloadPath / downloadId，不串任务", () => {
    const ledger = createPageEventLedger();

    const a = armPageEvent(ledger, {
      kind: "download",
      tabId: 1,
      sessionKey: "s",
      downloadPath: "/tmp/bys-dl-a",
    });

    const b = armPageEvent(ledger, {
      kind: "download",
      tabId: 2,
      sessionKey: "s",
      downloadPath: "/tmp/bys-dl-b",
    });

    const ma = matchDownloadBegin(ledger, {
      tabId: 1,
      guid: "g1",
      url: "blob:https://example/a",
      suggestedFilename: "report.pdf",
    });

    const mb = matchDownloadBegin(ledger, {
      tabId: 2,
      guid: "g2",
      url: "blob:https://example/b",
      suggestedFilename: "report.pdf",
    });

    expect(ma?.download.downloadPath).toBe("/tmp/bys-dl-a");
    expect(mb?.download.downloadPath).toBe("/tmp/bys-dl-b");
    expect(ma?.download.downloadId).not.toBe(mb?.download.downloadId);
    expect(ma?.arm.token).toBe(a.token);
    expect(mb?.arm.token).toBe(b.token);
    expect(findDownload(ledger, ma!.download.downloadId).tabId).toBe(1);
    expect(findDownload(ledger, mb!.download.downloadId).tabId).toBe(2);
  });

  it("下载失败与取消分别留证", () => {
    const ledger = createPageEventLedger();
    armPageEvent(ledger, { kind: "download", tabId: 3, sessionKey: "s", downloadPath: "/tmp/bys-dl-c" });

    const matched = matchDownloadBegin(ledger, {
      tabId: 3,
      guid: "gc",
      url: "https://example/f.bin",
      suggestedFilename: "f.bin",
    });

    applyDownloadProgress(ledger, { guid: "gc", state: "canceled" });
    const dl = findDownload(ledger, matched!.download.downloadId);
    expect(dl.failure).toBe("canceled");
    expect(dl.cancelled).toBe(true);
    expect(dl.completed).toBe(false);
  });

  it("动态 filechooser：arm 后匹配，暴露 multiple 与 chooserId", () => {
    const ledger = createPageEventLedger();
    const arm = armPageEvent(ledger, { kind: "filechooser", tabId: 4, sessionKey: "s" });
    const matched = matchFileChooser(ledger, { tabId: 4, backendNodeId: 99, mode: "selectMultiple" });
    expect(matched?.token).toBe(arm.token);
    expect(matched?.multiple).toBe(true);
    expect(matched?.chooserId).toMatch(/^fc_/);
    expect(matched?.backendNodeId).toBe(99);
  });

  it("错误 token / 超时 / 停止后迟到事件安全失败", () => {
    const ledger = createPageEventLedger();
    const arm = armPageEvent(ledger, { kind: "popup", tabId: 5, sessionKey: "run-1" });
    markArmTimedOut(ledger, arm.token);
    expect(() => consumeArm(ledger, arm.token)).toThrow(/timed_out/);

    const live = armPageEvent(ledger, { kind: "popup", tabId: 6, sessionKey: "run-1" });
    disposeSessionArms(ledger, "run-1", "session stopped");
    expect(ledger.arms.get(live.token)?.status).toBe("disposed");
    // 停止后迟到 popup：无可消费的 armed 匹配
    expect(matchPopup(ledger, { openerTabId: 6, popupTabId: 60 })).toBeUndefined();
    cancelArm(ledger, arm.token);
    expect(() => requireArm(ledger, "evt_download_9_1_zzzzzzzz")).toThrow(/unknown or expired/);
  });

  it("dialog 缓冲可观察；consume_events 一次清空", () => {
    const ledger = createPageEventLedger();
    setPendingDialog(ledger, {
      type: "confirm",
      message: "删除？",
      tabId: 7,
      url: "https://example/app",
      openedAt: 1000,
    });
    const events = consumeBufferedEvents(ledger, 7, true);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("dialog");
    expect(events[0]?.payload.message).toBe("删除？");
    expect(consumeBufferedEvents(ledger, 7, true)).toEqual([]);
    expect(clearPendingDialog(ledger, 7)?.type).toBe("confirm");
  });

  it("同一 tab 不能并行两个同 kind arm（防串听）", () => {
    const ledger = createPageEventLedger();
    armPageEvent(ledger, { kind: "download", tabId: 8, sessionKey: "s", downloadPath: "/tmp/a" });
    expect(() =>
      armPageEvent(ledger, { kind: "download", tabId: 8, sessionKey: "s", downloadPath: "/tmp/b" }),
    ).toThrow(/already has an active download/);
  });
});
