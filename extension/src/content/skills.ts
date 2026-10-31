import { createElement as icon, Zap, X } from "lucide";
import { isLearnedOperationResult, type LearnedOperationResult } from "../../../shared/learned-operations.js";
import { SKILL_PACKAGES_KEY, SKILL_PACKAGE_RUN, sanitizeSkillPackageConfigs, type SkillPackageConfig } from "../../../shared/skill-packages.js";
import { PAPER_TOKENS } from "./ask-styles.js";
import { syncColorTone } from "../shared/color-tone.js";
import { skillResultText } from "../shared/skill-result.js";

const HOST = "data-sideagent-skill-packages";
const SLOT = "__sideagentSkillPackagesDispose";

type PageWindow = Window & { [SLOT]?: () => void };
(pageWindow => pageWindow[SLOT]?.())(window as PageWindow);

function install(): () => void {
  syncColorTone();
  const host = document.createElement("div");
  host.setAttribute(HOST, "");
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `${PAPER_TOKENS}
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .dock { position: fixed; right: 16px; bottom: 16px; z-index: 2147483645; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; max-width: min(360px, calc(100vw - 32px)); max-height: calc(100vh - 32px); font: var(--t-ui)/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; color: var(--ink-fg); }
    .entries { display: flex; flex-direction: column; align-items: stretch; gap: 4px; max-height: 45vh; overflow: auto; padding: 4px; border-radius: var(--r-outer); background: var(--ink); box-shadow: var(--shadow-bar); }
    button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 34px; padding: 6px 12px; border: 0; border-radius: var(--r-inner); background: transparent; color: var(--ink-fg); font: inherit; cursor: pointer; }
    button:hover:not(:disabled) { background: var(--ink-hover); }
    button:focus-visible { outline: 2px solid var(--pen); outline-offset: -2px; }
    button:disabled { opacity: .55; cursor: default; }
    button svg { width: 15px; height: 15px; color: var(--pen); }
    .result { width: 340px; max-width: calc(100vw - 32px); overflow: hidden; border-radius: var(--r-outer); background: var(--ink); box-shadow: var(--shadow); }
    .head { display: flex; align-items: center; gap: 8px; padding: 6px 6px 6px 14px; border-bottom: 1px solid var(--ink-rule); }
    .head strong { flex: 1; font-size: var(--t-ui); }
    .head button { width: 28px; min-height: 28px; padding: 0; }
    .head button svg { color: var(--ink-mute); }
    pre { max-height: 35vh; margin: 0; overflow: auto; padding: 12px 14px; white-space: pre-wrap; overflow-wrap: anywhere; font: var(--t-meta)/1.65 ui-monospace, SFMono-Regular, monospace; }
    .meta { padding: 0 14px 10px; color: var(--ink-mute); font-size: var(--t-meta); }
    .result[data-state="error"] .meta { color: var(--warn); }
    @media (prefers-reduced-motion: no-preference) { .result, .entries { animation: enter .18s var(--ease-out); } }
    @keyframes enter { from { opacity: 0; transform: translateY(4px); } }
  `;
  const dock = document.createElement("div");
  dock.className = "dock";
  root.append(style, dock);
  (document.body ?? document.documentElement).append(host);
  let current: Array<[string, SkillPackageConfig]> = [];

  const dataText = skillResultText;

  function resultCard(config: SkillPackageConfig) {
    const card = document.createElement("section");
    card.className = "result";
    card.setAttribute("aria-live", "polite");
    const head = document.createElement("div");
    head.className = "head";
    const title = document.createElement("strong");
    title.textContent = config.name;
    const close = document.createElement("button");
    close.type = "button";
    close.setAttribute("aria-label", "关闭结果");
    close.append(icon(X));
    close.addEventListener("click", () => card.remove());
    head.append(title, close);
    const body = document.createElement("pre");
    body.textContent = "正在读取当前页面…";
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = "直接运行 · 未调用模型";
    card.append(head, body, meta);
    dock.prepend(card);
    return { card, body, meta };
  }

  function paintResult(view: ReturnType<typeof resultCard>, ok: boolean, result: LearnedOperationResult | undefined, error: string | undefined): void {
    view.card.dataset.state = ok && (result?.status === "observed" || result?.status === "empty") ? result.status : "error";
    if (!ok) view.body.textContent = `没有运行成功：${error ?? "连接中断，请再试一次。"}`;
    else if (result?.status === "observed" || result?.status === "empty") view.body.textContent = dataText(result.data);
    else view.body.textContent = `没有运行成功：${result && "reason" in result ? result.reason : "没有取得结果"}`;
    if (result?.status === "empty") view.meta.textContent += " · 没有读到内容";
  }

  async function run(id: string, config: SkillPackageConfig, button: HTMLButtonElement): Promise<void> {
    dock.querySelector(".result")?.remove();
    const view = resultCard(config);
    button.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: SKILL_PACKAGE_RUN, id, input: config.input }) as { ok?: unknown; result?: unknown; error?: unknown } | undefined;
      const result = isLearnedOperationResult(response?.result) ? response.result : undefined;
      paintResult(view, response?.ok === true && !!result, result, typeof response?.error === "string" ? response.error : undefined);
    } catch (cause) {
      paintResult(view, false, undefined, cause instanceof Error ? cause.message : String(cause));
    } finally {
      button.disabled = false;
    }
  }

  function render(): void {
    dock.querySelector(".entries")?.remove();
    dock.querySelector(".result")?.remove();
    if (!current.length) return;
    const entries = document.createElement("div");
    entries.className = "entries";
    entries.setAttribute("aria-label", "这个网站的技能");
    for (const [id, config] of current) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.skillId = id;
      button.title = `运行${config.name}`;
      button.append(icon(Zap), document.createTextNode(config.name));
      button.addEventListener("click", event => {
        if (!event.isTrusted) return;
        void run(id, config, button);
      });
      entries.append(button);
    }
    dock.append(entries);
  }

  function refresh(raw: unknown): void {
    const origin = location.origin;
    current = Object.entries(sanitizeSkillPackageConfigs(raw)).filter(([, config]) => config.pageButton && config.site === origin);
    render();
  }

  void chrome.storage.local.get(SKILL_PACKAGES_KEY).then(stored => refresh(stored[SKILL_PACKAGES_KEY])).catch(() => host.remove());
  const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string): void => {
    if (area === "local" && SKILL_PACKAGES_KEY in changes) refresh(changes[SKILL_PACKAGES_KEY].newValue);
  };
  chrome.storage.onChanged.addListener(onChanged);
  return () => { chrome.storage.onChanged.removeListener(onChanged); host.remove(); };
}

const dispose = install();
(window as PageWindow)[SLOT] = dispose;
