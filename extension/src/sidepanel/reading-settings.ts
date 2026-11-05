import { createElement as icon, X } from "lucide";
import {
  COLOR_SCHEME_KEY,
  COLOR_SCHEMES,
  COLOR_TONE_KEY,
  COLOR_TONES,
  DEFAULT_COLOR_SCHEME,
  DEFAULT_COLOR_TONE,
  parseColorScheme,
  parseColorTone,
  writeCachedScheme,
  writeCachedTone,
  type ColorScheme,
  type ColorTone,
} from "../shared/color-tone.js";

const READING_FONTS = [
  { value: "system", label: "系统", stack: null },
  { value: "hei", label: "黑体", stack: '"Heiti SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif' },
  { value: "song", label: "宋体", stack: '"Songti SC", "STSong", "Songti TC", "SimSun", serif' },
  { value: "kai", label: "楷体", stack: '"Kaiti SC", "STKaiti", "KaiTi", serif', needs: ["Kaiti SC", "STKaiti", "KaiTi"] },
  { value: "yuan", label: "圆体", stack: '"Yuanti SC", "YouYuan", sans-serif', needs: ["Yuanti SC", "YouYuan"] },
  { value: "wenkai", label: "文楷", stack: '"LXGW WenKai", "LXGW WenKai Screen", serif', needs: ["LXGW WenKai", "LXGW WenKai Screen"] },
] as const;

type ReadingFont = typeof READING_FONTS[number]["value"];

const READING_CHOICES = {
  lineHeight: { label: "行距", fallback: 1.7, options: [[1.5, "紧凑"], [1.7, "适中"], [1.9, "宽松"], [2.1, "很松"]] },
  letterSpacing: { label: "字距", fallback: 0, options: [[0, "标准"], [0.03, "略宽"], [0.06, "宽"]] },
  margin: { label: "页边", fallback: "normal", options: [["narrow", "窄"], ["normal", "适中"], ["wide", "宽"]] },
  align: { label: "对齐", fallback: "left", options: [["left", "靠左"], ["justify", "两端"]] },
  paragraph: { label: "段落", fallback: "gap", options: [["gap", "空一行"], ["indent", "首行缩进"]] },
  heading: { label: "标题", fallback: 1, options: [[1, "同正文"], [1.15, "大一号"], [1.3, "大两号"]] },
  list: { label: "列表", fallback: "normal", options: [["tight", "紧凑"], ["normal", "适中"], ["loose", "宽松"]] },
  code: { label: "代码", fallback: "default", options: [["default", "SF Mono"], ["menlo", "Menlo"], ["wenkai", "文楷等宽"]] },
  link: { label: "链接", fallback: "underline", options: [["underline", "下划线"], ["none", "只用颜色"]] },
} as const;

type ReadingChoice = keyof typeof READING_CHOICES;

type ReadingPrefs = { font: ReadingFont; size: number } & {
  [K in ReadingChoice]: typeof READING_CHOICES[K]["options"][number][0];
};

const READING_CHOICE_KEYS = Object.keys(READING_CHOICES) as ReadingChoice[];

const READING_SIZE_MIN = 12;
const READING_SIZE_MAX = 22;

const READING_DEFAULT_PREFS: Readonly<ReadingPrefs> = Object.freeze({
  font: "system",
  size: 15,
  ...(Object.fromEntries(READING_CHOICE_KEYS.map((key) => [key, READING_CHOICES[key].fallback])) as { [K in ReadingChoice]: ReadingPrefs[K] }),
});

const READING_STORAGE_KEY = "sideagent_reading_appearance";

const LEGACY_READING_SIZES: Record<string, number> = { small: 13, normal: 15, large: 17 };

const READING_MARGINS: Record<ReadingPrefs["margin"], string | null> = { narrow: "10px", normal: null, wide: "26px" };

const READING_LIST_GAPS: Record<ReadingPrefs["list"], string | null> = { tight: "1px", normal: null, loose: "8px" };

