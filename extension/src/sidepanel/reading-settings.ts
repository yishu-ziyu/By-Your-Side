import { createElement as icon, Settings } from "lucide";

type ReadingFont = "song" | "hei" | "system";

type ReadingSize = "small" | "normal" | "large";

interface ReadingPrefs {
  font: ReadingFont;
  size: ReadingSize;
}

const READING_DEFAULT_PREFS: Readonly<ReadingPrefs> = Object.freeze({
  font: "system",
  size: "normal",
});

const READING_FONT_OPTIONS: ReadonlyArray<{ value: ReadingFont; label: string }> = [
  { value: "song", label: "宋体" },
  { value: "hei", label: "黑体" },
  { value: "system", label: "系统默认" },
];

const READING_SIZE_OPTIONS: ReadonlyArray<{ value: ReadingSize; label: string }> = [
  { value: "small", label: "小 13px" },
  { value: "normal", label: "标准 15px" },
  { value: "large", label: "大 17px" },
];

const READING_STORAGE_KEY = "sideagent_reading_appearance";

const READING_FONTS: readonly ReadingFont[] = ["song", "hei", "system"];

const READING_SIZES: readonly ReadingSize[] = ["small", "normal", "large"];

const READING_FONT_OVERRIDES: Record<Exclude<ReadingFont, "system">, string> = {
  hei: '"Heiti SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  song: '"Songti SC", "STSong", "Songti TC", "SimSun", serif',
};

const READING_SIZE_OVERRIDES: Record<Exclude<ReadingSize, "normal">, string> = {
  small: "13px",
  large: "17px",
};

interface ReadingStyleVars {
  "--reading-font": string | null;
  "--reading-size": string | null;
}

function readingStyleVars(prefs: ReadingPrefs): ReadingStyleVars {
  const normalized = normalizeReadingPrefs(prefs);

  return {
    "--reading-font": normalized.font === "system" ? null : READING_FONT_OVERRIDES[normalized.font],
    "--reading-size": normalized.size === "normal" ? null : READING_SIZE_OVERRIDES[normalized.size],
  };
}

function sameReadingPrefs(a: ReadingPrefs, b: ReadingPrefs): boolean {
  return a.font === b.font && a.size === b.size;
}

function normalizeReadingPrefs(raw: unknown): ReadingPrefs {
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

function applyReadingPrefs(
  prefs: ReadingPrefs,
  root: Pick<HTMLElement, "style"> | null | undefined,
): void {
  if (!root) return;

  for (const [name, value] of Object.entries(readingStyleVars(prefs))) {
    if (value === null) root.style.removeProperty(name);
    else root.style.setProperty(name, value);
  }
}

interface ReadingSettingsPort {
  load(): Promise<unknown>;
  save(prefs: ReadingPrefs): Promise<void>;
  subscribe?(listener: (raw: unknown) => void): () => void;
}

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

function createChromeReadingPort(): ReadingSettingsPort {
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

type ReadingSaveState = "idle" | "saving" | "saved" | "error";

interface ReadingStatus {
  state: ReadingSaveState;
  message: string;
}

interface ReadingSettingsDeps {
  port: ReadingSettingsPort;
  apply: (prefs: ReadingPrefs) => void;
  onStatus?: (status: ReadingStatus) => void;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const text = typeof error === "string" ? error : "";

  return text || "无法写入本地存储";
}

class ReadingSettingsStore {
  private current: ReadingPrefs = { ...READING_DEFAULT_PREFS };
  private pending: ReadingPrefs | null = null;
  private writing = false;
  private revision = 0;
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

  async start(): Promise<void> {
    this.unsubscribe = this.deps.port.subscribe?.((raw) => this.receiveFromStorage(raw)) ?? null;
    let stored: unknown;

    try {
      stored = await this.deps.port.load();
    } catch {
      stored = undefined;
    }

    if (this.revision > 0) return;
    this.current = normalizeReadingPrefs(stored);
    this.deps.apply(this.current);
  }

  update(patch: Partial<ReadingPrefs>): void {
    this.revision += 1;
    this.current = normalizeReadingPrefs({ ...this.current, ...patch });
    this.deps.apply(this.current);
    this.enqueue(this.current);
  }

  reset(): void {
    this.update({ font: READING_DEFAULT_PREFS.font, size: READING_DEFAULT_PREFS.size });
  }

  retry(): void {
    if (!this.pending) return;
    void this.drain();
  }

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
          if (!this.pending) this.pending = target;
          this.setStatus("error", errorMessage(error));

          return;
        }

        if (!this.pending) this.setStatus("saved", "");
      }
    } finally {
      this.writing = false;

      if (this.reloadPending && !this.pending) {
        this.reloadPending = false;
        void this.reloadAuthority();
      }
    }
  }

  private async reloadAuthority(): Promise<void> {
    const rev = this.revision;
    let stored: unknown;

    try {
      stored = await this.deps.port.load();
    } catch {
      return;
    }

    if (this.revision !== rev || this.pending || this.writing) return;
    const incoming = normalizeReadingPrefs(stored);

    if (sameReadingPrefs(incoming, this.current)) return;
    this.current = incoming;
    this.deps.apply(this.current);
  }

  private receiveFromStorage(raw: unknown): void {
    this.revision += 1;

    if (this.pending || this.writing) {
      this.reloadPending = true;

      return;
    }

    const incoming = normalizeReadingPrefs(raw);

    if (sameReadingPrefs(incoming, this.current)) return;
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

interface ReadingSettingsHost {
  topbar: HTMLElement;
  trigger?: HTMLButtonElement;
  returnFocus?: HTMLElement;
  app?: HTMLElement | null;
  styleRoot?: HTMLElement | null;
  port?: ReadingSettingsPort;
  doc?: Document;
}

interface ReadingSettingsHandle {
  store: ReadingSettingsStore;
  open(): void;
  close(): void;
  destroy(): void;
}

export function mountReadingSettings(host: ReadingSettingsHost): ReadingSettingsHandle {
  const doc = host.doc ?? document;
  const styleRoot = host.styleRoot ?? doc.documentElement;

  const wrapper = doc.createElement("div");
  wrapper.className = "reading-settings";

  const button = host.trigger ?? doc.createElement("button");
  button.id = "reading-settings-btn";
  button.type = "button";
  button.className = "reading-settings-btn";
  button.title = host.trigger ? "字体字号" : "设置";
  button.setAttribute("aria-label", host.trigger ? "字体字号" : "设置");
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", "reading-settings-panel");

  if (!host.trigger) button.append(icon(Settings));

  const panel = doc.createElement("section");
  panel.id = "reading-settings-panel";
  panel.className = "reading-settings-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "字体字号");
  panel.hidden = true;

  const head = doc.createElement("div");
  head.className = "reading-settings-head";
  const title = doc.createElement("h2");
  title.textContent = "字体字号";
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
  hint.textContent = "调整回答正文的字体和大小。";

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
