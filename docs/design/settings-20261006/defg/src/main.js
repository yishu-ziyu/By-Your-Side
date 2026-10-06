// 入口：BYS 设置页外壳（header + 正在使用一行）+ 变体 D/E/F/G + 外置挑选条。
import { h, state, labelOf, resetState } from "./common.js";
import { variantD } from "./variant-d.js";
import { variantE } from "./variant-e.js";
import { variantF } from "./variant-f.js";
import { variantG } from "./variant-g.js";
import BRAND from "./brand-mark.svg";

const VARIANTS = {
  D: { make: variantD, name: "按接入方式分组", src: "Raycast · Models & Providers" },
  E: { make: variantE, name: "一页平铺", src: "Zed · llm_providers_page.rs" },
  F: { make: variantF, name: "只列在用的 + 添加", src: "Chatbox · ProviderList / Spotlight" },
  G: { make: variantG, name: "细线列表 + 计数", src: "Cline · provider-list-view.tsx" },
};
const params = new URLSearchParams(location.search);
let cur = VARIANTS[params.get("v")] ? params.get("v") : "D";
let inst = null;

const settings = document.getElementById("settings");
const current = h("p", { id: "model-current", class: "settings-current", "data-tone": "ok" });
const stage = h("section", { class: "pv-stage", "aria-labelledby": "model-title" });
settings.append(
  h("header", { class: "settings-head" }, h("img", { src: BRAND, alt: "" }), h("h1", {}, "模型与语音")),
  current, stage);

function renderCurrent() { current.textContent = state.config ? `正在使用：${labelOf(state.config.provider)} · ${state.config.modelId}` : "还没有选择模型。"; }
// 每次点击后刷新顶部「正在使用」。
document.addEventListener("click", () => setTimeout(renderCurrent), true);
document.addEventListener("keydown", () => setTimeout(renderCurrent), true);

function mount(v) {
  cur = v;
  document.body.dataset.variant = v;
  stage.replaceChildren(
    h("div", { class: "pv-stage-head" }, h("h2", { id: "model-title" }, "模型"), h("p", { class: "settings-sub" }, "用你自己的套餐调用模型。密钥只保存在这个浏览器里。")));
  const box = h("div", { class: "pv-variant" });
  stage.append(box);
  document.querySelectorAll(".rc-menu,.sp-overlay").forEach((n) => n.remove());
  inst = VARIANTS[v].make(box);
  renderCurrent();
  picker.querySelectorAll("[data-v]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === v)));
  srcLine.textContent = `参考源码：${VARIANTS[v].src}`;
  const u = new URL(location.href); u.searchParams.set("v", v); history.replaceState(null, "", u);
}

const srcLine = h("div", { class: "pk-src" });
const picker = h("nav", { class: "pk", "aria-label": "挑一版" },
  h("div", { class: "pk-title" }, "模型设置 · 参考源码版"),
  h("div", { class: "pk-btns" }, Object.entries(VARIANTS).map(([k, v]) => h("button", { type: "button", "data-v": k, onclick: () => mount(k) }, h("b", {}, k), v.name))),
  srcLine,
  h("button", { type: "button", class: "pk-reset", onclick: () => { resetState(); mount(cur); } }, "恢复初始状态"),
  h("p", { class: "pk-note" }, "原型：不联网、不保存 key，刷新即还原。"));
if (!params.has("nopicker")) document.body.prepend(picker);
if (params.has("reduce")) document.documentElement.classList.add("force-reduce");
mount(cur);
window.__pv = { mount, state: () => state };
