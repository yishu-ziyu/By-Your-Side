import { NUDGE_ACT, NUDGE_UNDO, NUDGE_DISMISS, NUDGE_PANEL_KEY, NUDGE_RESULTS_KEY, NUDGE_PANEL_TTL_MS, nudgeReceipts, isNudgePanelOffer, type NudgeCard, type NudgePanelOffer, type NudgePanelReply } from "../shared/nudge.js";

/**
 * 侧栏里的主动卡：一句话，第一个词是按钮，下面一行出处。
 * 点句子其余部分，这件事进输入框当草稿；悬停出 ×，点了收起。按动词交给后台。
 * 卡由后台写进 session 存储，这里只在它属于当前会话时画出来。
 */

type Deps = {
  mount: (node: HTMLElement) => void;
  selected: () => string;
  ready: () => boolean;
  ask: (text: string) => void;
  memory: (text: string) => void;
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

/** 句子：动词后面的宾语，再加对象图标和对象名；下面一行出处（多久前按 now 算）。动词按钮由调用方放在最前。 */
function sentence(card: NudgeCard, obj: HTMLElement, now = Date.now()): HTMLElement[] {
  obj.append(card.sentence);

  if (card.url || card.party) {
    const who = el("span", "pc-who");

    if (card.url) who.append(favicon(card.url));

    if (card.party) who.append(card.party);
    obj.append(" ", who);
  }

  return [obj, el("span", "pc-src", `来自：${card.source ? `${clip(card.source, SOURCE_LIMIT)} · ` : ""}${ago(card.seenAt, now)}`)];
}

export function installProactiveCard(deps: Deps) {
  // busy：动词已按下，等这一轮进对话后换成卡的样子；这段时间存储里的卡删了也不收。
  let shown: { id: string; node: HTMLElement; busy: boolean; signature: string } | null = null;
  let refreshVersion = 0;
  const resultNodes = new Map<string, { node: HTMLElement; signature: string }>();
  // 本侧栏已按过或收起的卡：后台删存储之前读到旧值，也不再画一次。
  const handled = new Set<string>();

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

  const memoryDetails = (card: NudgeCard): HTMLDetailsElement | null => {
    if (!card.preparation) return null;
    const details = el("details", "pc-memory");
    const summary = el("summary", "", "按你确认的做法");
    const method = el("p", "", card.preparation.memory.text);
    const edit = el("button", "pc-memory-edit", "查看或修改这条习惯");
    edit.type = "button";
    edit.addEventListener("click", () => deps.memory(card.preparation!.memory.text));
    details.append(summary, method, edit);
    return details;
  };

  const links = (offer: NudgePanelOffer): HTMLOListElement => {
    const list = el("ol", "pc-links");
    for (const link of offer.card.preparation?.links ?? []) {
      const item = el("li", "");
      const anchor = el("a", "", clip(link.title, 48));
      anchor.href = link.url;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.title = link.url;
      item.append(anchor);
      const opened = offer.result?.opened.find(tab => tab.url === link.url);
      const reused = offer.result?.reused.some(tab => tab.url === link.url);
      const status = opened?.closed ? "已收起" : opened ? "已打开" : reused ? "原来已打开" : offer.result && offer.result.state !== "opening" ? "未打开" : new URL(link.url).hostname;
      item.append(el("span", "pc-link-state", status));
      list.append(item);
    }
    return list;
  };

  const renderResult = (offer: NudgePanelOffer): HTMLElement => {
    const result = offer.result!;
    const root = el("div", "pc pc-result");
    root.dataset.nudgeId = offer.card.id;
    root.dataset.nudgeResult = result.state;
    const face = el("div", "pc-face");
    const outcome = el("strong", "pc-outcome", result.message);
    outcome.setAttribute("role", "status");
    face.append(outcome);
    if (result.completedAt) {
      const elapsed = result.completedAt - result.clickedAt;
      face.append(el("span", "pc-src", "准备耗时 " + (elapsed < 100 ? "不到 0.1 秒" : (elapsed / 1000).toFixed(1) + " 秒")));
    }
    face.append(links(offer));
    const memory = memoryDetails(offer.card);
    if (memory) face.append(memory);
    if (result.state !== "opening" && result.state !== "undone" && result.opened.some(tab => tab.canUndo && !tab.closed)) {
      const undo = el("button", "pc-undo", "撤回这次打开");
      undo.type = "button";
      undo.addEventListener("click", async () => {
        if (undo.disabled) return;
        undo.disabled = true;
        const reply: NudgePanelReply | undefined = await chrome.runtime.sendMessage({ type: NUDGE_UNDO, id: offer.card.id }).catch(() => undefined);
        if (!reply?.ok) { undo.disabled = false; outcome.textContent = "暂时没能撤回，再试一次。"; }
        else void refresh();
      });
      face.append(undo, el("span", "pc-src", "只收起本次新开、你还没接着使用的标签页。"));
    }
    const close = el("button", "pc-x", "×");
    close.type = "button";
    close.setAttribute("aria-label", "收起这张卡");
    close.disabled = result.state === "opening";
    close.addEventListener("click", () => {
      void chrome.runtime.sendMessage({ type: NUDGE_DISMISS, id: offer.card.id }).catch(() => {});
      handled.add(offer.card.id);
      if (shown?.node === root) remove(true); else root.remove();
      resultNodes.delete(offer.card.id);
    });
    root.append(face, close);
    return root;
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
    if (card.preparation) {
      face.append(links({ card, conversationId: deps.selected(), at: Date.now() }));
      const memory = memoryDetails(card);
      if (memory) face.append(memory);
    }
    close.type = "button";
    close.setAttribute("aria-label", "收起这张卡");
    root.append(face, close);

    const askAbout = () => deps.ask(`关于「${card.actionLabel}${card.sentence}」：`);

    obj.addEventListener("click", askAbout);
    obj.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); askAbout(); } });
    close.addEventListener("click", () => {
      handled.add(card.id);
      void chrome.runtime.sendMessage({ type: NUDGE_DISMISS, id: card.id }).catch(() => {});
      remove(true);
    });
    // 按下就做，不弹卡、不再问：文字先淡出，壳留在原位，等这一轮进对话。
    verb.addEventListener("click", async () => {
      if (shown?.node !== root || shown.busy) return;
      shown.busy = true;
      fail.remove();
      verb.classList.add("pressed");
      if (card.preparation) verb.disabled = true;
      else root.classList.add("fading");
      const reply: NudgePanelReply | undefined = await chrome.runtime.sendMessage({ type: NUDGE_ACT, id: card.id }).catch(() => undefined);

      if (card.preparation && (reply?.ok || reply?.reason === "gone")) { if (shown?.node === root) shown.busy = false; verb.disabled = false; void refresh(); return; }
      if (reply && !reply.ok && reply.reason === "stale") {
        handled.add(card.id); remove(false);
        const notice = el("div", "pc-fail", "页面或习惯已经变化，这条建议已收起。");
        notice.setAttribute("role", "status");
        deps.mount(notice);
        return;
      }
      if (reply?.ok || reply?.reason === "gone") {
        handled.add(card.id);

        if (!reply.ok) { remove(true);

          return; }
        // 正常情况下这一轮马上进对话、换掉这张卡；万一没等到，也不留一张按不动的卡。
        setTimeout(() => { if (shown?.node === root) remove(false); }, 5_000);

        return;
      }
      if (shown?.node === root) shown.busy = false;
      verb.disabled = false;
      verb.classList.remove("pressed");
      root.classList.remove("fading");
      fail.textContent = reply?.reason === "busy" ? "助手正在做别的事，做完再按。" : "没交给助手：助手没连上。再按一次试试。";
      face.append(fail);
    });

    return root;
  };

  /**
   * 这一轮是按卡发起的：用户消息画成按下的卡（动词实心、句子、出处），不画成气泡。
   * 刚按下的那张卡紧挨在这一轮前面时，换在它的位置上，高度平滑过渡；中间已有别的消息就收掉它，这一轮留在最后，顺序不乱。
   * at：这一轮发出的时间，出处行的「多久前」按它算，回放时不随今天变。
   */
  const turn = (card: NudgeCard, bubble: HTMLElement, at?: number) => {
    const face = el("div", "pc-face");

    face.append(el("span", "pc-verb done", card.actionLabel), ...sentence(card, el("span", "pc-obj"), at));
    bubble.classList.add("card-turn");
    bubble.replaceChildren(face);
    handled.add(card.id);
    const live = shown?.id === card.id ? shown.node : null;

    if (!live?.isConnected) return;
    shown = null;

    if (live.nextElementSibling !== bubble) { live.remove();

      return; }
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
    const version = ++refreshVersion;
    if (!deps.ready()) return;
    const stored = await chrome.storage.session.get([NUDGE_PANEL_KEY, NUDGE_RESULTS_KEY]);
    if (version !== refreshVersion) return;
    const records = nudgeReceipts(stored[NUDGE_RESULTS_KEY]).filter(offer => offer.conversationId === deps.selected() && !handled.has(offer.card.id));
    if (shown && records.some(offer => offer.card.id === shown?.id)) remove(false);
    for (const [id, old] of resultNodes) {
      if (!records.some(offer => offer.card.id === id)) { old.node.remove(); resultNodes.delete(id); }
    }
    for (const offer of records) {
      const signature = JSON.stringify(offer.result);
      const old = resultNodes.get(offer.card.id);
      if (old?.signature === signature && old.node.isConnected) continue;
      const node = renderResult(offer);
      if (old?.node.querySelector<HTMLDetailsElement>(".pc-memory")?.open) {
        const details = node.querySelector<HTMLDetailsElement>(".pc-memory");
        if (details) details.open = true;
      }
      if (old?.node.isConnected) old.node.replaceWith(node);
      else if (shown?.node.isConnected) shown.node.before(node);
      else deps.mount(node);
      resultNodes.set(offer.card.id, { node, signature });
    }
    const offer: unknown = stored[NUDGE_PANEL_KEY];
    const fresh = isNudgePanelOffer(offer) && offer.conversationId === deps.selected()
      && Date.now() - offer.at < NUDGE_PANEL_TTL_MS && !handled.has(offer.card.id) && !records.some(record => record.card.id === offer.card.id);
    const current = fresh ? offer : null;
    const signature = current ? current.card.id + JSON.stringify(current.result ?? null) : "";
    if (shown?.busy && shown.node.isConnected) return;
    if (shown && shown.signature === signature && shown.node.isConnected) return;
    const expanded = shown?.id === current?.card.id && shown?.node.querySelector<HTMLDetailsElement>(".pc-memory")?.open;
    remove(false);
    if (!current || !deps.ready()) return;
    const node = current.result ? renderResult(current) : render(current.card);
    if (expanded) { const details = node.querySelector<HTMLDetailsElement>(".pc-memory"); if (details) details.open = true; }
    shown = { id: current.card.id, node, busy: false, signature };
    deps.mount(node);
  };

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && (changes[NUDGE_PANEL_KEY] || changes[NUDGE_RESULTS_KEY])) void refresh();
  });

  return { refresh, turn };
}
