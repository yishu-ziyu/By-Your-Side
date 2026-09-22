import type { ClientMessage, ServerMessage } from "../../../shared/protocol.js";
import type { ConsentRequest, ConsentStatus } from "../../../shared/consent.js";

type Entry = { request: ConsentRequest; status: "pending" | ConsentStatus; submitted: boolean; message?: string };

/** 卡片文案的纯函数部分：不读页面、不决定权限，只区分两类请求。 */
export function consentHeading(request: ConsentRequest, pending: boolean): string {
  return request.kind === "write"
    ? (pending ? "允许核对并在需要时重设这一项吗？" : "请求确认")
    : (pending ? "允许发送这次请求吗？" : "请求授权");
}

export function consentTargetText(request: ConsentRequest): string {
  return request.kind === "write" ? `任务：${request.goal}` : `${request.method} ${request.url}`;
}

export function consentDetailsText(request: ConsentRequest): { summary: string; content: string } {
  return request.kind === "write"
    ? { summary: "查看动作", content: `未确认的动作：${request.description}\n\n允许后会再次核对：若当前对象已经满足，不写入；否则只执行这一次：${request.tool} ${request.target} = ${request.value}\n\n只对当前任务、当前要求和当前页面实例有效；填写可能触发网站自动保存。` }
    : { summary: "查看发送内容", content: `请求头：\n${JSON.stringify(request.headers, null, 2)}\n\n发送内容：\n${request.body ?? "（无请求正文）"}` };
}

export function consentStatusText(request: ConsentRequest, connected: boolean): string {
  if (!connected) return "连接已断开，本次请求尚未获准。请等待重新连接。";

  return request.kind === "write" ? "仅允许这一次核对/必要时重设；到期后不会执行。" : "仅允许这一次请求；到期后不会发送。";
}

