// 共用：状态、图标、元素工厂、详情表单。原型只改内存，不写 chrome.storage，不发网络请求。
import { CHOICES, SVGS } from "./data.js";

export const CUSTOM_ID = "custom";
export const CUSTOM = { id: CUSTOM_ID, name: "自定义地址", apiKey: true, oauth: null, models: [], modelCount: 0, icon: null };
export const choices = [...CHOICES, CUSTOM];
export const FEATURED = ["stepfun", "opencode-go", "zai-coding-cn", "kimi-coding"];
export const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** 与用户截图一致的初始状态：Codex 正在使用，另有 4 家填了 key、1 家登录。 */
export const initialState = () => ({
  config: { provider: "openai-codex", modelId: "gpt-6-luna" },
  fast: null,
  creds: {
    "stepfun": { type: "api_key", key: "sk-step-0000a1F3" },
    "opencode-go": { type: "api_key", key: "oc-0000009xQ2" },
    "zai-coding-cn": { type: "api_key", key: "zp-000007Lm0" },
    "kimi-coding": { type: "oauth" },
    "minimax-cn": { type: "api_key", key: "mm-0000c81D" },
    "openai-codex": { type: "oauth" },
  },
});
export let state = initialState();
export function resetState() { state = initialState(); }

export const choiceOf = (id) => choices.find((c) => c.id === id);
export const labelOf = (id) => choiceOf(id)?.name ?? id;
export function credNote(id) {
  const c = state.creds[id];
  if (c?.type === "oauth") return "已登录";
  if (c?.type === "api_key" && c.key) return "已填 key";
  return "";
}
export const isConnected = (id) => !!credNote(id);
export const isActive = (id) => state.config?.provider === id;
export const last4 = (id) => state.creds[id]?.key?.slice(-4) ?? "";
export function defaultModel(c) {
  if (state.config?.provider === c.id) return state.config.modelId;
  return c.defaultModel ?? c.models[0] ?? "";
}

/** BYS 的真实排序：置顶 4 家，其余按名称。 */
export function bysOrder(list = choices) {
  const f = new Map(FEATURED.map((id, i) => [id, i]));
  return [...list].sort((a, b) => (a.id === CUSTOM_ID) - (b.id === CUSTOM_ID) || (f.get(a.id) ?? 99) - (f.get(b.id) ?? 99) || a.name.localeCompare(b.name));
}

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "html") el.innerHTML = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}

