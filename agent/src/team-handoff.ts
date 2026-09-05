import type { ClientMessage } from "../../shared/protocol.js";
import type { ActiveMemberInput } from "../../shared/control.js";

export function frozenMembersFromTakeover(
  msg: Extract<ClientMessage, { type: "takeover" }>,
): ActiveMemberInput[] {
  if (!msg.members || msg.members.length === 0) return [];
  return msg.members.map((member) => ({
    sessionId: member.sessionId,
    role: member.role,
    activity: member.activity ?? "running",
    tabId: member.tabId,
    title: member.title,
    url: member.url,
  }));
}
