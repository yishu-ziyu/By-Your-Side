import { describe, expect, it } from "vitest";
import {
  READING_DEFAULT_PREFS,
  ReadingSettingsStore,
  normalizeReadingPrefs,
  readingStyleVars,
  sameReadingPrefs,
  type ReadingPrefs,
  type ReadingSettingsPort,
  type ReadingStatus,
} from "../src/sidepanel/reading-settings.js";

/** 让挂起的 Promise 落地。 */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/**
 * 可控的假存储：能挂起读取/写入、按次数注入失败，并像 chrome.storage.onChanged 那样回放回声。
 */
class FakePort implements ReadingSettingsPort {
  saves: ReadingPrefs[] = [];
  loadCalls = 0;
  failNextSaves = 0;
  maxInFlight = 0;
  stored: unknown;
  private inFlight = 0;
  private loadGate: ReturnType<typeof gate> | null = null;
  private saveGate: ReturnType<typeof gate> | null = null;
  private listeners = new Set<(raw: unknown) => void>();

  constructor(stored?: unknown) {
    this.stored = stored;
  }

  holdLoad(): () => void {
    const held = gate();
    this.loadGate = held;
    return held.release;
  }

  holdSave(): () => void {
    const held = gate();
    this.saveGate = held;
    return held.release;
  }

  async load(): Promise<unknown> {
    this.loadCalls += 1;
    await this.loadGate?.promise;
    return this.stored;
  }