// lucide 图标（ISC），只取用到的几个 path。
const L = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronsUpDown: '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  arrowUpRight: '<path d="M7 17 17 7"/><path d="M7 7h10v10"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
  logOut: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  arrowLeft: '<path d="m12 19-7-7 7-7M19 12H5"/>',
  sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
};
export function lu(name, size = 16, cls = "") {
  const s = h("span", { class: `lu ${cls}`, "aria-hidden": "true" });
  s.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${L[name]}</svg>`;
  return s;
}

/** 服务商图标：lobe-icons 单色版（MIT，fill=currentColor）；自定义地址用 link。 */
export function pico(id, size = 16, cls = "") {
  const c = choiceOf(id);
  if (!c || c.id === CUSTOM_ID) return lu("link", size, `pico ${cls}`);
  if (!c.icon || !SVGS[c.icon]) return h("span", { class: `pico pico-mono ${cls}`, "aria-hidden": "true", style: `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.5)}px` }, c.id.startsWith("xiaomi") ? "mi" : c.name.slice(0, 1));
  const s = h("span", { class: `pico ${cls}`, "aria-hidden": "true", style: `width:${size}px;height:${size}px` });
  s.innerHTML = SVGS[c.icon];
  return s;
}

/** 原型的假动作：按钮给出反馈，但不写存储、不联网。 */
export function fakeBusy(btn, busyText, doneText, ms = 900) {
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = busyText;
  return new Promise((r) => setTimeout(() => { btn.disabled = false; btn.textContent = doneText ?? old; r(); }, reduced() ? 0 : ms));
}

export function setStatus(el, text, tone = "") { el.textContent = text; el.dataset.tone = tone; }

/** BYS 设置页的服务商表单（字段、文案取自 extension/src/settings/main.ts），给 F / G 的详情页和 D 的就地添加复用。 */
export function detailForm(c, { onSaved, compact = false } = {}) {
  const cred = state.creds[c.id];
  const loggedIn = cred?.type === "oauth";
  const saved = cred?.type === "api_key" ? cred.key : "";
  const status = h("p", { class: "settings-status", role: "status", "aria-live": "polite" });
  const wrap = h("div", { class: "pv-form" + (compact ? " is-compact" : "") });

  if (c.oauth) {
    const login = h("button", { type: "button", class: "settings-primary", onclick: async (e) => {
      await fakeBusy(e.currentTarget, "等待你在网页上确认…", loggedIn ? "重新登录" : c.oauth, 1100);
      state.creds[c.id] = { type: "oauth" }; setStatus(status, "登录成功（原型：没有真的打开网页）。", "ok"); onSaved?.();
    } }, loggedIn ? "重新登录" : c.oauth);
    const out = loggedIn ? h("button", { type: "button", onclick: () => { delete state.creds[c.id]; setStatus(status, "已退出登录。"); onSaved?.(); } }, "退出登录") : null;
    wrap.append(h("div", { class: "settings-field" },
      h("div", { class: "settings-inline" }, login, out),
      h("p", { class: "settings-hint" }, loggedIn ? "已登录，令牌会自动续期。" : "用设备码登录：会打开服务商的网页，在那里确认即可。")));
  }
  if (c.id === CUSTOM_ID) {
    wrap.append(h("label", { class: "settings-field" }, h("span", {}, "服务地址（OpenAI 兼容）"),
      h("input", { type: "url", autocomplete: "off", spellcheck: "false", placeholder: "https://example.com/v1", "data-field": "base" })));
  }
  if (c.apiKey) {
    wrap.append(h("label", { class: "settings-field" }, h("span", {}, c.oauth ? "或者填写 API key" : "API key"),
      h("input", { type: "password", autocomplete: "off", spellcheck: "false", "data-field": "key",
        placeholder: saved ? `已保存（末四位 ${saved.slice(-4)}），留空则沿用` : c.id === CUSTOM_ID ? "本机服务可以不填" : "粘贴 key" })));
  }
  const listId = `ml-${c.id}-${Math.random().toString(36).slice(2, 6)}`;
  const model = h("input", { autocomplete: "off", spellcheck: "false", list: listId, value: defaultModel(c), "data-field": "model" });
  wrap.append(h("label", { class: "settings-field" }, h("span", {}, "模型"), model,
    h("datalist", { id: listId }, c.models.map((m) => h("option", { value: m })))));

  const keyOf = () => wrap.querySelector('[data-field="key"]')?.value.trim() ?? "";
  const check = () => {
    if (!model.value.trim()) return "填写模型名称。";
    if (!keyOf() && !state.creds[c.id] && c.id !== CUSTOM_ID) return c.oauth ? "先登录，或填写 API key。" : "填写 API key。";
    return "";
  };
  wrap.append(h("div", { class: "settings-inline" },
    h("button", { type: "button", onclick: async (e) => {
      const err = check(); if (err) return setStatus(status, err, "err");
      setStatus(status, "正在测试…", "busy"); await fakeBusy(e.currentTarget, "测试连接", "测试连接", 1200);
      setStatus(status, "连接正常（1.2 秒）。原型不发请求。", "ok");
    } }, "测试连接"),
    h("button", { type: "button", class: "settings-primary", onclick: () => {
      const err = check(); if (err) return setStatus(status, err, "err");
      const k = keyOf(); if (k) state.creds[c.id] = { type: "api_key", key: k };
      state.config = { provider: c.id, modelId: model.value.trim() };
      setStatus(status, `已保存。侧栏接下来的任务会使用 ${c.name} · ${state.config.modelId}。（原型：只存在这一页的内存里）`, "ok");
      onSaved?.();
    } }, "保存并使用"),
    h("button", { type: "button", onclick: () => {
      const err = check(); if (err) return setStatus(status, err, "err");
      state.fast = { provider: c.id, modelId: model.value.trim() };
      setStatus(status, `已设为快速模型：${c.name} · ${state.fast.modelId}。主模型不变。`, "ok"); onSaved?.();
    } }, "用作快速模型")));
  wrap.append(status);
  return wrap;
}

/** 视图切换的小动画：从右推入 / 退回。减少动态效果时直接替换。 */
export function swap(host, next, dir = 1) {
  if (reduced()) { host.replaceChildren(next); return; }
  host.replaceChildren(next);
  next.animate([{ opacity: 0, transform: `translateX(${dir * 16}px)` }, { opacity: 1, transform: "none" }], { duration: 240, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
}
export function popIn(el) {
  if (reduced()) return;
  el.animate([{ opacity: 0, transform: "translateY(-4px) scale(.98)" }, { opacity: 1, transform: "none" }], { duration: 160, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
}
