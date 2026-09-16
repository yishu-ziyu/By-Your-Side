/**
 * 阅读外观：右上角的设置齿轮，以及从它展开的「阅读外观」面板。
 *
 * 职责边界：
 * - 偏好状态、存储读写、保存顺序都在本模块内，入口只注入 DOM 宿主，不保留状态镜像。
 * - 只改回答正文（.msg.assistant.markdown）的字体与字号，靠 styles.css 里的
 *   --reading-font / --reading-size 两个变量下发；按钮、状态、输入框等其余 UI 字体不动。
 * - 默认值只在 READING_DEFAULT_PREFS 定义一次；默认档位的 CSS 值由 styles.css 的 :root 提供，
 *   这里只覆盖「非默认」档位，避免同一份默认值散落两处。
 */
import { createElement as icon, Settings } from "lucide";

export type ReadingFont = "song" | "hei" | "system";
export type ReadingSize = "small" | "normal" | "large";

export interface ReadingPrefs {
  font: ReadingFont;
  size: ReadingSize;
}

/** 偏好默认值：解析旧存储、面板初始状态、恢复默认都引用这一处。 */
export const READING_DEFAULT_PREFS: Readonly<ReadingPrefs> = Object.freeze({
  font: "song",
  size: "normal",
});

/** 面板选项文案。像素刻度是给用户看的；默认档位的真源头在 styles.css 的 :root。 */
export const READING_FONT_OPTIONS: ReadonlyArray<{ value: ReadingFont; label: string }> = [
  { value: "song", label: "宋体" },
  { value: "hei", label: "黑体" },
  { value: "system", label: "系统默认" },
];

export const READING_SIZE_OPTIONS: ReadonlyArray<{ value: ReadingSize; label: string }> = [
  { value: "small", label: "小 13px" },
  { value: "normal", label: "标准 15px" },
  { value: "large", label: "大 17px" },
];

/** chrome.storage.local 的键。 */
export const READING_STORAGE_KEY = "sideagent_reading_appearance";

const READING_FONTS: readonly ReadingFont[] = ["song", "hei", "system"];
const READING_SIZES: readonly ReadingSize[] = ["small", "normal", "large"];

/** 非默认字体才需要覆盖变量：宋体是默认，值在 styles.css 的 :root 里。 */
const READING_FONT_OVERRIDES: Record<Exclude<ReadingFont, "song">, string> = {
  hei: '"Heiti SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  system: "var(--font)",
};

/** 非默认字号才需要覆盖变量：标准 15px 是默认，值在 styles.css 的 :root 里。 */
const READING_SIZE_OVERRIDES: Record<Exclude<ReadingSize, "normal">, string> = {
  small: "13px",
  large: "17px",
};

export interface ReadingStyleVars {
  "--reading-font": string | null;
  "--reading-size": string | null;
}

/** 偏好 → CSS 变量。null 表示回到 styles.css 的默认值。 */
export function readingStyleVars(prefs: ReadingPrefs): ReadingStyleVars {
  const normalized = normalizeReadingPrefs(prefs);
  return {
    "--reading-font": normalized.font === "song" ? null : READING_FONT_OVERRIDES[normalized.font],
    "--reading-size": normalized.size === "normal" ? null : READING_SIZE_OVERRIDES[normalized.size],
  };
}

export function sameReadingPrefs(a: ReadingPrefs, b: ReadingPrefs): boolean {
  return a.font === b.font && a.size === b.size;
}

/** 白名单解析：只接受已知档位，缺字段或旧/非法值一律回默认。 */
export function normalizeReadingPrefs(raw: unknown): ReadingPrefs {
  const source =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    font: READING_FONTS.includes(source.font as ReadingFont)
      ? (source.font as ReadingFont)
      : READING_DEFAULT_PREFS.font,
    size: READING_SIZES.includes(source.size as ReadingSize)
      ? (source.size as ReadingSize)
      : READING_DEFAULT_PREFS.size,
  };
}

/** 把偏好写到样式根上（默认 documentElement）；默认档位移除覆盖，交回 CSS。 */
export function applyReadingPrefs(
  prefs: ReadingPrefs,
  root: Pick<HTMLElement, "style"> | null | undefined,
): void {
  if (!root) return;
  for (const [name, value] of Object.entries(readingStyleVars(prefs))) {
    if (value === null) root.style.removeProperty(name);
    else root.style.setProperty(name, value);
  }
}

export interface ReadingSettingsPort {
  /** 读取已保存的偏好；没有记录时返回 undefined。 */
  load(): Promise<unknown>;
  /** 写入偏好；失败必须 reject，界面据此提示未保存。 */
  save(prefs: ReadingPrefs): Promise<void>;
  /** 可选：其他面板/窗口改动后的通知；返回取消订阅函数。 */
  subscribe?(listener: (raw: unknown) => void): () => void;
}

