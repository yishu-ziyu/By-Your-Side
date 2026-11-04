import { createElement as icon, Check } from "lucide";
import type { ModelConnectionIdentity, ModelConnectionTarget, ModelOption } from "../../../shared/protocol.js";
import { isModelTimeoutError, type ModelErrorCopy } from "../../../shared/user-facing.js";
import { displayName } from "./models.js";

const LATER_SECONDS = 8;

const AUTO_WAITS = [8, 16, 32];

const reducedMotion = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

export interface KeyTestResult { ok: boolean; ms?: number; reason?: string; detail?: string }
export interface KeyTarget { saveRequestId?: string; config: ModelConnectionTarget; credential: unknown; conversationId: string | null; runId: string; roles: string; connection: string }

interface ErrorCardHost {
  mount(el: HTMLElement): void;
  app: HTMLElement;
  models(): ModelOption[];
  currentModel(): string | undefined;
  switchModel(id: string): Promise<void>;
  retry(key?: string, auto?: boolean, target?: KeyTarget): void;
  ownsAutoRetry(): Promise<boolean>;
  resolveKeyTarget(identity: ModelConnectionIdentity): Promise<KeyTarget | null>;
  testKey(key: string, target: KeyTarget): Promise<KeyTestResult>;
  saveKey(target: KeyTarget, key: string, stillCurrent: () => boolean): Promise<boolean>;
  scrollToEnd(): void;
}

