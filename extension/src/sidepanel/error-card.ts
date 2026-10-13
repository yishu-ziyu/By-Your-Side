/**
 * 模型出错后的错误卡（#74，docs/evals/20261006-error-states.md）：按错误种类给能修掉原因的动作，修好后从出错处接着做。
 * - auth：「去换 key」打开底部面板，测试连接通过才能「保存并继续」；「仍然重试」原样再试。
 * - busy：「换一个模型」就在卡上选；「稍后重试」倒计时后自动接着做。missing 只有换模型。
 * - network：「重试」；网络恢复时自动重试一次。
 * 接着做之后卡片收成一行状态；答案送达时卡片在原地收成一行回执「出过错 · …，已从出错处继续」，
 * 行留在出错的位置，续写的答案跟在它下面。再出错不换新卡：同一张卡原地换内容、淡一下，不抖也不重新进场（#286）。
 */
import { createElement as icon, Check } from "lucide";
import type { ModelOption } from "../../../shared/protocol.js";
import type { ModelErrorCopy } from "../../../shared/user-facing.js";
import { displayName } from "./models.js";

/** 限流时等多久再自动重试：循环自己已在 0.5、1 秒各重试过一次，再等太短多半还是 429。 */
const LATER_SECONDS = 8;

const reducedMotion = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

export interface KeyTestResult { ok: boolean; ms?: number; reason?: string; detail?: string }

export interface ErrorCardHost {
  /** 把卡插进消息流的当前位置（接续锚点之前），让之后到达的答案自然跟在它下面。 */
  mount(el: HTMLElement): void;
  /** 底部换 key 面板挂在这里（侧栏根容器）。 */
  app: HTMLElement;
  models(): ModelOption[];
  currentModel(): string | undefined;
  /** 发 set_model；返回的 Promise 在宿主确认换好（model_info）后完成。 */
  switchModel(id: string): Promise<void>;
  /** 发 retry_after_error；key 是刚换的 key。 */
  retry(key?: string): void;
  testKey(key: string): Promise<KeyTestResult>;
  saveKey(provider: string, key: string): Promise<void>;
  scrollToEnd(): void;
}

