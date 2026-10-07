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

/** 句子：动词后面的宾语，再加对象图标和对象名；下面一行出处。动词按钮由调用方放在最前。 */
function sentence(card: NudgeCard, obj: HTMLElement): HTMLElement[] {
  obj.append(card.sentence);

  if (card.url || card.party) {
    const who = el("span", "pc-who");

    if (card.url) who.append(favicon(card.url));

    if (card.party) who.append(card.party);
    obj.append(" ", who);
  }

  return [obj, el("span", "pc-src", `来自：${card.source ? `${clip(card.source, SOURCE_LIMIT)} · ` : ""}${ago(card.seenAt, Date.now())}`)];
}

export function installProactiveCard(deps: Deps) {
  // busy：动词已按下，等这一轮进对话后换成卡的样子；这段时间存储里的卡删了也不收。
  let shown: { id: string; node: HTMLElement; busy: boolean } | null = null;

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
    const fail = el("span", "pc-fail");

    root.dataset.nudgeId = card.id;
    verb.type = "button";
    obj.tabIndex = 0;
    obj.setAttribute("role", "button");
    obj.title = "放进输入框接着问";
    face.append(verb, ...sentence(card, obj));
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
    // 按下就做，不弹卡、不再问：文字先淡出，壳留在原位，等这一轮进对话。
    verb.addEventListener("click", async () => {
      if (shown?.node !== root || shown.busy) return;
      shown.busy = true;
      fail.remove();
      verb.classList.add("pressed");
      root.classList.add("fading");
      const reply: { ok?: boolean } | undefined = await chrome.runtime.sendMessage({ type: NUDGE_ACT, id: card.id }).catch(() => undefined);

      if (reply?.ok) {
        // 正常情况下这一轮马上进对话、换掉这张卡；万一没等到，也不留一张按不动的卡。
        setTimeout(() => { if (shown?.node === root) remove(false); }, 5_000);

        return;
      }
      if (shown?.node === root) shown.busy = false;
      verb.classList.remove("pressed");
      root.classList.remove("fading");
      fail.textContent = "没交给助手：助手没连上。再按一次试试。";
      face.append(fail);
    });

    return root;
  };

  /**
   * 这一轮是按卡发起的：用户消息画成按下的卡（动词实心、句子、出处），不画成气泡。
   * 刚按下的那张卡还在时，换在它的位置上，高度平滑过渡；回放历史时直接画。
   */
  const turn = (card: NudgeCard, bubble: HTMLElement) => {
    const face = el("div", "pc-face");

    face.append(el("span", "pc-verb done", card.actionLabel), ...sentence(card, el("span", "pc-obj")));
    bubble.classList.add("card-turn");
    bubble.replaceChildren(face);
    const live = shown?.id === card.id ? shown.node : null;

    if (!live?.isConnected) return;
    shown = null;
    const from = live.offsetHeight;

    live.replaceWith(bubble);

    if (reduce()) return;
    const to = bubble.offsetHeight;

    bubble.style.height = `${from}px`;
    bubble.style.overflow = "hidden";
    void bubble.offsetHeight;
    bubble.classList.add("growing");
    bubble.style.height = `${to}px`;
    setTimeout(() => { bubble.style.height = ""; bubble.style.overflow = ""; bubble.classList.remove("growing"); }, 380);
  };

  const refresh = async () => {
    if (!deps.ready()) return;
    // 只有后台 nudge.ts 写这个键；形状照样核对。
    const offer = (await chrome.storage.session.get(NUDGE_PANEL_KEY))[NUDGE_PANEL_KEY];
    const card = isNudgePanelOffer(offer) && offer.conversationId === deps.selected() ? offer.card : null;

    if (shown?.busy && shown.node.isConnected) return;

    if (shown && shown.id === card?.id && shown.node.isConnected) return;
    remove(false);

    if (!card || !deps.ready()) return;
    const node = render(card);

    shown = { id: card.id, node, busy: false };
    deps.mount(node);
  };

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes[NUDGE_PANEL_KEY]) void refresh();
  });

  return { refresh, turn };
}