/** 没有 chrome.storage 时的内存回落：预览页不必提供完整 chrome 也能跑。 */
function createMemoryPort(): ReadingSettingsPort {
  let stored: unknown;
  const listeners = new Set<(raw: unknown) => void>();
  return {
    async load() {
      return stored;
    },
    async save(prefs) {
      stored = { ...prefs };
      for (const listener of listeners) listener({ ...prefs });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** 浏览器里的默认端口；缺 storage 事件时只退化为「无跨面板同步」，不报错。 */
export function createChromeReadingPort(): ReadingSettingsPort {
  const local = typeof chrome === "undefined" ? undefined : chrome.storage?.local;
  if (!local) return createMemoryPort();
  return {
    async load() {
      const stored = await local.get(READING_STORAGE_KEY);
      return stored?.[READING_STORAGE_KEY];
    },
    async save(prefs) {
      await local.set({ [READING_STORAGE_KEY]: prefs });
    },
    subscribe(listener) {
      const onChanged = typeof chrome === "undefined" ? undefined : chrome.storage?.onChanged;
      if (!onChanged) return () => {};
      const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
        if (area !== "local") return;
        const change = changes[READING_STORAGE_KEY];
        if (change) listener(change.newValue);
      };
      onChanged.addListener(handler);
      return () => onChanged.removeListener(handler);
    },
  };
}

export type ReadingSaveState = "idle" | "saving" | "saved" | "error";

export interface ReadingStatus {
  state: ReadingSaveState;
  /** 出错时的可读原因（信息缺失时给兜底文案）；非错误态为空。 */
  message: string;
}

export interface ReadingSettingsDeps {
  port: ReadingSettingsPort;
  /** 偏好变化时应用（写 CSS 变量、同步面板控件）。 */
  apply: (prefs: ReadingPrefs) => void;
  onStatus?: (status: ReadingStatus) => void;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const text = typeof error === "string" ? error : "";
  return text || "无法写入本地存储";
}

/**
 * 偏好状态机：立即生效、串行写回、失败可见且可重试。
 *
 * 顺序保证：
 * - 连续修改永远按「最新值」写，写入期间的新改动进入 pending，上一次写完接着写；
 * - 初始读取完成前用户若已改过，读取结果不再覆盖用户选择；
 * - 初始读取完成前若已收到任何 storage 事件（哪怕值恰好等于默认），
 *   也说明有比这次读取更新的权威，同样不覆盖；
 * - 存储事件的回声（值与自己当前一致）或本地仍有未写回改动时，忽略远端值，
 *   避免多面板场景下旧值盖掉新修改；
 * - 写入期间被忽略掉的远端事件不缓存、不盲目回放：等本地写队列清空后回读权威存储收敛，
 *   并用 revision 防止回读结果盖掉期间更新的本地修改或存储事件。
 */
export class ReadingSettingsStore {
  private current: ReadingPrefs = { ...READING_DEFAULT_PREFS };
  private pending: ReadingPrefs | null = null;
  private writing = false;
  /** 每次本地修改或存储事件都自增：用来判断读取/回读是否已经被更新的事实取代。 */
  private revision = 0;
  /** 写入期间是否丢过远端事件；为 true 时写队列清空后回读权威存储。 */
  private reloadPending = false;
  private unsubscribe: (() => void) | null = null;
  private status: ReadingStatus = { state: "idle", message: "" };

  constructor(private readonly deps: ReadingSettingsDeps) {}

  get prefs(): ReadingPrefs {
    return { ...this.current };
  }

  get saveState(): ReadingSaveState {
    return this.status.state;
  }

  /** 启动：先订阅存储事件，再读取已保存偏好。 */
  async start(): Promise<void> {
    this.unsubscribe = this.deps.port.subscribe?.((raw) => this.receiveFromStorage(raw)) ?? null;
    let stored: unknown;
    try {
      stored = await this.deps.port.load();
    } catch {
      stored = undefined; // 读不到就按默认显示，不谎称读到了旧偏好
    }
    // 读取期间用户已改过、或已收到任何 storage 事件（含值等于默认的事件），
    // 都已有比这次读取更新的权威，不能再用可能过期的读取结果覆盖。
    if (this.revision > 0) return;
    this.current = normalizeReadingPrefs(stored);
    this.deps.apply(this.current);
  }

  /** 用户改偏好：立即生效并自动保存。 */
  update(patch: Partial<ReadingPrefs>): void {
    this.revision += 1;
    this.current = normalizeReadingPrefs({ ...this.current, ...patch });
    this.deps.apply(this.current);
    this.enqueue(this.current);
  }

  /** 恢复默认：与普通修改同一路径，立即生效并保存。 */
  reset(): void {
    this.update({ font: READING_DEFAULT_PREFS.font, size: READING_DEFAULT_PREFS.size });
  }

  /** 重试上一次失败的写入；没有待写值时不动作。 */
  retry(): void {
    if (!this.pending) return;
    void this.drain();
  }

  /** 面板销毁：只取消订阅，不回滚已应用的偏好。 */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private enqueue(target: ReadingPrefs): void {
    this.pending = target;
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.writing) return;
    this.writing = true;
    try {
      while (this.pending) {
        const target = this.pending;
        this.pending = null;
        this.setStatus("saving", "");
        try {
          await this.deps.port.save(target);
        } catch (error) {
          // 失败不自转重试：留下待写值，界面提示未保存，用户再改或点重试都会续上。
          if (!this.pending) this.pending = target;
          this.setStatus("error", errorMessage(error));
          return;
        }
        if (!this.pending) this.setStatus("saved", "");
      }
    } finally {
      this.writing = false;
      // 写入期间丢过远端事件：本地队列已空，回读一次权威存储来收敛。
      if (this.reloadPending && !this.pending) {
        this.reloadPending = false;
        void this.reloadAuthority();
      }
    }
  }

  /**
   * 回读权威存储并收敛（只在本地写队列清空、且写入期间丢过事件时调用）。
   * 回读期间若又有本地修改或新的存储事件，交给更新的那一路生效，丢弃这次结果。
   */
  private async reloadAuthority(): Promise<void> {
    const rev = this.revision;
    let stored: unknown;
    try {
      stored = await this.deps.port.load();
    } catch {
      return; // 读不到就保持当前显示，不谎称读到了权威值
    }
    if (this.revision !== rev || this.pending || this.writing) return;
    const incoming = normalizeReadingPrefs(stored);
    if (sameReadingPrefs(incoming, this.current)) return;
    this.current = incoming;
    this.deps.apply(this.current);
  }

  private receiveFromStorage(raw: unknown): void {
    // 任何存储事件都算更新的事实：读取/回读的旧结果不得覆盖它，哪怕是读旧值。
    this.revision += 1;
    if (this.pending || this.writing) {
      // 本地还有未写回的改动：不轻信这一刻的事件（可能是自己的旧回声），
      // 记下来，等队列清空后回读权威存储。
      this.reloadPending = true;
      return;
    }
    const incoming = normalizeReadingPrefs(raw);
    if (sameReadingPrefs(incoming, this.current)) return; // 自己写入的回声，免得多余重绘
    this.current = incoming;
    this.deps.apply(this.current);
  }

  private setStatus(state: ReadingSaveState, message: string): void {
    this.status = { state, message };
    this.deps.onStatus?.(this.status);
  }
}

const SAVE_STATUS_TEXT: Record<ReadingSaveState, string> = {
  idle: "",
  saving: "保存中…",
  saved: "已保存",
  error: "未保存",
};

export interface ReadingSettingsHost {
  /** 顶部宿主：挂载外观面板，未传入口时附带默认按钮。 */
  topbar: HTMLElement;
  /** 复用更多菜单中的入口，关闭时回到可见的更多按钮。 */
  trigger?: HTMLButtonElement;
  returnFocus?: HTMLElement;
  /** 应用容器，仅在需要时用于收敛面板位置。 */
  app?: HTMLElement | null;
  /** 写 CSS 变量的元素；默认 document.documentElement。 */
  styleRoot?: HTMLElement | null;
  /** 存储端口；默认 chrome.storage.local（无 chrome 时退化为内存）。 */
  port?: ReadingSettingsPort;
  /** 文档；默认当前 document。 */
  doc?: Document;
}

export interface ReadingSettingsHandle {
  store: ReadingSettingsStore;
  open(): void;
  close(): void;
  destroy(): void;
}

/** 挂载右上角阅读外观入口。state 全在模块内，入口只提供 DOM 宿主。 */
export function mountReadingSettings(host: ReadingSettingsHost): ReadingSettingsHandle {
  const doc = host.doc ?? document;
  const styleRoot = host.styleRoot ?? doc.documentElement;

  const wrapper = doc.createElement("div");
  wrapper.className = "reading-settings";

  const button = host.trigger ?? doc.createElement("button");
  button.id = "reading-settings-btn";
  button.type = "button";
  button.className = "reading-settings-btn";
  button.title = host.trigger ? "阅读外观" : "设置";
  button.setAttribute("aria-label", host.trigger ? "阅读外观" : "设置");
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", "reading-settings-panel");
  if (!host.trigger) button.append(icon(Settings));

  const panel = doc.createElement("section");
  panel.id = "reading-settings-panel";
  panel.className = "reading-settings-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "阅读外观");
  panel.hidden = true;

  const head = doc.createElement("div");
  head.className = "reading-settings-head";
  const title = doc.createElement("h2");
  title.textContent = "阅读外观";
  const closeBtn = doc.createElement("button");
  closeBtn.id = "reading-settings-close";
  closeBtn.type = "button";
  closeBtn.textContent = "关闭";
  head.append(title, closeBtn);

  function field(rowLabel: string, selectId: string, options: ReadonlyArray<{ value: string; label: string }>) {
    const row = doc.createElement("div");
    row.className = "reading-settings-row";
    const label = doc.createElement("label");
    label.setAttribute("for", selectId);
    label.textContent = rowLabel;
    const select = doc.createElement("select");
    select.id = selectId;
    select.className = "reading-settings-select";
    for (const option of options) {
      const el = doc.createElement("option");
      el.value = option.value;
      el.textContent = option.label;
      select.append(el);
    }
    row.append(label, select);
    return { row, select };
  }

  const fontField = field("字体", "reading-settings-font", READING_FONT_OPTIONS);
  const sizeField = field("字号", "reading-settings-size", READING_SIZE_OPTIONS);
  const hint = doc.createElement("p");
  hint.className = "reading-settings-hint";
  hint.textContent = "只改回答正文。代码仍等宽，其他界面不变。";

  const foot = doc.createElement("div");
  foot.className = "reading-settings-foot";
  const resetBtn = doc.createElement("button");
  resetBtn.id = "reading-settings-reset";
  resetBtn.type = "button";
  resetBtn.className = "reading-settings-reset";
  resetBtn.textContent = "恢复默认";
  const status = doc.createElement("p");
  status.id = "reading-settings-status";
  status.className = "reading-settings-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const retryBtn = doc.createElement("button");
  retryBtn.id = "reading-settings-retry";
  retryBtn.type = "button";
  retryBtn.className = "reading-settings-retry";
  retryBtn.textContent = "重试保存";
  retryBtn.hidden = true;
  foot.append(resetBtn, status, retryBtn);

  panel.append(head, fontField.row, sizeField.row, hint, foot);
  if (!host.trigger) wrapper.append(button);
  wrapper.append(panel);
  host.topbar.append(wrapper);

  function syncControls(prefs: ReadingPrefs): void {
    fontField.select.value = prefs.font;
    sizeField.select.value = prefs.size;
  }

  const store = new ReadingSettingsStore({
    port: host.port ?? createChromeReadingPort(),
    apply: (prefs) => {
      applyReadingPrefs(prefs, styleRoot);
      syncControls(prefs);
    },
    onStatus: (next) => {
      status.textContent = next.state === "error" ? `${SAVE_STATUS_TEXT[next.state]}：${next.message}` : SAVE_STATUS_TEXT[next.state];
      status.dataset.state = next.state;
      retryBtn.hidden = next.state !== "error";
    },
  });

  let open = false;

  function focusTrigger(): void {
    (host.returnFocus ?? button).focus();
  }

  function openPanel(): void {
    open = true;
    panel.hidden = false;
    button.setAttribute("aria-expanded", "true");
    fontField.select.focus();
  }

  function closePanel(returnFocus: boolean): void {
    open = false;
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
    // 关闭后焦点不该留在已隐藏的面板里：显式要求或焦点原本在面板内都回到可见入口。
    const active = doc.activeElement;
    if (returnFocus || (active && wrapper.contains(active))) focusTrigger();
  }

  button.addEventListener("click", () => {
    if (open) closePanel(false);
    else openPanel();
  });
  closeBtn.addEventListener("click", () => closePanel(true));

  fontField.select.addEventListener("change", () => {
    store.update({ font: fontField.select.value as ReadingFont });
  });
  sizeField.select.addEventListener("change", () => {
    store.update({ size: sizeField.select.value as ReadingSize });
  });
  resetBtn.addEventListener("click", () => store.reset());
  retryBtn.addEventListener("click", () => store.retry());

  function onDocumentKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      closePanel(true);
    }
  }

  function onOutsidePointerdown(event: Event): void {
    if (!open) return;
    const target = event.target as Node | null;
    if (target && (wrapper.contains(target) || button.contains(target))) return;
    closePanel(false);
  }

  doc.addEventListener("keydown", onDocumentKeydown);
  doc.addEventListener("pointerdown", onOutsidePointerdown, true);

  syncControls(store.prefs);
  void store.start();

  return {
    store,
    open: openPanel,
    close: () => closePanel(true),
    destroy: () => {
      doc.removeEventListener("keydown", onDocumentKeydown);
      doc.removeEventListener("pointerdown", onOutsidePointerdown, true);
      store.stop();
      wrapper.remove();
    },
  };
}
