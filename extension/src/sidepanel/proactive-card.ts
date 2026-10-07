import { NUDGE_ACT, NUDGE_DISMISS, NUDGE_PANEL_KEY, isNudgePanelOffer, type NudgeCard } from "../shared/nudge.js";

/**
 * 侧栏里的主动卡（YIS-106）：一句话，第一个词是按钮，下面一行出处。
 * 点句子其余部分，这件事进输入框当草稿；悬停出 ×，点了收起。按动词交给后台。
 * 卡由后台写进 session 存储，这里只在它属于当前会话时画出来。
 */

type Deps = {
  mount: (node: HTMLElement) => void;
  selected: () => string;
  ready: () => boolean;
  ask: (text: string) => void;
};

const SOURCE_LIMIT = 24;

function ago(seenAt: number | undefined, now: number): string {
  if (seenAt === undefined) return "正在看";
  const minutes = Math.floor((now - seenAt) / 60_000);

  if (minutes < 1) return "刚刚";

  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);

  return hours < 24 ? `${hours} 小时前` : `${Math.floor(hours / 24)} 天前`;
}

const clip = (text: string, max: number) => ([...text].length > max ? `${[...text].slice(0, max).join("")}…` : text);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  node.className = className;

  if (text !== undefined) node.textContent = text;

  return node;
}

function favicon(url: string): HTMLImageElement {
  const img = el("img", "pc-icon");

  img.alt = "";
  img.src = `${chrome.runtime.getURL("/_favicon/")}?pageUrl=${encodeURIComponent(url)}&size=32`;

  return img;
}

export function installProactiveCard(deps: Deps) {
  let shown: { id: string; node: HTMLElement } | null = null;

  const reduce = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  const remove = (animate: boolean) => {
    const node = shown?.node;

    shown = null;

    if (!node) return;

    if (!animate || reduce()) { node.remove();

      return; }
    node.style.height = `${node.offsetHeight}px`;
    node.classList.add("gone");
    setTimeout(() => node.classList.add("collapse"), 200);
    setTimeout(() => node.remove(), 460);
  };

  const render = (card: NudgeCard): HTMLElement => {
    const root = el("div", "pc");
    const face = el("div", "pc-face");
    const verb = el("button", "pc-verb", card.actionLabel);
    const obj = el("span", "pc-obj");
    const close = el("button", "pc-x", "×");

    root.dataset.nudgeId = card.id;
    verb.type = "button";
    obj.tabIndex = 0;
    obj.setAttribute("role", "button");
    obj.title = "放进输入框接着问";
    obj.append(card.sentence);

    if (card.url || card.party) {
      const who = el("span", "pc-who");

      if (card.url) who.append(favicon(card.url));

      if (card.party) who.append(card.party);
      obj.append(" ", who);
    }
    const source = `来自：${card.source ? `${clip(card.source, SOURCE_LIMIT)} · ` : ""}${ago(card.seenAt, Date.now())}`;

    face.append(verb, obj, el("span", "pc-src", source));
    close.type = "button";
    close.setAttribute("aria-label", "收起这张卡");
    root.append(face, close);

    const askAbout = () => deps.ask(`关于「${card.actionLabel}${card.sentence}」：`);

    obj.addEventListener("click", askAbout);
    obj.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); askAbout(); } });
    close.addEventListener("click", () => {
      void chrome.runtime.sendMessage({ type: NUDGE_DISMISS, id: card.id }).catch(() => {});
      remove(true);
    });
    verb.addEventListener("click", () => {
      verb.classList.add("pressed");
      void chrome.runtime.sendMessage({ type: NUDGE_ACT, id: card.id }).catch(() => {});
      remove(true);
    });

    return root;
  };

  const refresh = async () => {
    if (!deps.ready()) return;
    // 只有后台 nudge.ts 写这个键；形状照样核对。
    const offer = (await chrome.storage.session.get(NUDGE_PANEL_KEY))[NUDGE_PANEL_KEY];
    const card = isNudgePanelOffer(offer) && offer.conversationId === deps.selected() ? offer.card : null;

    if (shown && shown.id === card?.id && shown.node.isConnected) return;
    remove(false);

    if (!card || !deps.ready()) return;
    const node = render(card);

    shown = { id: card.id, node };
    deps.mount(node);
  };

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes[NUDGE_PANEL_KEY]) void refresh();
  });

  return { refresh };
}