const READING_CODE_STACKS: Record<ReadingPrefs["code"], string | null> = {
  default: null,
  menlo: "Menlo, Consolas, monospace",
  wenkai: '"LXGW WenKai Mono", "SF Mono", Menlo, monospace',
};

const SPECIMEN_HTML = `<h2>为什么长文要留行距</h2>
<p>段落之间留出空隙，读到行尾时更容易找到下一行。可以读 <a>Practical Typography</a>，或试试 <code>font-size: 16px</code>。</p>
<p>字距和页边同样影响舒适度，调一下就能在这里看到变化。</p>
<ul><li>小字号适合查资料</li><li>大字号适合连续阅读</li></ul>`;

function readingStyleVars(prefs: ReadingPrefs): Record<string, string | null> {
  const fallback = READING_DEFAULT_PREFS;
  const indented = prefs.paragraph === "indent";

  return {
    "--reading-font": READING_FONTS.find((font) => font.value === prefs.font)?.stack ?? null,
    "--reading-size": prefs.size === fallback.size ? null : `${prefs.size}px`,
    "--reading-line": prefs.lineHeight === fallback.lineHeight ? null : String(prefs.lineHeight),
    "--reading-tracking": prefs.letterSpacing === fallback.letterSpacing ? null : `${prefs.letterSpacing}em`,
    "--reading-pad": READING_MARGINS[prefs.margin],
    "--reading-align": prefs.align === fallback.align ? null : prefs.align,
    "--reading-para-gap": indented ? "2px" : null,
    "--reading-indent": indented ? "2em" : null,
    "--reading-heading": prefs.heading === fallback.heading ? null : String(prefs.heading),
    "--reading-list-gap": READING_LIST_GAPS[prefs.list],
    "--reading-code": READING_CODE_STACKS[prefs.code],
    "--reading-link": prefs.link === fallback.link ? null : prefs.link,
  };
}

function sameReadingPrefs(a: ReadingPrefs, b: ReadingPrefs): boolean {
  return (Object.keys(READING_DEFAULT_PREFS) as (keyof ReadingPrefs)[]).every((key) => a[key] === b[key]);
}

function hasLegacySize(raw: unknown): boolean {
  return !!raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).size === "string";
}

function normalizeSize(raw: unknown): number {
  const size = typeof raw === "string" ? LEGACY_READING_SIZES[raw] : raw;

  return typeof size === "number" && Number.isInteger(size) && size >= READING_SIZE_MIN && size <= READING_SIZE_MAX
    ? size
    : READING_DEFAULT_PREFS.size;
}