export function mountErrorCards(host: ErrorCardHost) {
  let card: HTMLElement | null = null;
  /** 接着做之后、答案送达之前：回执要写明用户做了什么。 */
  let recovering: string | null = null;
  let stopOnline: (() => void) | null = null;

  const button = (label: string, act: string, primary = false) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = primary ? "btn-primary" : "btn-quiet";
    b.dataset.act = act;
    b.textContent = label;

    return b;
  };

  const clearOnline = () => { stopOnline?.(); stopOnline = null; };

  function recover(source: string, key?: string): void {
    if (!card) return;
    clearOnline();
    recovering = source;
    const line = document.createElement("p");
    line.className = "error-card-status";
    line.textContent = `${source}，正在从出错处继续…`;
    card.classList.add("is-recovering");
    card.replaceChildren(line);
    host.retry(key);
  }

  function modelMenu(row: HTMLElement, trigger: HTMLButtonElement): HTMLElement {
    const menu = document.createElement("div");
    menu.className = "error-card-menu";
    menu.hidden = true;
    const current = host.currentModel();

    for (const option of host.models().filter(m => m.id !== current).slice(0, 5)) {
      const item = document.createElement("button");
      item.type = "button";
      item.textContent = displayName(option);
      item.addEventListener("click", async () => {
        menu.hidden = true;
        trigger.disabled = true;
        trigger.textContent = "正在切换…";
        row.querySelector('[data-act="later"]')?.remove();

        try {
          await host.switchModel(option.id);
          recover(`已换成 ${displayName(option)}`);
        } catch {
          trigger.disabled = false;
          trigger.textContent = "换一个模型 ▾";
        }
      });
      menu.append(item);
    }

    const settings = document.createElement("button");
    settings.type = "button";
    settings.textContent = "去设置里连接其他模型…";
    settings.addEventListener("click", () => { menu.hidden = true; void chrome.runtime.openOptionsPage(); });
    menu.append(settings);
    trigger.addEventListener("click", () => { menu.hidden = !menu.hidden; });

    return menu;
  }

  function later(b: HTMLButtonElement): void {
    b.disabled = true;
    let left = LATER_SECONDS;

    const tick = () => {
      if (!b.isConnected) return;

      if (left === 0) return recover("已重试");
      b.textContent = `${left} 秒后自动重试…`;
      left -= 1;
      setTimeout(tick, 1000);
    };

    tick();
  }

  function render(copy: ModelErrorCopy): HTMLElement {
    const root = document.createElement("section");
    root.className = "msg error-card";
    root.setAttribute("role", "alert");
    const head = document.createElement("strong");
    head.textContent = copy.title;
    const text = document.createElement("p");
    text.textContent = copy.copy;
    const row = document.createElement("div");
    row.className = "error-card-actions";
    root.append(head, text, row);

    if (copy.kind === "auth") {
      const fix = button("换密钥", "fix-key", true);
      fix.addEventListener("click", () => openKeySheet(copy));
      const again = button("仍然重试", "retry-anyway");
      again.addEventListener("click", () => recover("已重试"));
      row.append(fix, again);
    } else if (copy.kind === "busy" || copy.kind === "missing" || copy.kind === "other") {
      const pick = button("换一个模型 ▾", "pick-model", copy.kind !== "other");
      row.append(pick);

      if (copy.kind === "busy") {
        const wait = button("稍后重试", "later");
        wait.addEventListener("click", () => later(wait));
        row.append(wait);
      } else if (copy.kind === "other") {
        const again = button("重试", "retry", true);
        again.addEventListener("click", () => recover("已重试"));
        row.prepend(again);
      }

      root.append(modelMenu(row, pick));
    } else {
      const again = button("重试", "retry", true);
      again.addEventListener("click", () => recover("已重试"));
      row.append(again);
      const note = document.createElement("p");
      note.className = "error-card-note";
      note.textContent = "网络恢复后，助手会自动重试一次。";
      root.append(note);
      const online = () => recover("网络恢复后已自动重试");
      addEventListener("online", online, { once: true });
      stopOnline = () => removeEventListener("online", online);
    }

    const details = document.createElement("details");
    details.className = "error-card-tech";
    const summary = document.createElement("summary");
    summary.textContent = "技术详情";
    const pre = document.createElement("pre");
    pre.textContent = copy.detail;
    details.append(summary, pre);
    root.append(details);

    return root;
  }

  function openKeySheet(copy: ModelErrorCopy): void {
    if (host.app.querySelector("#key-sheet")) return;
    const [provider = "", ...rest] = (copy.model ?? host.currentModel() ?? "").split("/");
    const sheet = document.createElement("section");
    sheet.id = "key-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-label", "换密钥");
    sheet.innerHTML = `<span class="key-sheet-grab"></span><h3>换密钥</h3>
      <div class="key-sheet-model"><span></span><span></span></div>
      <input id="key-sheet-input" type="password" autocomplete="off" spellcheck="false" placeholder="粘贴新密钥">
      <p class="key-sheet-note">密钥只存在这个浏览器里。如果你用账号登录，就<button type="button" class="key-sheet-link">去设置里重新登录</button>。</p>
      <div class="key-sheet-actions">
        <button type="button" id="key-sheet-test" class="btn-quiet">测试连接</button>
        <button type="button" id="key-sheet-save" class="btn-primary" disabled>保存并继续</button>
        <button type="button" id="key-sheet-close" class="btn-quiet">取消</button>
      </div>
      <div id="key-sheet-status" role="status"></div>`;
    const [providerEl, modelEl] = sheet.querySelectorAll<HTMLElement>(".key-sheet-model span");
    providerEl!.textContent = provider;
    modelEl!.textContent = rest.join("/");
    const input = sheet.querySelector<HTMLInputElement>("#key-sheet-input")!;
    const test = sheet.querySelector<HTMLButtonElement>("#key-sheet-test")!;
    const save = sheet.querySelector<HTMLButtonElement>("#key-sheet-save")!;
    const status = sheet.querySelector<HTMLElement>("#key-sheet-status")!;
    let tested = "";

    const close = () => { sheet.classList.remove("is-open"); setTimeout(() => sheet.remove(), 260); };

    input.addEventListener("input", () => { save.disabled = input.value.trim() !== tested || !tested; });
    sheet.querySelector(".key-sheet-link")!.addEventListener("click", () => void chrome.runtime.openOptionsPage());
    sheet.querySelector("#key-sheet-close")!.addEventListener("click", close);
    test.addEventListener("click", async () => {
      const key = input.value.trim();

      if (!key) { status.dataset.tone = "err"; status.textContent = "先粘贴新密钥。";

 return; }

      test.disabled = true;
      save.disabled = true;
      status.dataset.tone = "";
      status.textContent = "正在测试…";
      const result = await host.testKey(key).catch((): KeyTestResult => ({ ok: false, reason: "测试没有完成，再试一次。" }));
      test.disabled = false;

      if (result.ok && input.value.trim() === key) {
        tested = key;
        save.disabled = false;
        status.dataset.tone = "ok";
        status.replaceChildren(icon(Check), document.createTextNode(`连上了 · ${(result.ms ?? 0) < 1000 ? "不到 1 秒" : `${((result.ms ?? 0) / 1000).toFixed(1)} 秒`}`));

        return;
      }

      tested = "";
      status.dataset.tone = "err";
      status.textContent = `连接失败：${result.reason ?? "再试一次。"}`;

      if (result.detail) {
        const details = document.createElement("details");
        details.className = "error-card-tech";
        details.innerHTML = "<summary>技术详情</summary><pre></pre>";
        details.querySelector("pre")!.textContent = result.detail;
        status.append(details);
      }
    });
    save.addEventListener("click", async () => {
      const key = tested;

      if (!key) return;
      save.disabled = true;
      await host.saveKey(provider, key);
      close();
      recover("已换密钥", key);
    });
    host.app.append(sheet);
    requestAnimationFrame(() => { sheet.classList.add("is-open"); input.focus(); });
  }

  return {
    /** 模型出错：没有卡就在消息流末尾出一张（rise 进场）。上一张还在就原地换内容、淡一下：位置不动，不抖也不重新进场（#286）。 */
    show(copy: ModelErrorCopy): void {
      clearOnline();
      recovering = null;

      if (card?.isConnected) {
        const fresh = render(copy);
        card.className = fresh.className;
        card.replaceChildren(...fresh.childNodes);

        if (!reducedMotion()) card.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 180, easing: "ease-out" });
        host.scrollToEnd();

        return;
      }

      card = render(copy);
      host.mount(card);
      host.scrollToEnd();
    },
    /** 答案送达：接着做成功了，卡在原地收成一行回执，行留在出错的位置，续写的答案跟在它下面。 */
    delivered(): void {
      if (!card) return;
      const source = recovering;
      const el = card;
      card = null;
      clearOnline();
      recovering = null;

      if (source === null) { el.remove(); return; }
      const from = el.getBoundingClientRect().height;
      el.className = "msg error-receipt";
      el.removeAttribute("role");
      el.replaceChildren(icon(Check), document.createTextNode(`出过错 · ${source}，已从出错处继续`));
      const to = el.getBoundingClientRect().height;

      if (!reducedMotion() && to !== from) {
        el.animate(
          [{ height: `${from}px`, opacity: 0.4, overflow: "hidden" }, { height: `${to}px`, opacity: 1, overflow: "hidden" }],
          { duration: 180, easing: "ease-out" },
        );
      }

      host.scrollToEnd();
    },
    /** 用户另发了新任务：旧卡只留作记录，按钮不再可点。 */
    retire(): void {
      if (!card || recovering !== null) return;
      clearOnline();
      card.querySelectorAll("button").forEach(b => { b.disabled = true; });
      card.classList.add("is-retired");
      card = null;
    },
  };
}