/** 授权入口独立于聊天正文，只发送已有请求的选择。 */
export class ConsentPanel {
  private readonly entries = new Map<string, Entry>();
  private connected = false;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly root: HTMLElement,
    private readonly selected: () => string,
    private readonly title: (id: string) => string,
    private readonly select: (id: string) => void,
    private readonly send: (message: ClientMessage) => boolean,
  ) {
    this.timer = setInterval(() => {
      let changed = false;

      for (const entry of this.entries.values()) {
        if (entry.status === "pending" && Date.now() >= entry.request.expiresAt) {
          entry.status = "expired";
          entry.message = entry.submitted ? "确认回执未收到，执行结果待核对，请查看任务结果。" : "确认已过期，本次请求未发送。";
          changed = true;
        }
      }

      if (changed) this.render();
    }, 1000);
  }

  dispose(): void { clearInterval(this.timer); }

  setConnected(connected: boolean): void {
    this.connected = connected;

    if (!connected) for (const entry of this.entries.values()) {
      if (entry.status === "pending" && entry.submitted) entry.message = "连接已断开，选择结果待核对。";
    }

    this.render();

    if (connected) this.refresh();
  }

  refresh(): void {
    this.render();
    this.send({type: "consent_list", conversationId: this.selected()});
  }

  receive(message: ServerMessage): boolean {
    if (message.type === "consent_request") {
      this.remember(message.request);
    } else if (message.type === "consent_list") {
      const cid = message.conversationId;

      if (!cid) return true;
      const ids = new Set(message.requests.map(request => request.id));

      for (const [key, entry] of this.entries) {
        if (entry.request.conversationId === cid && entry.status === "pending" && !ids.has(entry.request.id)) this.entries.delete(key);
      }

      for (const request of message.requests) this.remember(request, true);
    } else if (message.type === "consent_result") {
      const entry = this.entries.get(this.key(message.conversationId ?? "default", message.requestId));

      if (entry) { entry.status = message.status; entry.message = message.message; }
    } else return false;
    this.render();

    return true;
  }

  private key(cid: string, id: string): string { return `${cid}:${id}`; }

  private remember(request: ConsentRequest, authoritativePending = false): void {
    const key = this.key(request.conversationId, request.id);
    const existing = this.entries.get(key);

    if (existing && existing.status !== "pending") return;

    for (const [key, entry] of this.entries) {
      if (entry.request.conversationId === request.conversationId && entry.status !== "pending") this.entries.delete(key);
    }

    this.entries.set(key, {
      request,
      status: Date.now() >= request.expiresAt ? "expired" : "pending",
      submitted: authoritativePending ? false : existing?.submitted ?? false,
      ...(Date.now() >= request.expiresAt ? {message: "确认已过期，本次请求未发送。"} : {}),
    });
  }

  private decide(entry: Entry, allow: boolean): void {
    if (!this.connected || entry.status !== "pending" || entry.submitted) return;

    if (Date.now() >= entry.request.expiresAt) {
      entry.status = "expired";
      entry.message = "确认已过期，本次请求未发送。";
    } else if (this.send({type: "consent_decision", conversationId: entry.request.conversationId, requestId: entry.request.id, allow})) {
      entry.submitted = true;
      entry.message = "正在确认这次选择…";
    } else entry.message = "连接不可用，选择未发送。连接恢复后可重试。";
    this.render();
  }

  render(): void {
    const focused = document.activeElement as HTMLElement | null;
    const focusCard = focused?.closest<HTMLElement>(".consent-card");
    const focusId = focusCard && this.root.contains(focusCard) ? focusCard.dataset.requestId : undefined;
    const focusSelector = focused?.matches("button") ? `.${focused.className}` : "summary";
    const expanded = new Set([...this.root.querySelectorAll("details[open]")].map(el => el.closest<HTMLElement>(".consent-card")?.dataset.requestId));
    const cid = this.selected();
    const own = [...this.entries.values()].filter(entry => entry.request.conversationId === cid);
    const others = [...new Set([...this.entries.values()].filter(entry => entry.status === "pending" && entry.request.conversationId !== cid).map(entry => entry.request.conversationId))];
    this.root.hidden = own.length === 0 && others.length === 0;
    this.root.dataset.pending = String(own.some(entry => entry.status === "pending"));
    this.root.replaceChildren();

    for (const entry of own) {
      const card = document.createElement("section");
      card.className = "consent-card";
      card.dataset.requestId = entry.request.id;

      if (entry.status !== "pending") {
        card.classList.add("consent-complete");
        const outcome = document.createElement("p");
        outcome.setAttribute("role", "status");
        outcome.tabIndex = -1;
        outcome.textContent = entry.message ?? "本次确认已结束。";
        const dismiss = document.createElement("button");
        dismiss.type = "button";
        dismiss.textContent = "收起";
        dismiss.addEventListener("click", () => {
          this.entries.delete(this.key(entry.request.conversationId, entry.request.id));
          this.render();
        });
        card.append(outcome, dismiss);
        this.root.append(card);

        if (focusId === entry.request.id) outcome.focus({preventScroll: true});
        continue;
      }

      const request = entry.request;
      const heading = document.createElement("h2");
      heading.textContent = consentHeading(request, entry.status === "pending");
      const target = document.createElement("p");
      target.className = "consent-target";
      target.textContent = consentTargetText(request);
      const details = document.createElement("details");
      details.open = expanded.has(entry.request.id);
      const summary = document.createElement("summary");
      const copy = consentDetailsText(request);
      summary.textContent = copy.summary;
      const content = document.createElement("pre");
      content.textContent = copy.content;
      details.append(summary, content);
      const status = document.createElement("p");
      status.className = "consent-status";
      status.setAttribute("role", "status");
      status.tabIndex = -1;
      status.textContent = entry.message ?? consentStatusText(request, this.connected);
      card.append(heading, target, details, status);

      if (entry.status === "pending") {
        const actions = document.createElement("div");
        actions.className = "consent-actions";

        for (const [allow, label] of [[false, "拒绝"], [true, "允许一次"]] as const) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = label;
          button.className = allow ? "consent-allow" : "consent-reject";
          button.disabled = !this.connected || entry.submitted;
          button.addEventListener("click", () => this.decide(entry, allow));
          actions.append(button);
        }

        card.append(actions);
      }

      this.root.append(card);

      if (focusId === entry.request.id) {
        const replacement = card.querySelector<HTMLElement>(focusSelector);
        (replacement && !(replacement instanceof HTMLButtonElement && replacement.disabled) ? replacement : status).focus({preventScroll: true});
      }
    }

    for (const other of others) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "consent-other";
      button.textContent = `${this.title(other)}：有请求等待确认`;
      button.addEventListener("click", () => this.select(other));
      this.root.append(button);
    }
  }
}