export function mountErrorCards(host: ErrorCardHost) {
  let card: HTMLElement | null = null;
  let recovering: string | null = null;
  let stopOnline: (() => void) | null = null;
  let autoUsed = 0;
  let auto = false;
  let shown: ModelErrorCopy | null = null;
  let stopCountdown: (() => void) | null = null;

  const button = (label: string, act: string, primary = false) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = primary ? "btn-primary" : "btn-quiet";
    b.dataset.act = act;
    b.textContent = label;

    return b;
  };

  const clearOnline = () => { stopOnline?.(); stopOnline = null; };
  const clearTimers = () => { clearOnline(); stopCountdown?.(); stopCountdown = null; };

  const superseded = (el: HTMLElement) => [...document.querySelectorAll(".msg.user")].some(u => (el.compareDocumentPosition(u) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);

  function recover(source: string, key?: string, autoSent = false, target?: KeyTarget): void {
    if (!card) return;
    clearTimers();
    recovering = source;
    const line = document.createElement("p");
    line.className = "error-card-status";
    line.textContent = `${source}，正在从出错处继续…`;
    card.classList.add("is-recovering");
    card.replaceChildren(line);
    host.retry(key, autoSent, target);
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
        stopCountdown?.();
        stopCountdown = null;
        row.parentElement?.querySelectorAll(".error-card-countdown, .error-card-wait").forEach(el => el.remove());

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

  function armCountdown(el: HTMLElement): void {
    const line = el.querySelector<HTMLElement>(".error-card-countdown");
    const bar = el.querySelector<HTMLElement>(".error-card-wait");

    if (!line || !bar) return;
    const attempt = autoUsed + 1;
    const seconds = Math.round(AUTO_WAITS[autoUsed]! * (0.8 + Math.random() * 0.4));
    const due = Date.now() + seconds * 1000;
    bar.style.setProperty("--wait", `${seconds}s`);
    const visibleText = document.createElement("span");
    visibleText.setAttribute("aria-hidden", "true");
    const spoken = document.createElement("span");
    spoken.className = "error-card-announce";
    spoken.textContent = `稍后自动重试，第 ${attempt} 次，共 ${AUTO_WAITS.length} 次。`;
    line.replaceChildren(visibleText, spoken);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let owner: boolean | null = null;
    stopCountdown = () => clearTimeout(timer);
    const live = () => card === el && el.isConnected && el.contains(line);

    const tick = () => {
      if (!live()) return;

      if (superseded(el)) { api.retire(); return; }
      const left = Math.ceil((due - Date.now()) / 1000);

      if (left <= 0) {
        if (owner) { autoUsed = attempt; recover("已自动重试", undefined, true); }

        return;
      }

      visibleText.textContent = `${left} 秒后自动重试（第 ${attempt} 次，共 ${AUTO_WAITS.length} 次）`;
      timer = setTimeout(tick, due - Date.now() - (left - 1) * 1000);
    };

    tick();
    void host.ownsAutoRetry().catch(() => true).then((mine) => {
      owner = mine;

      if (!live()) return;

      if (!mine) { manual(el); return; }

      if (Date.now() >= due) tick();
    });
  }

  function manual(el: HTMLElement): void {
    stopCountdown?.();
    stopCountdown = null;
    auto = false;

    if (shown) el.replaceChildren(...render(shown).childNodes);
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
      const fix = button(copy.modelConnection ? "换密钥" : "去设置", "fix-key", true);
      fix.addEventListener("click", () => { if (copy.modelConnection) openKeySheet(copy); else void chrome.runtime.openOptionsPage(); });
      const again = button("仍然重试", "retry-anyway");
      again.addEventListener("click", () => recover("已重试"));
      row.append(fix, again);
    } else if (copy.kind === "busy" && auto && autoUsed < AUTO_WAITS.length) {
      text.className = "error-card-countdown";
      const wait = document.createElement("div");
      wait.className = "error-card-wait";
      wait.append(document.createElement("span"));
      text.after(wait);
      const now = button("立即重试", "retry-now", true);
      now.addEventListener("click", () => { autoUsed += 1; recover("已重试"); });
      const pick = button("换一个模型 ▾", "pick-model");
      row.append(now, pick);
      root.append(modelMenu(row, pick));
    } else if (copy.kind === "busy" || copy.kind === "quota" || copy.kind === "missing" || copy.kind === "other") {
      const pick = button("换一个模型 ▾", "pick-model", copy.kind !== "other");
      row.append(pick);

      if (copy.kind === "busy" || copy.kind === "quota") {
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
    const model = copy.model ?? "";
    const [provider = "", ...rest] = model.split("/");
    const owner = card;
    const targetPromise = copy.modelConnection && copy.model === `${copy.modelConnection.provider}/${copy.modelConnection.modelId}` ? host.resolveKeyTarget(copy.modelConnection).catch(() => null) : Promise.resolve(null);
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
      const target = await targetPromise.catch(() => null);
      const result = target && owner === card && shown === copy ? await host.testKey(key, target).catch((): KeyTestResult => ({ ok: false, reason: "测试没有完成，再试一次。" })) : { ok: false, reason: "无法核对原连接，请到设置里检查。" };
      test.disabled = false;

      if (result.ok && input.value.trim() === key && owner === card && shown === copy) {
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
      const target = await targetPromise.catch(() => null);
      const saved = target && owner === card && shown === copy && await host.saveKey(target, key, () => owner === card && shown === copy).catch(() => false);
      if (!saved || !target) { tested = ""; status.dataset.tone = "err"; status.textContent = "无法确认密钥是否保存，请到设置核对后再继续。"; return; }
      close();
      if (owner !== card || shown !== copy) return;
      recover("已换密钥", key, false, target);
    });
    host.app.append(sheet);
    requestAnimationFrame(() => { sheet.classList.add("is-open"); input.focus(); });
  }

  const api = {
    recoveryFailed(reason: string): boolean {
      if (!card || recovering === null || !shown) return false;
      recovering = null;
      card.classList.remove("is-recovering");
      card.replaceChildren(...render(shown).childNodes);
      const note = document.createElement("p");
      note.className = "error-card-note";
      note.textContent = reason;
      card.append(note);
      return true;
    },
    show(copy: ModelErrorCopy, live: boolean): void {
      clearTimers();
      recovering = null;
      shown = copy;
      auto = live && !isModelTimeoutError(copy.detail);

      if (card?.isConnected) {
        const fresh = render(copy);
        card.className = fresh.className;
        card.replaceChildren(...fresh.childNodes);

        if (!reducedMotion()) card.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 180, easing: "ease-out" });
        host.scrollToEnd();
        armCountdown(card);

        return;
      }

      autoUsed = 0;
      card = render(copy);
      host.mount(card);
      host.scrollToEnd();
      armCountdown(card);
    },
    delivered(): void {
      if (!card) return;
      const source = recovering;
      const el = card;
      card = null;
      clearTimers();
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
    retire(): void {
      if (!card || recovering !== null) return;
      clearTimers();
      card.querySelector(".error-card-wait")?.remove();
      const countdown = card.querySelector(".error-card-countdown");

      if (countdown) countdown.replaceChildren("有了新消息，不再自动重试。");
      card.querySelectorAll("button").forEach(b => { b.disabled = true; });
      card.classList.add("is-retired");
      card = null;
    },
  };

  return api;
}
