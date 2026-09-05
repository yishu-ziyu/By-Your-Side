import { describe, expect, it } from "vitest";
import { frozenMembersFromTakeover } from "../src/team-handoff.js";

describe("frozenMembersFromTakeover", () => {
  it("端到端保留 activity 与真实绑定页元数据", () => {
    expect(
      frozenMembersFromTakeover({
        type: "takeover",
        requestId: "take-1",
        groupId: "group-1",
        generation: 3,
        members: [
          {
            sessionId: "wiki",
            role: "worker",
            activity: "waiting_message",
            tabId: 21,
            title: "Wiki real page",
            url: "https://example.com/wiki",
          },
        ],
      }),
    ).toEqual([
      {
        sessionId: "wiki",
        role: "worker",
        activity: "waiting_message",
        tabId: 21,
        title: "Wiki real page",
        url: "https://example.com/wiki",
      },
    ]);
  });
});