  async save(prefs: ReadingPrefs): Promise<void> {
    this.saves.push({ ...prefs });
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await this.saveGate?.promise;
      if (this.failNextSaves > 0) {
        this.failNextSaves -= 1;
        throw new Error("QUOTA_BYTES quota exceeded");
      }
      this.stored = { ...prefs };
      for (const listener of this.listeners) listener({ ...prefs }); // 自己写入的回声
    } finally {
      this.inFlight -= 1;
    }
  }

  subscribe(listener: (raw: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 模拟另一个面板/窗口写入。 */
  emit(raw: unknown): void {
    for (const listener of this.listeners) listener(raw);
  }
}

/**
 * 更贴近真实 chrome 的存储：写入「已提交并广播」与「写入 Promise 落地」可以分开控制。
 * 用来复现「本地 save 已 commit 且已回声，但 Promise 还没 resolve，期间又收到别窗口最终写」
 * 的顺序错配。
 */
class OutOfOrderPort implements ReadingSettingsPort {
  stored: unknown;
  private readonly listeners = new Set<(raw: unknown) => void>();
  private readonly settles: Array<() => void> = [];

  constructor(stored?: unknown) {
    this.stored = stored;
  }

  async load(): Promise<unknown> {
    return this.stored;
  }

  save(prefs: ReadingPrefs): Promise<void> {
    this.stored = { ...prefs }; // 提交先于 Promise 落地
    for (const listener of this.listeners) listener({ ...prefs }); // 自己写入的回声
    return new Promise<void>((resolve) => this.settles.push(resolve));
  }

  subscribe(listener: (raw: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 另一个窗口/面板写入。 */
  emit(raw: unknown): void {
    this.stored = { ...(raw as ReadingPrefs) };
    for (const listener of this.listeners) listener(raw);
  }

  /** 放行最早那次还没落地的写入 Promise。 */
  settle(): void {
    this.settles.shift()?.();
  }
}

function createHarness(stored?: unknown) {
  const port = new FakePort(stored);
  const applied: ReadingPrefs[] = [];
  const statuses: ReadingStatus[] = [];
  const store = new ReadingSettingsStore({
    port,
    apply: (prefs) => applied.push({ ...prefs }),
    onStatus: (status) => statuses.push({ ...status }),
  });
  return { port, applied, statuses, store };
}

describe("normalizeReadingPrefs：只认白名单档位", () => {
  it("空值/缺字段回默认", () => {
    expect(normalizeReadingPrefs(undefined)).toEqual(READING_DEFAULT_PREFS);
    expect(normalizeReadingPrefs(null)).toEqual(READING_DEFAULT_PREFS);
    expect(normalizeReadingPrefs({})).toEqual(READING_DEFAULT_PREFS);
    expect(normalizeReadingPrefs({ font: "hei" })).toEqual({ font: "hei", size: "normal" });
    expect(normalizeReadingPrefs({ size: "large" })).toEqual({ font: "song", size: "large" });
  });

  it("旧/非法档位逐字段回默认，不整条丢弃", () => {
    expect(normalizeReadingPrefs({ font: "comic-sans", size: "huge" })).toEqual(READING_DEFAULT_PREFS);
    expect(normalizeReadingPrefs({ font: "comic-sans", size: "large" })).toEqual({ font: "song", size: "large" });
    expect(normalizeReadingPrefs({ font: "song", size: 15 })).toEqual({ font: "song", size: "normal" });
  });

  it("非对象与数组输入不崩，回默认", () => {
    expect(normalizeReadingPrefs("song")).toEqual(READING_DEFAULT_PREFS);
    expect(normalizeReadingPrefs(15)).toEqual(READING_DEFAULT_PREFS);
    expect(normalizeReadingPrefs(["hei", "large"])).toEqual(READING_DEFAULT_PREFS);
  });

  it("默认值只有一份，且被冻结", () => {
    expect(normalizeReadingPrefs(READING_DEFAULT_PREFS)).toEqual(READING_DEFAULT_PREFS);
    expect(Object.isFrozen(READING_DEFAULT_PREFS)).toBe(true);
    expect(sameReadingPrefs({ font: "song", size: "normal" }, READING_DEFAULT_PREFS)).toBe(true);
  });
});

describe("readingStyleVars：默认档位交回 CSS，非默认才覆盖", () => {
  it("宋体 + 标准不写变量（用 styles.css 的默认）", () => {
    expect(readingStyleVars({ font: "song", size: "normal" })).toEqual({
      "--reading-font": null,
      "--reading-size": null,
    });
  });

  it("黑体/系统默认给出对应字体栈，系统默认接 var(--font)", () => {
    expect(readingStyleVars({ font: "hei", size: "normal" })["--reading-font"]).toContain("Heiti SC");
    expect(readingStyleVars({ font: "system", size: "normal" })["--reading-font"]).toBe("var(--font)");
  });

  it("小/大给出 13px / 17px", () => {
    expect(readingStyleVars({ font: "song", size: "small" })["--reading-size"]).toBe("13px");
    expect(readingStyleVars({ font: "song", size: "large" })["--reading-size"]).toBe("17px");
  });

  it("非法输入按默认档位处理，不写出野值", () => {
    const vars = readingStyleVars({ font: "comic", size: "enormous" } as unknown as ReadingPrefs);
    expect(vars).toEqual({ "--reading-font": null, "--reading-size": null });
  });
});

describe("启动读取", () => {
  it("读到已存偏好就应用（含旧非法值回默认）", async () => {
    const good = createHarness({ font: "hei", size: "large" });
    await good.store.start();
    expect(good.store.prefs).toEqual({ font: "hei", size: "large" });
    expect(good.applied.at(-1)).toEqual({ font: "hei", size: "large" });

    const legacy = createHarness({ font: "helvetica", size: "medium" });
    await legacy.store.start();
    expect(legacy.store.prefs).toEqual(READING_DEFAULT_PREFS);
  });

  it("读取失败按默认显示，不当成已存偏好", async () => {
    const port = new FakePort({ font: "hei", size: "large" });
    port.load = async () => {
      throw new Error("storage unavailable");
    };
    const applied: ReadingPrefs[] = [];
    const store = new ReadingSettingsStore({ port, apply: (prefs) => applied.push({ ...prefs }) });
    await store.start();
    expect(store.prefs).toEqual(READING_DEFAULT_PREFS);
  });

  it("异步读取不覆盖用户刚选的值", async () => {
    const { port, store, applied } = createHarness({ font: "system", size: "small" });
    const release = port.holdLoad();
    const starting = store.start();
    store.update({ font: "hei" }); // 读取还没回来，用户先动了
    release();
    await starting;
    expect(store.prefs).toEqual({ font: "hei", size: "normal" });
    expect(applied.at(-1)).toEqual({ font: "hei", size: "normal" });
  });

  it("读取未返回时先到的 storage 事件，不被随后的过期读取覆盖", async () => {
    // 存储里真实的旧值是 song/normal；读取还没回来，更晚的事件 hei/large 先到。
    const { port, store, applied } = createHarness({ font: "song", size: "normal" });
    const release = port.holdLoad();
    const starting = store.start();
    port.emit({ font: "hei", size: "large" });
    expect(store.prefs).toEqual({ font: "hei", size: "large" });
    release();
    await starting;
    expect(store.prefs).toEqual({ font: "hei", size: "large" });
    expect(applied.at(-1)).toEqual({ font: "hei", size: "large" });
  });

  it("读取期间收到恰好等于默认的 storage 事件，也不被过期读取覆盖", async () => {
    // 存储里是过期的 hei/large；读取还没回来，更晚的事件把设置改回默认 song/normal。
    const { port, store } = createHarness({ font: "hei", size: "large" });
    const release = port.holdLoad();
    const starting = store.start();
    port.emit({ font: "song", size: "normal" });
    release();
    await starting;
    expect(store.prefs).toEqual(READING_DEFAULT_PREFS);
  });
});

describe("保存顺序与失败可见", () => {
  it("连续修改按顺序写，写入期间的改动接在上一次之后，最后落到最新值", async () => {
    const { port, store } = createHarness();
    await store.start();
    const release = port.holdSave();
    store.update({ font: "hei" });
    store.update({ size: "large" });
    release();
    await tick();
    await tick();
    expect(port.saves).toEqual([
      { font: "hei", size: "normal" },
      { font: "hei", size: "large" },
    ]);
    expect(port.maxInFlight).toBe(1); // 没有并发写入
    expect(port.stored).toEqual({ font: "hei", size: "large" });
    expect(store.saveState).toBe("saved");
  });

  it("保存失败提示未保存、保留新选择，重试后才说已保存", async () => {
    const { port, store, statuses } = createHarness();
    await store.start();
    port.failNextSaves = 1;
    store.update({ size: "small" });
    await tick();
    expect(store.saveState).toBe("error");
    expect(statuses.at(-1)).toEqual({ state: "error", message: "QUOTA_BYTES quota exceeded" });
    expect(statuses.some((status) => status.state === "saved")).toBe(false);
    expect(store.prefs).toEqual({ font: "song", size: "small" }); // 界面仍是用户选的
    expect(port.stored).toBeUndefined(); // 没有真的写进去

    store.retry();
    await tick();
    expect(store.saveState).toBe("saved");
    expect(port.stored).toEqual({ font: "song", size: "small" });
  });

  it("失败后再次修改也续上未写回的值", async () => {
    const { port, store } = createHarness();
    await store.start();
    port.failNextSaves = 1;
    store.update({ size: "small" });
    await tick();
    expect(store.saveState).toBe("error");
    store.update({ font: "hei" });
    await tick();
    expect(store.saveState).toBe("saved");
    expect(port.stored).toEqual({ font: "hei", size: "small" });
  });

  it("恢复默认走同一条自动保存路径", async () => {
    const { port, store } = createHarness();
    await store.start();
    store.update({ font: "system", size: "large" });
    await tick();
    store.reset();
    await tick();
    expect(store.prefs).toEqual(READING_DEFAULT_PREFS);
    expect(port.stored).toEqual(READING_DEFAULT_PREFS);
  });
});

describe("多面板同步", () => {
  it("自己写入的回声不重复应用", async () => {
    const { store, applied, port } = createHarness();
    await store.start();
    applied.length = 0;
    store.update({ size: "large" });
    await tick();
    expect(applied).toEqual([{ font: "song", size: "large" }]); // 只有本地那一次
    port.emit({ font: "song", size: "large" }); // 回声
    expect(applied).toHaveLength(1);
  });

  it("另一个面板的改动在空闲时同步过来", async () => {
    const { store, port } = createHarness();
    await store.start();
    port.emit({ font: "hei", size: "large" });
    expect(store.prefs).toEqual({ font: "hei", size: "large" });
  });

  it("本地还有未写回改动时，忽略更旧的远端值", async () => {
    const { store, port } = createHarness();
    await store.start();
    const release = port.holdSave();
    store.update({ font: "hei" });
    port.emit({ font: "song", size: "normal" }); // 旧回声
    expect(store.prefs).toEqual({ font: "hei", size: "normal" });
    release();
    await tick();
    await tick();
    expect(store.prefs).toEqual({ font: "hei", size: "normal" });
  });

  it("本地写入已提交但 Promise 未落地时，另一窗口的最终值仍会收敛", async () => {
    // 存储里本来就是默认；本地写 hei 已 commit 并回声，但它的 Promise 还悬着。
    const port = new OutOfOrderPort({ font: "song", size: "normal" });
    const applied: ReadingPrefs[] = [];
    const store = new ReadingSettingsStore({ port, apply: (prefs) => applied.push({ ...prefs }) });
    await store.start();

    store.update({ font: "hei" }); // 本地写 hei：已提交、已回声，Promise 悬着
    expect(port.stored).toEqual({ font: "hei", size: "normal" });
    port.emit({ font: "song", size: "large" }); // 另一窗口写入最终值
    expect(store.prefs).toEqual({ font: "hei", size: "normal" }); // 写入中不轻信事件
    expect(port.stored).toEqual({ font: "song", size: "large" });

    port.settle(); // 旧写入 Promise 才落地
    await tick();
    await tick();
    expect(store.prefs).toEqual({ font: "song", size: "large" }); // 收敛到最终存储
    expect(applied.at(-1)).toEqual({ font: "song", size: "large" });
  });

  it("stop 之后不再接收远端改动", async () => {
    const { store, port } = createHarness();
    await store.start();
    store.stop();
    port.emit({ font: "hei", size: "large" });
    expect(store.prefs).toEqual(READING_DEFAULT_PREFS);
  });
});

describe('回读期间的新选择', () => {
  it.each(['local', 'remote'] as const)('%s 更新不会被迟到的权威回读覆盖', async (source) => {
    let stored: ReadingPrefs = { ...READING_DEFAULT_PREFS };
    let receive!: (raw: unknown) => void;
    let loads = 0;
    const heldRead = gate();
    const port: ReadingSettingsPort = {
      async load() {
        const snapshot = { ...stored };
        if (++loads === 2) await heldRead.promise;
        return snapshot;
      },
      async save(prefs) { stored = { ...prefs }; receive(stored); },
      subscribe(fn) { receive = fn; return () => {}; },
    };
    const store = new ReadingSettingsStore({ port, apply: () => {} });
    await store.start();
    store.update({ font: 'hei' });
    await tick();
    expect(loads).toBe(2);
    const latest: ReadingPrefs = { font: 'system', size: 'large' };
    if (source === 'local') store.update(latest);
    else { stored = latest; receive(latest); }
    await tick();
    heldRead.release();
    await tick();
    expect(store.prefs).toEqual(latest);
    expect(stored).toEqual(latest);
  });
});
