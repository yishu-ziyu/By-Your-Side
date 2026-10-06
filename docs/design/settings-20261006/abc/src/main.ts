/** 模型与语音设置页 · 高保真原型。?v=A|B|C 选版本；?nopicker 隐藏右侧挑选面板。不发网络请求、不保存任何东西。 */
import { h } from "./common";
import { lowerSections } from "./lower";
import { variantA } from "./variant-a";
import { variantB } from "./variant-b";
import { variantC } from "./variant-c";
import brand from "./brand-mark.svg";

const params = new URLSearchParams(location.search);
const v = (params.get("v") ?? "A").toUpperCase();
document.body.className = `settings-page v-${v}` + (params.has("nopicker") ? " hide-picker" : "");

const VARIANTS: Record<string, { name: string; desc: string; src: string; make: () => HTMLElement }> = {
  A: { name: "安静列表", desc: "当前模型一行；下面一张列表，已连接在上，其余折起；点一行就地展开。", src: "Cherry Studio ProviderList.tsx · Zed llm_providers_page.rs", make: variantA },
  B: { name: "左右两栏", desc: "左栏选服务商（搜索 + 已连接置顶），右栏只放这一家的凭据和模型。", src: "Cherry Studio ProviderSettings（ProviderList / ProviderListItem）", make: variantB },
  C: { name: "命令面板", desc: "当前模型一张卡；「换一个」或 ⌘K 打开可搜索的浮层，已连接的模型在前。", src: "Zed language_model_selector.rs · Open WebUI Selector.svelte", make: variantC },
};
const cur = VARIANTS[v] ?? VARIANTS.A;

const root = h("main", { id: "settings" },
  h("header", { class: "settings-head" }, h("img", { src: brand, alt: "" }), h("h1", { text: "模型与语音" })),
  cur.make(), ...lowerSections());
document.body.append(root);

const picker = h("aside", { id: "picker", "aria-label": "原型版本" },
  h("h2", { text: "模型与语音 · 原型" }),
  h("div", { class: "seg seg-picker" }, ...Object.keys(VARIANTS).map((k) => h("button", { type: "button", "aria-pressed": String(k === v), onclick: () => { params.set("v", k); location.search = params.toString(); } }, `${k} ${VARIANTS[k].name}`))),
  h("p", { class: "pk-desc", text: cur.desc }),
  h("p", { class: "pk-src" }, h("span", { text: "参考源码：" }), cur.src),
  h("p", { class: "pk-note", text: "原型不发网络请求，也不保存 key；登录和测试连接是本地模拟。" }));
document.body.append(picker);
