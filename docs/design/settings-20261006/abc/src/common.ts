/** 三版共用的零件：图标、头像、状态、模型下拉、详情表单（凭据 + 模型 + 动作）。 */
import { createElement, KeyRound, Search, Check, ChevronDown, ChevronRight, Play, Pause, Plus, CircleCheck, X, CornerDownLeft, Globe } from "lucide";
import { computePosition, flip, offset, shift, size, autoUpdate } from "@floating-ui/dom";
import { state, choiceOf, credNote, defaultModel, labelOf, CUSTOM_ID, type Entry } from "./data";

export const ICONS = { KeyRound, Search, Check, ChevronDown, ChevronRight, Play, Pause, Plus, CircleCheck, X, CornerDownLeft, Globe };
export function icon(name: keyof typeof ICONS, px = 14, cls = ""): SVGElement {
  const el = createElement(ICONS[name]) as unknown as SVGElement;
  el.setAttribute("width", String(px)); el.setAttribute("height", String(px)); el.setAttribute("stroke-width", "1.75");
  el.setAttribute("aria-hidden", "true");
  if (cls) el.setAttribute("class", cls);
  return el;
}

/** 录屏时根元素 zoom=2；floating-ui 拿到的是放大后的坐标，写回 left/top 前要除掉。平时为 1。 */
export const Z = () => parseFloat(document.documentElement.style.zoom || "1") || 1;

export const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...kids: (Node | string | null | false | undefined)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false || v === null) continue;
    if (k === "class") el.className = String(v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "text") el.textContent = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids) if (kid !== null && kid !== false && kid !== undefined) el.append(kid);
  return el;
}

/** 单字头像：中文取首字，英文取首字母。不加载服务商图标（原型不发网络请求）。 */
export function avatar(name: string, px = 20, active = false): HTMLElement {
  const ch = /^[\u4e00-\u9fff]/.test(name) ? name[0] : name.replace(/[^A-Za-z0-9]/g, "")[0]?.toUpperCase() ?? "?";
  return h("span", { class: "av" + (active ? " is-active" : ""), style: `--av:${px}px`, "aria-hidden": "true", text: ch });
}

/** 状态：使用中＝墨蓝实点 + 字；已登录＝绿点 + 字；已填 key＝钥匙 + 字。 */
export function statusEl(kind: string, text: string, region?: string): HTMLElement {
  const el = h("span", { class: `st st-${kind || "none"}` });
  if (!kind) return el;
  if (kind === "key") el.append(icon("KeyRound", 12));
  else el.append(h("i", { class: "dot" }));
  el.append(h("span", { text: region ? `${text} · ${region}` : text }));
  return el;
}

export const bus = new EventTarget();
/** 最近一次保存的提示：整块重画时详情里的状态行会丢，A 版把它挪到「正在使用」那一行下面。 */
export const notice = { text: "" };
export const changed = () => bus.dispatchEvent(new Event("change"));

