import { displayNameFor, personFor } from "../../../shared/cast.js";
import { mountGrok, mountKenney } from "../shared/grok-bot.js";
import { isLeadSession, type AgentUiEvent } from "../../../shared/protocol.js";

export interface Collaborator {
  id: string;
  task: string;
  output: string;
  status: string;
  delivered: boolean;
  ended: boolean;
}

interface PendingTool {
  sessionId: string;
  name: string;
  params: Record<string, unknown>;
}

/** 每个执行块拥有一份状态；由同一事件流恢复，既不依赖控制快照，也不另存会话状态。 */
export class CollaborationProgress {
  readonly members = new Map<string, Collaborator>();
  private readonly pending = new Map<string, PendingTool>();

  waitingFor(from: unknown): string {
    if (typeof from !== "string" || !from) return "等待助手结果";

    if (isLeadSession(from)) return "等待主助手回复";
    const member = this.members.get(from);

    return member
      ? `等待 ${displayNameFor(from)} 的${member.output}`
      : `等待 ${displayNameFor(from)} 的消息`;
  }

  get leadWaiting(): string | null {
    const waits = [...this.pending.values()].filter((tool) => tool.sessionId === "main" && tool.name === "await_message");

    return waits.length ? [...new Set(waits.map((tool) => this.waitingFor(tool.params.from)))].join("；") : null;
  }

  apply(sessionId: string, event: AgentUiEvent): boolean {
    if (event.kind === "worker_task") {
      if (isLeadSession(sessionId)) return false;

      if (!this.members.has(sessionId)) this.members.set(sessionId, {
        id: sessionId, task: event.task, output: event.output,
        status: "正在准备", delivered: false, ended: false,
      });

      return true;
    }

    const member = this.members.get(sessionId);

    if (event.kind === "tool_start") {
      if (!member && event.name !== "await_message") return false;
      this.pending.set(event.toolCallId, { sessionId, name: event.name, params: event.params });

      if (!member) return event.name === "await_message";

      if (member.ended) return false;
      member.status = event.name === "await_message" ? this.waitingFor(event.params.from) : "正在处理";

      return true;
    }

    if (event.kind === "tool_end") {
      const tool = this.pending.get(event.toolCallId);
      this.pending.delete(event.toolCallId);
      const owner = tool && this.members.get(tool.sessionId);

      if (!tool) return false;

      if (!owner) return tool.name === "await_message";

      if (owner.ended) return false;

      if (event.isError) {
        owner.status = "操作未成功，等待处理";
      } else if (tool.name === "post" && tool.params.to === "main" && tool.params.kind === "done") {
        owner.delivered = true;
        owner.status = `${owner.output}已交给主助手`;
      } else {
        owner.status = owner.delivered ? `${owner.output}已交给主助手` : "正在处理";
      }

      return true;
    }

    if (!member) return false;

    if (event.kind === "agent_start") {
      member.ended = false;
      member.status = member.delivered ? `${member.output}已交给主助手` : "正在处理";
    } else if (event.kind === "error") {
      member.status = "执行失败";
    } else if (event.kind === "agent_end") {
      member.ended = true;

      if (member.delivered) member.status = `${member.output}已交给主助手`;
      else if (member.status !== "执行失败") member.status = "已结束，未收到交付";

      for (const [id, tool] of this.pending) if (tool.sessionId === sessionId) this.pending.delete(id);
    } else return false;

    return true;
  }

  /** 整轮结束不代表每个助手交付成功；保留失败或未交付事实。 */
  finish(): void {
    for (const member of this.members.values()) {
      if (member.ended) continue;
      member.ended = true;

      if (member.delivered) member.status = `${member.output}已交给主助手`;
      else if (member.status !== "执行失败") member.status = "已停止，未收到交付";
    }

    this.pending.clear();
  }
}

export function renderCollaboration(host: HTMLElement, progress: CollaborationProgress): void {
  host.hidden = progress.members.size === 0;
  host.replaceChildren();

  for (const member of progress.members.values()) {
    const row = document.createElement("div");
    row.className = "collaboration-member";
    const avatar = document.createElement("span");
    avatar.className = "collaboration-avatar";
    avatar.setAttribute("aria-hidden", "true");
    const person = personFor(member.id);

    if (person?.kenney) {
      const asset = (file: string) => chrome.runtime.getURL(`cast/${file}`);
      mountKenney(avatar, asset(person.kenney.body), asset(person.kenney.face), 28);
      avatar.querySelector(".kn")?.classList.remove("live");
    } else if (person) {
      // 摘要随状态重绘，静态头像不注册持续动画，避免遗留已移除的实例。
      mountGrok(avatar, person, 28, { animate: false });
    }

    const content = document.createElement("div");
    content.className = "collaboration-content";
    const heading = document.createElement("div");
    heading.className = "collaboration-heading";
    const task = document.createElement("strong");
    task.textContent = member.task;
    const name = document.createElement("span");
    name.textContent = displayNameFor(member.id);
    heading.append(task, name);
    const status = document.createElement("span");
    status.className = "collaboration-status";
    status.textContent = member.status;
    content.append(heading, status);
    row.append(avatar, content);
    host.append(row);
  }

  if (progress.leadWaiting) {
    const waiting = document.createElement("div");
    waiting.className = "collaboration-status";
    waiting.textContent = `主助手：${progress.leadWaiting}`;
    host.append(waiting);
  }
}
