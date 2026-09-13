import { beforeEach, describe, expect, it, vi } from "vitest";

type ExecDetails = {
  target: { tabId: number };
  files?: string[];
  func?: unknown;
  args?: unknown[];
};

type ChromeDouble = {
  executeScript: ReturnType<typeof vi.fn>;
  /** 每次 executeScript：tabId + 画/收（无 args 的是注入 cursor 脚本）。 */
  log: Array<{ tabId: number; show?: boolean; status?: string }>;
  /** 放行被扣住的展示绘制。 */
  release: () => void;
};

function installChrome(opts: { activeTabId?: number | null; holdNextShow?: boolean } = {}): ChromeDouble {
  const log: ChromeDouble["log"] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let hold = opts.holdNextShow === true;
  const executeScript = vi.fn(async (details: ExecDetails) => {
    const show = Array.isArray(details.args) ? (details.args[0] as boolean) : undefined;
    log.push({ tabId: details.target.tabId, show, status: (details.args?.[1] as {status?:string} | undefined)?.status });
    if (hold && show === true) {
      hold = false;
      await gate;
    }
    return [{ frameId: 0, result: undefined }];
  });
  vi.stubGlobal("chrome", {
    debugger: { onDetach: { addListener: vi.fn() } },
    scripting: { executeScript },
    tabs: {
      onRemoved: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
      query: vi.fn(async () => (opts.activeTabId == null ? [] : [{ id: opts.activeTabId }])),
    },
  });
  return { executeScript, log, release };
}

function shown(log: ChromeDouble["log"]): number[] {
  return log.filter((c) => c.show === true).map((c) => c.tabId);
}

function hidden(log: ChromeDouble["log"]): number[] {
  return log.filter((c) => c.show === false).map((c) => c.tabId);
}

function lastOp(log: ChromeDouble["log"], tabId: number): boolean | undefined {
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const call = log[i];
    if (call && call.tabId === tabId && call.show !== undefined) return call.show;
  }
  return undefined;
}

const view = { status: "正在恢复", action: "交还", actionEnabled: true };

describe("控制条生命周期：按会话清除实际画过的条", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("恢复完成清掉活动页残留（任务绑定 41，活动页 73）", async () => {
    const dou = installChrome({ activeTabId: 73 });
    const { showTeamControlBanners, hideControlBannersForOwner } = await import(
      "../src/background/exec/input.js"
    );

    // 展示：成员页 41 + 当前活动页 73
    await showTeamControlBanners([41], view, "A");
    expect(shown(dou.log)).toEqual([41, 73]);

    dou.log.length = 0;
    // 恢复完成：按会话清除实际展示过的条
    await hideControlBannersForOwner("A", [41]);

    expect(hidden(dou.log).sort((a, b) => a - b)).toEqual([41, 73]);
    expect(lastOp(dou.log, 41)).toBe(false);
    expect(lastOp(dou.log, 73)).toBe(false);
  });

  it("不误清另一暂停会话的条（A 恢复不影响 B 的活动页）", async () => {
    const dou = installChrome({ activeTabId: 73 });
    const { showTeamControlBanners, hideControlBannersForOwner } = await import(
      "../src/background/exec/input.js"
    );

    await showTeamControlBanners([41], view, "A");
    await showTeamControlBanners([42], view, "B");
    dou.log.length = 0;

    await hideControlBannersForOwner("A", [41]);

    expect(hidden(dou.log)).toEqual([41]);
    // 73 同时被 B 画着，A 释放后不能收；42 只属于 B
    expect(lastOp(dou.log, 73)).not.toBe(false);
    expect(lastOp(dou.log, 42)).not.toBe(false);
  });

  it("迟到的异步展示不能令旧条复活", async () => {
    const dou = installChrome({ activeTabId: 73, holdNextShow: true });
    const { showTeamControlBanners, hideControlBannersForOwner } = await import(
      "../src/background/exec/input.js"
    );

    const late = showTeamControlBanners([41], view, "A");
    await hideControlBannersForOwner("A", [41]);
    dou.release();
    await late;

    expect(lastOp(dou.log, 41)).toBe(false);
    expect(lastOp(dou.log, 73)).not.toBe(true);
  });

  it("成员页在恢复期间变化，仍按展示过的页清除", async () => {
    const dou = installChrome({ activeTabId: 73 });
    const { showTeamControlBanners, hideControlBannersForOwner } = await import(
      "../src/background/exec/input.js"
    );

    await showTeamControlBanners([41], view, "A");
    dou.log.length = 0;
    // 恢复完成时成员绑定已变成 42，旧展示页 41/73 仍要收
    await hideControlBannersForOwner("A", [42]);

    expect(hidden(dou.log).sort((a, b) => a - b)).toEqual([41, 42, 73]);
  });
});


it("旧页展示跨过清理和新页展示后，旧页仍然收起", async()=>{
  vi.resetModules(); const dou=installChrome({holdNextShow:true});
  const {showTeamControlBanners:show,hideControlBannersForOwner:hide}=await import("../src/background/exec/input.js");
  const old=show([41],{status:"旧状态"},"A");
  for(let i=0;i<30&&!shown(dou.log).length;i++)await Promise.resolve();
  expect(shown(dou.log)).toContain(41);
  const cleared=hide("A");
  await show([42],{status:"新状态"},"A");
  dou.release(); await Promise.all([old,cleared]);
  expect(lastOp(dou.log,41)).toBe(false);
  expect(lastOp(dou.log,42)).toBe(true);
  await hide("A"); expect(lastOp(dou.log,42)).toBe(false);
});

it("同页旧绘制迟到时，最终文案仍是新状态", async()=>{
  vi.resetModules(); const dou=installChrome({holdNextShow:true});
  const {showTeamControlBanners:show,hideControlBannersForOwner:hide}=await import("../src/background/exec/input.js");
  const old=show([41],{status:"正在恢复"},"A");
  for(let i=0;i<30&&!shown(dou.log).length;i++)await Promise.resolve();
  expect(shown(dou.log)).toContain(41);
  const cleared=hide("A"); const fresh=show([41],{status:"现在归你"},"A");
  dou.release(); await Promise.all([old,cleared,fresh]);
  expect(dou.log.filter(x=>x.show!==undefined).at(-1)).toMatchObject({tabId:41,show:true,status:"现在归你"});
});


it("非成员活动页的交还关联实际展示会话，清除后不再可路由", async()=>{
  vi.resetModules(); installChrome({activeTabId:73});
  const banners=await import("../src/background/exec/input.js");
  await banners.showTeamControlBanners([41],view,"A");
  expect(banners.getControlBannerOwner(73)).toBe("A");
  await banners.showTeamControlBanners([42],view,"B");
  expect(banners.getControlBannerOwner(73)).toBe("B");
  await banners.hideControlBannersForOwner("B");
  expect(banners.getControlBannerOwner(73)).toBe("A");
  await banners.hideControlBannersForOwner("A");
  expect(banners.getControlBannerOwner(73)).toBeUndefined();
});