/** 模型下拉：可直接输入目录外的模型名（现有页用 input + datalist，这里换成可搜索的浮层）。 */
export function modelCombo(models: string[], value: string, onPick: (id: string) => void, placeholder = "选择或输入模型名称"): HTMLElement {
  const wrap = h("div", { class: "combo" });
  const input = h("input", { class: "combo-input", value, placeholder, autocomplete: "off", spellcheck: "false", "aria-label": "模型", role: "combobox", "aria-expanded": "false" }) as HTMLInputElement;
  input.value = value;
  const btn = h("button", { type: "button", class: "combo-btn", "aria-label": "展开模型列表", tabindex: "-1" }, icon("ChevronDown", 14));
  const list = h("div", { class: "combo-list", role: "listbox", hidden: true });
  wrap.append(input, btn);
  document.body.append(list);
  let cleanup: (() => void) | null = null; let active = -1;
  const render = (q: string) => {
    const ql = q.trim().toLowerCase();
    const items = (ql && ql !== value.toLowerCase() ? models.filter((m) => m.toLowerCase().includes(ql)) : models).slice(0, 200);
    list.replaceChildren(...items.map((m, i) => h("div", { class: "combo-opt" + (m === input.value ? " is-cur" : "") + (i === active ? " is-hi" : ""), role: "option", "data-id": m, onmousedown: (e: Event) => { e.preventDefault(); pick(m); } }, h("span", { text: m }), m === input.value ? icon("Check", 13) : "")));
    if (!items.length) list.append(h("div", { class: "combo-empty", text: ql ? `目录里没有「${q.trim()}」，保存时按你填的名称调用。` : "这家没有模型目录，直接填写模型名称。" }));
    list.prepend(h("div", { class: "combo-count", text: `${models.length} 个模型` }));
  };
  const open = () => {
    if (!list.hidden) return;
    list.hidden = false; input.setAttribute("aria-expanded", "true"); active = -1; render("");
    cleanup = autoUpdate(wrap, list, () => computePosition(wrap, list, { placement: "bottom-start", middleware: [offset(4), flip(), shift({ padding: 8 }), size({ apply({ rects, availableHeight }) { Object.assign(list.style, { width: `${rects.reference.width / Z()}px`, maxHeight: `${Math.min(260, availableHeight / Z() - 12)}px` }); } })] }).then(({ x, y }) => Object.assign(list.style, { left: `${x / Z()}px`, top: `${y / Z()}px` })));
    list.querySelector(".is-cur")?.scrollIntoView({ block: "nearest" });
  };
  const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); cleanup?.(); cleanup = null; };
  const pick = (m: string) => { input.value = m; value = m; close(); onPick(m); };
  input.addEventListener("focus", open);
  input.addEventListener("click", open);
  input.addEventListener("blur", () => { close(); if (input.value.trim() !== value) { value = input.value.trim(); onPick(value); } });
  input.addEventListener("input", () => { open(); active = -1; render(input.value); });
  input.addEventListener("keydown", (e) => {
    const opts = [...list.querySelectorAll<HTMLElement>(".combo-opt")];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); open(); active = Math.max(0, Math.min(opts.length - 1, active + (e.key === "ArrowDown" ? 1 : -1))); opts.forEach((o, i) => o.classList.toggle("is-hi", i === active)); opts[active]?.scrollIntoView({ block: "nearest" }); }
    else if (e.key === "Enter") { e.preventDefault(); if (active >= 0 && opts[active]) pick(opts[active].dataset.id!); else { pick(input.value.trim()); } }
    else if (e.key === "Escape") close();
  });
  btn.addEventListener("mousedown", (e) => { e.preventDefault(); if (list.hidden) { input.focus(); open(); } else close(); });
  (wrap as HTMLElement & { destroy?: () => void }).destroy = () => { close(); list.remove(); };
  return wrap;
}

export function setStatus(el: HTMLElement, text: string, tone: "ok" | "err" | "busy" | "" = "") { el.textContent = text; el.dataset.tone = tone; }

const flows = new Map<string, number>(); // providerId → 登录模拟计时器

/**
 * 详情表单：凭据（登录 / key）、模型、测试 / 快速模型 / 保存并使用。
 * 文案与现有 settings/main.ts 一致；登录和测试连接都是本地模拟。
 */