function normalizeReadingPrefs(raw: unknown): ReadingPrefs {
  const source =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const choices = Object.fromEntries(READING_CHOICE_KEYS.map((key) => {
    const options: ReadonlyArray<readonly [unknown, string]> = READING_CHOICES[key].options;

    return [key, options.some(([value]) => value === source[key]) ? source[key] : READING_CHOICES[key].fallback];
  })) as { [K in ReadingChoice]: ReadingPrefs[K] };

  return {
    font: READING_FONTS.find((font) => font.value === source.font)?.value ?? READING_DEFAULT_PREFS.font,
    size: normalizeSize(source.size),
    ...choices,
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

// WHY: Chrome offers no API to list installed fonts without a permission prompt, so a font counts as present when it changes measured width against every generic family.
function fontInstalled(doc: Document, family: string): boolean {
  const context = doc.createElement("canvas").getContext("2d");

  if (!context) return false;
  const sample = "永和九年阅读Ag";

  return ["monospace", "serif", "sans-serif"].some((generic) => {
    context.font = `40px ${generic}`;
    const base = context.measureText(sample).width;
    context.font = `40px "${family}", ${generic}`;

    return context.measureText(sample).width !== base;
  });
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

    if (hasLegacySize(stored)) this.enqueue(this.current);
  }

  update(patch: Partial<ReadingPrefs>): void {
    this.revision += 1;
    this.current = normalizeReadingPrefs({ ...this.current, ...patch });
    this.deps.apply(this.current);
    this.enqueue(this.current);
  }

  reset(): void {
    this.update({ ...READING_DEFAULT_PREFS });
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

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const text = typeof error === "string" ? error : "";

  return text || "无法写入本地存储";
}

interface ReadingSettingsHost {
  trigger: HTMLButtonElement;
  returnFocus?: HTMLElement;
  app: HTMLElement;
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
  const button = host.trigger;
  const syncs: Array<(prefs: ReadingPrefs) => void> = [];

  button.title = "外观";
  button.setAttribute("aria-label", "外观");
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", "reading-settings-panel");

  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] => {
    const el = doc.createElement(tag);

    if (className) el.className = className;
    if (text) el.textContent = text;

    return el;
  };

  function radios<V>(
    name: string,
    options: ReadonlyArray<{ value: V; label: string; className?: string; prepare?: (label: HTMLLabelElement) => void }>,
    pick: (value: V) => void,
  ): { inputs: Array<{ input: HTMLInputElement; label: HTMLLabelElement; value: V }>; sync(value: V): void } {
    const inputs = options.map((option, index) => {
      const label = make("label", option.className ?? "appearance-seg-option");
      const input = make("input");
      input.type = "radio";
      input.name = name;
      input.value = String(index);
      input.addEventListener("change", () => pick(option.value));
      label.append(input);
      option.prepare?.(label);
      label.append(make("span", "", option.label));

      return { input, label, value: option.value };
    });

    return {
      inputs,
      sync(value) {
        for (const item of inputs) item.input.checked = item.value === value;
      },
    };
  }

  function segmented<V>(
    name: string,
    label: string,
    options: ReadonlyArray<readonly [V, string]>,
    pick: (value: V) => void,
  ): { row: HTMLElement; sync(value: V): void } {
    const box = make("div", "appearance-seg");
    box.setAttribute("role", "radiogroup");
    box.setAttribute("aria-label", label);
    box.style.setProperty("--seg-count", String(options.length));
    const group = radios(name, options.map(([value, text]) => ({ value, label: text })), pick);
    box.append(make("i"), ...group.inputs.map((item) => item.label));
    const row = make("div", "appearance-row");
    row.append(make("span", "appearance-row-label", label), box);

    return {
      row,
      sync(value) {
        group.sync(value);
        box.style.setProperty("--seg-index", String(Math.max(0, options.findIndex(([option]) => option === value))));
      },
    };
  }

  function choiceRow<K extends ReadingChoice>(key: K): HTMLElement {
    const choice = READING_CHOICES[key];
    const options = choice.options as unknown as ReadonlyArray<readonly [ReadingPrefs[K], string]>;
    const field = segmented(`reading-${key}`, choice.label, options, (value) => {
      store.update({ [key]: value } as unknown as Partial<ReadingPrefs>);
    });
    syncs.push((prefs) => field.sync(prefs[key]));

    return field.row;
  }

  function fontTiles(): HTMLElement {
    const box = make("div", "appearance-fonts");
    box.setAttribute("role", "radiogroup");
    box.setAttribute("aria-label", "字体");
    const available = READING_FONTS.filter((font) => !("needs" in font) || font.needs.some((family) => fontInstalled(doc, family)));
    const group = radios("reading-font", available.map((font) => ({
      value: font.value as ReadingFont,
      label: font.label,
      className: "appearance-font",
      prepare: (label: HTMLLabelElement) => {
        const glyph = make("b", "", "永");

        if (font.stack) glyph.style.fontFamily = font.stack;
        label.append(glyph);
      },
    })), (value) => store.update({ font: value }));
    box.append(...group.inputs.map((item) => item.label));
    syncs.push((prefs) => group.sync(prefs.font));

    return box;
  }

  function sizeRow(): HTMLElement {
    const step = (delta: number, label: string, className: string) => {
      const stepper = make("button", className, "A");
      stepper.type = "button";
      stepper.setAttribute("aria-label", label);
      stepper.addEventListener("click", () => {
        store.update({ size: Math.min(READING_SIZE_MAX, Math.max(READING_SIZE_MIN, store.prefs.size + delta)) });
      });

      return stepper;
    };
    const range = make("input");
    range.type = "range";
    range.min = String(READING_SIZE_MIN);
    range.max = String(READING_SIZE_MAX);
    range.step = "1";
    range.setAttribute("aria-label", "字号");
    range.addEventListener("input", () => store.update({ size: Number(range.value) }));
    const value = make("output");
    const control = make("div", "appearance-size");
    control.append(step(-1, "小一号", "appearance-size-down"), range, step(1, "大一号", "appearance-size-up"), value);
    const row = make("div", "appearance-row");
    row.append(make("span", "appearance-row-label", "字号"), control);
    syncs.push((prefs) => {
      range.value = String(prefs.size);
      value.textContent = String(prefs.size);
    });

    return row;
  }

  const panel = make("dialog", "reading-settings-panel");
  panel.id = "reading-settings-panel";
  panel.setAttribute("aria-labelledby", "reading-settings-title");

  const head = make("div", "reading-settings-head");
  const title = make("h2", "", "外观");
  title.id = "reading-settings-title";
  const closeBtn = make("button");
  closeBtn.id = "reading-settings-close";
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "关闭");
  closeBtn.append(icon(X));
  head.append(title, closeBtn);

  const specimen = make("div", "msg assistant markdown reading-specimen");
  specimen.setAttribute("aria-hidden", "true");
  specimen.innerHTML = SPECIMEN_HTML;

  const status = make("p", "reading-settings-status");
  status.id = "reading-settings-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const retryBtn = make("button", "reading-settings-retry", "重试保存");
  retryBtn.id = "reading-settings-retry";
  retryBtn.type = "button";
  retryBtn.hidden = true;

  const writeTheme = (values: Record<string, string>) => {
    void chrome.storage.local.set(values).then(
      () => {
        status.textContent = "";
      },
      (error: unknown) => {
        status.textContent = `未保存：${errorMessage(error)}`;
      },
    );
  };

  const toneGroup = radios<ColorTone>("color-tone", COLOR_TONES.map((tone) => ({
    value: tone.id,
    label: tone.label,
    className: "tone-option",
    prepare: (label: HTMLLabelElement) => {
      label.dataset.toneOption = tone.id;
      label.dataset.tonePreview = tone.id;
      label.append(make("b", "", "永 Ag"));
    },
  })), (tone) => {
    doc.documentElement.dataset.tone = tone;
    writeCachedTone(tone);
    writeTheme({ [COLOR_TONE_KEY]: tone });
  });
  const toneBox = make("div", "appearance-tones");
  toneBox.setAttribute("role", "radiogroup");
  toneBox.setAttribute("aria-label", "底色");
  toneBox.append(...toneGroup.inputs.map((item) => item.label));

  const schemeField = segmented<ColorScheme>("color-scheme", "明暗", COLOR_SCHEMES.map((scheme) => [scheme.id, scheme.label] as const), (scheme) => {
    writeCachedScheme(scheme);
    writeTheme({ [COLOR_SCHEME_KEY]: scheme });
    schemeField.sync(scheme);
  });

  const pages = [
    { name: "文字", kids: () => [fontTiles(), sizeRow(), choiceRow("lineHeight"), choiceRow("letterSpacing"), choiceRow("margin"), choiceRow("align"), choiceRow("paragraph")] },
    { name: "回答", kids: () => [choiceRow("heading"), choiceRow("list"), choiceRow("code"), choiceRow("link")] },
    { name: "外观", kids: () => [toneBox, schemeField.row] },
  ];
  const tabList = make("div", "appearance-seg appearance-tabs");
  tabList.setAttribute("role", "tablist");
  tabList.setAttribute("aria-label", "外观分类");
  tabList.style.setProperty("--seg-count", String(pages.length));
  tabList.append(make("i"));
  const body = make("div", "appearance-body");
  const tabs = pages.map((page, index) => {
    const tab = make("button", "appearance-seg-option", page.name);
    tab.type = "button";
    tab.id = `appearance-tab-${index}`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", `appearance-page-${index}`);
    tab.addEventListener("click", () => selectTab(index));
    tab.addEventListener("keydown", (event) => {
      const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;

      if (!delta) return;
      event.preventDefault();
      selectTab((index + delta + pages.length) % pages.length);
      tabs[(index + delta + pages.length) % pages.length]?.focus();
    });
    tabList.append(tab);

    return tab;
  });
  const sections = pages.map((page, index) => {
    const section = make("section", "appearance-page");
    section.id = `appearance-page-${index}`;
    section.setAttribute("role", "tabpanel");
    section.setAttribute("aria-labelledby", `appearance-tab-${index}`);
    section.append(...page.kids());
    body.append(section);

    return section;
  });

  function selectTab(active: number): void {
    tabList.style.setProperty("--seg-index", String(active));
    tabs.forEach((tab, index) => {
      tab.setAttribute("aria-selected", String(index === active));
      tab.tabIndex = index === active ? 0 : -1;
    });
    sections.forEach((section, index) => {
      section.hidden = index !== active;
    });
  }

  const foot = make("div", "reading-settings-foot");
  const resetBtn = make("button", "reading-settings-reset", "恢复默认");
  resetBtn.id = "reading-settings-reset";
  resetBtn.type = "button";
  foot.append(resetBtn, status, retryBtn);

  panel.append(head, specimen, tabList, body, foot);
  host.app.append(panel);
  selectTab(0);

  function syncControls(prefs: ReadingPrefs): void {
    for (const sync of syncs) sync(prefs);
  }

  async function syncTheme(): Promise<void> {
    const stored = await chrome.storage.local.get([COLOR_TONE_KEY, COLOR_SCHEME_KEY]);
    toneGroup.sync(parseColorTone(stored[COLOR_TONE_KEY]));
    schemeField.sync(parseColorScheme(stored[COLOR_SCHEME_KEY]));
  }

  const store = new ReadingSettingsStore({
    port: host.port ?? createChromeReadingPort(),
    apply: (prefs) => {
      applyReadingPrefs(prefs, styleRoot);
      syncControls(prefs);
    },
    onStatus: (next) => {
      status.textContent = next.state === "error" ? `未保存：${next.message}` : "";
      status.dataset.state = next.state;
      retryBtn.hidden = next.state !== "error";
    },
  });

  function openPanel(): void {
    void syncTheme();
    panel.showModal();
    button.setAttribute("aria-expanded", "true");
  }

  function closePanel(): void {
    if (panel.open) panel.close();
  }

  const onTrigger = () => openPanel();
  button.addEventListener("click", onTrigger);
  closeBtn.addEventListener("click", closePanel);
  panel.addEventListener("close", () => {
    button.setAttribute("aria-expanded", "false");
    (host.returnFocus ?? button).focus();
  });

  resetBtn.addEventListener("click", () => {
    store.reset();
    doc.documentElement.dataset.tone = DEFAULT_COLOR_TONE;
    writeCachedTone(DEFAULT_COLOR_TONE);
    writeCachedScheme(DEFAULT_COLOR_SCHEME);
    writeTheme({ [COLOR_TONE_KEY]: DEFAULT_COLOR_TONE, [COLOR_SCHEME_KEY]: DEFAULT_COLOR_SCHEME });
    toneGroup.sync(DEFAULT_COLOR_TONE);
    schemeField.sync(DEFAULT_COLOR_SCHEME);
  });
  retryBtn.addEventListener("click", () => store.retry());

  const onThemeChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === "local" && (COLOR_TONE_KEY in changes || COLOR_SCHEME_KEY in changes)) void syncTheme();
  };
  chrome.storage.onChanged.addListener(onThemeChanged);

  syncControls(store.prefs);
  void store.start();

  return {
    store,
    open: openPanel,
    close: closePanel,
    destroy: () => {
      button.removeEventListener("click", onTrigger);
      chrome.storage.onChanged.removeListener(onThemeChanged);
      store.stop();
      panel.remove();
    },
  };
}