export function detailForm(entry: Entry, opts: { memberId?: string; onSaved?: () => void; compact?: boolean; modelList?: boolean } = {}): HTMLElement {
  let memberId = opts.memberId ?? (entry.members.find((m) => m.id === state.config.provider) ?? entry.members.find((m) => credNote(m.id)) ?? entry.members[0]).id;
  const root = h("div", { class: "detail" });
  const draw = () => {
    root.querySelectorAll<HTMLElement & { destroy?: () => void }>(".combo").forEach((c) => c.destroy?.());
    const choice = choiceOf(memberId);
    const cred = state.creds[memberId];
    let modelId = defaultModel(memberId);
    const status = h("p", { class: "d-status", role: "status", "aria-live": "polite" });
    const kids: HTMLElement[] = [];

    if (entry.members.length > 1) {
      kids.push(h("div", { class: "d-field" }, h("span", { class: "d-label", text: "地区" }),
        h("div", { class: "seg", role: "radiogroup", "aria-label": "地区" }, ...entry.members.map((m) => h("button", { type: "button", role: "radio", "aria-checked": String(m.id === memberId), onclick: () => { memberId = m.id; draw(); } }, h("span", { text: m.region! }), credNote(m.id) ? h("i", { class: "seg-dot", title: credNote(m.id) }) : "")))));
    }

    if (choice.id === CUSTOM_ID) {
      kids.push(h("label", { class: "d-field" }, h("span", { class: "d-label", text: "服务地址（OpenAI 兼容）" }), h("input", { class: "d-input", type: "url", placeholder: "https://example.com/v1", value: state.customBaseUrl, spellcheck: "false", oninput: (e: Event) => { state.customBaseUrl = (e.target as HTMLInputElement).value; } })));
    }

    // 订阅登录（借 Zed llm_providers_page.rs 的 ConfiguredApiCard：状态一行 + 右侧动作，不再放大输入框）
    if (choice.oauthLabel) {
      const flowing = flows.has(memberId);
      if (cred?.type === "oauth") {
        kids.push(h("div", { class: "d-cred is-ok" }, icon("CircleCheck", 15, "ok-ic"), h("span", { class: "d-cred-text", text: "已登录，令牌会自动续期。" }),
          h("span", { class: "d-cred-acts" }, h("button", { type: "button", class: "btn btn-quiet", text: "重新登录", onclick: () => startLogin() }), h("button", { type: "button", class: "btn btn-quiet", text: "退出登录", onclick: () => { delete state.creds[memberId]; changed(); draw(); setStatus(root.querySelector(".d-status")!, "已退出登录。"); } }))));
      } else if (flowing) {
        kids.push(h("div", { class: "d-flow" },
          h("p", { class: "d-flow-line", text: "在打开的网页里确认登录。网页要求输入代码时，填写：" }),
          h("p", { class: "d-code", text: "WDJB-MJHT" }),
          h("div", { class: "d-row" }, h("button", { type: "button", class: "btn", text: "复制代码", onclick: (e: Event) => { (e.currentTarget as HTMLElement).textContent = "已复制"; } }), h("button", { type: "button", class: "btn btn-quiet", text: "取消登录", onclick: () => { clearTimeout(flows.get(memberId)); flows.delete(memberId); draw(); setStatus(root.querySelector(".d-status")!, "已取消登录。"); } }), h("span", { class: "d-hint", text: "等待你在网页上确认…（原型 3 秒后自动完成）" }))));
      } else {
        kids.push(h("div", { class: "d-cred" }, h("button", { type: "button", class: "btn btn-primary", text: choice.oauthLabel, onclick: () => startLogin() }), h("span", { class: "d-hint", text: "会打开服务商的网页，在那里确认即可。" })));
      }
    }

    if (choice.apiKey) {
      const saved = cred?.type === "api_key" ? cred.key : "";
      const keyLabel = choice.oauthLabel ? "或者填写 API key" : choice.id === CUSTOM_ID ? "API key（本机服务可以不填）" : "API key";
      if (saved) {
        const row = h("div", { class: "d-cred is-key" }, icon("KeyRound", 14, "key-ic"), h("span", { class: "d-cred-text" }, "已填 key", h("span", { class: "d-mono", text: ` · 末四位 ${saved.slice(-4)}` })),
          h("span", { class: "d-cred-acts" }, h("button", { type: "button", class: "btn btn-quiet", text: "更换", onclick: () => { row.replaceWith(keyInput(true)); } })));
        kids.push(row);
      } else kids.push(keyInput(false));
      function keyInput(replacing: boolean) {
        return h("label", { class: "d-field" }, h("span", { class: "d-label", text: keyLabel }), h("input", { class: "d-input", type: "password", autocomplete: "off", spellcheck: "false", placeholder: replacing ? "粘贴新的 key，留空则沿用" : "粘贴 key", "data-key": "1" }));
      }
    }

    if (opts.modelList && choice.models.length) kids.push(modelListField());
    else kids.push(h("div", { class: "d-field" }, h("span", { class: "d-label" }, "模型", h("span", { class: "d-label-meta", text: choice.models.length ? `目录 ${choice.models.length} 个，也可以直接输入` : "填写模型名称" })), modelCombo(choice.models, modelId, (m) => { modelId = m; syncPrimary(); })));

    /** B 版：模型直接列出来点选（单选列表），目录大于 10 个时顶部给一个筛选框。 */
    function modelListField(): HTMLElement {
      const listEl = h("div", { class: "ml", role: "radiogroup", "aria-label": "模型" });
      const filter = h("input", { class: "ml-filter", type: "search", placeholder: `在 ${choice.models.length} 个模型里筛选，或输入目录外的名称`, spellcheck: "false", "aria-label": "筛选模型" }) as HTMLInputElement;
      const paint = () => {
        const f = filter.value.trim().toLowerCase();
        const ms = choice.models.filter((m) => !f || m.toLowerCase().includes(f));
        const rows = ms.map((m) => h("button", { type: "button", role: "radio", class: "ml-row" + (m === modelId ? " is-on" : ""), "aria-checked": String(m === modelId), onclick: () => { modelId = m; paint(); syncPrimary(); } }, h("i", { class: "radio" }), h("span", { class: "ml-name", text: m }), state.config.provider === memberId && state.config.modelId === m ? h("span", { class: "ml-tag", text: "使用中" }) : state.fast?.provider === memberId && state.fast.modelId === m ? h("span", { class: "ml-tag ml-tag-q", text: "快速" }) : ""));
        if (f && !choice.models.includes(filter.value.trim())) rows.push(h("button", { type: "button", class: "ml-row ml-custom", onclick: () => { modelId = filter.value.trim(); paint(); syncPrimary(); } }, icon("Plus", 13), h("span", { text: `使用「${filter.value.trim()}」（目录里没有）` })));
        listEl.replaceChildren(...rows);
      };
      filter.addEventListener("input", paint);
      paint();
      queueMicrotask(() => listEl.querySelector(".is-on")?.scrollIntoView({ block: "nearest" }));
      return h("div", { class: "d-field" }, h("span", { class: "d-label" }, "模型", h("span", { class: "d-label-meta", text: `目录 ${choice.models.length} 个` })), h("div", { class: "ml-box" }, choice.models.length > 10 ? filter : null, listEl));
    }

    const isCurrent = () => state.config.provider === memberId && state.config.modelId === modelId;
    const primary = h("button", { type: "button", class: "btn btn-primary", onclick: () => save() });
    const syncPrimary = () => { primary.textContent = isCurrent() ? "正在使用" : "保存并使用"; primary.toggleAttribute("disabled", isCurrent()); };
    syncPrimary();
    kids.push(h("div", { class: "d-actions" },
      h("button", { type: "button", class: "btn btn-quiet", text: "测试连接", onclick: () => test() }),
      h("button", { type: "button", class: "btn btn-quiet", text: "用作快速模型", onclick: () => saveFast() }),
      h("span", { class: "grow" }), primary));
    kids.push(status);
    root.replaceChildren(...kids);

    function readKey(): string { return (root.querySelector<HTMLInputElement>("input[data-key]")?.value ?? "").trim(); }
    function check(): string {
      if (!modelId) return "填写模型名称。";
      if (choice.id === CUSTOM_ID && !/^https?:\/\/[^/\s]+/i.test(state.customBaseUrl.trim())) return "服务地址要以 http:// 或 https:// 开头。";
      if (!readKey() && !state.creds[memberId] && choice.id !== CUSTOM_ID) return choice.oauthLabel ? "先登录，或填写 API key。" : "填写 API key。";
      return "";
    }
    function test() {
      const err = check(); if (err) return setStatus(status, err, "err");
      const t0 = performance.now(); setStatus(status, "正在测试…", "busy");
      setTimeout(() => setStatus(status, `连接正常（${((performance.now() - t0) / 1000).toFixed(1)} 秒）。原型里是模拟结果，没有发请求。`, "ok"), 1100);
    }
    function commitKey() { const k = readKey(); if (k) state.creds[memberId] = { type: "api_key", key: k }; }
    function save() {
      const err = check(); if (err) return setStatus(status, err, "err");
      commitKey();
      notice.text = `已保存。侧栏接下来的任务会使用 ${labelOf(memberId)} · ${modelId}。`;
      state.config = { provider: memberId, modelId, ...(choice.id === CUSTOM_ID ? { baseUrl: state.customBaseUrl } : {}) };
      changed(); opts.onSaved?.(); draw();
      setStatus(root.querySelector(".d-status")!, `已保存。侧栏接下来的任务会使用 ${labelOf(memberId)} · ${modelId}。`, "ok");
    }
    function saveFast() {
      const err = check(); if (err) return setStatus(status, err, "err");
      commitKey(); state.fast = { provider: memberId, modelId }; changed();
      setStatus(status, `已设为快速模型：${labelOf(memberId)} · ${modelId}。主模型不变。`, "ok");
    }
    function startLogin() {
      flows.set(memberId, window.setTimeout(() => { flows.delete(memberId); state.creds[memberId] = { type: "oauth" }; changed(); draw(); setStatus(root.querySelector(".d-status")!, "登录成功。", "ok"); }, 3000));
      draw(); setStatus(root.querySelector(".d-status")!, "等待你在网页上确认…", "busy");
    }
  };
  draw();
  return root;
}
