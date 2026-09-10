import { describe, expect, it } from "vitest";
import {
  LEAD_SESSION_ID,
  TOOL_NAMES,
  isLeadSession,
  parseClientMessage,
  parseServerMessage,
} from "../../shared/protocol.js";

describe("parseClientMessage", () => {
  it("parses a valid hello frame", () => {
    const raw = JSON.stringify({ type: "hello", token: "abc", client: "sidepanel" });
    expect(parseClientMessage(raw)).toEqual({ type: "hello", token: "abc", client: "sidepanel" });
  });

  it("parses a valid tool_result frame", () => {
    const raw = JSON.stringify({ type: "tool_result", id: "1", ok: true, data: { tabs: [] } });
    expect(parseClientMessage(raw)).toEqual({ type: "tool_result", id: "1", ok: true, data: { tabs: [] } });
  });

  it("returns null for invalid JSON", () => {
    expect(parseClientMessage("{not json")).toBeNull();
    expect(parseClientMessage("")).toBeNull();
  });

  it("parses a valid set_mode frame", () => {
    expect(parseClientMessage(JSON.stringify({ type: "set_mode", mode: "teach" }))).toEqual({
      type: "set_mode",
      mode: "teach",
    });
    expect(parseClientMessage(JSON.stringify({ type: "set_mode", mode: "act" }))).toEqual({
      type: "set_mode",
      mode: "act",
    });
  });

  it("rejects set_mode frames with an invalid mode", () => {
    expect(parseClientMessage(JSON.stringify({ type: "set_mode" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "set_mode", mode: "TEACH" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "set_mode", mode: 1 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "set_mode", mode: null }))).toBeNull();
  });

  it("parses a valid set_model frame", () => {
    expect(parseClientMessage(JSON.stringify({ type: "set_model", model: "kimi-coding/kimi-for-coding" }))).toEqual({
      type: "set_model",
      model: "kimi-coding/kimi-for-coding",
    });
  });

  it("rejects set_model frames with a missing or empty model", () => {
    expect(parseClientMessage(JSON.stringify({ type: "set_model" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "set_model", model: "" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "set_model", model: 42 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "set_model", model: null }))).toBeNull();
  });

  it("parses a valid page_event frame", () => {
    expect(parseClientMessage(JSON.stringify({ type: "page_event", event: "url_changed", url: "https://a.b/c" }))).toEqual({
      type: "page_event",
      event: "url_changed",
      url: "https://a.b/c",
    });
  });

  it("parses page_event with optional sessionId", () => {
    expect(
      parseClientMessage(
        JSON.stringify({ type: "page_event", event: "url_changed", url: "https://a.b", sessionId: "wiki" }),
      ),
    ).toEqual({ type: "page_event", event: "url_changed", url: "https://a.b", sessionId: "wiki" });
  });

  it("rejects page_event with empty sessionId", () => {
    expect(
      parseClientMessage(
        JSON.stringify({ type: "page_event", event: "url_changed", url: "https://a.b", sessionId: "" }),
      ),
    ).toBeNull();
  });

  it("rejects malformed page_event frames", () => {
    expect(parseClientMessage(JSON.stringify({ type: "page_event" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "page_event", event: "dom_changed", url: "https://a.b" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "page_event", event: "url_changed" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "page_event", event: "url_changed", url: 42 }))).toBeNull();
  });

  it("parses a valid user_message frame with page context", () => {
    const raw = JSON.stringify({
      type: "user_message",
      text: "这页面是关于什么内容的？",
      context: { tabId: 12, title: "历史正在发生的地方", url: "https://zhuanlan.zhihu.com/p/1" },
    });
    expect(parseClientMessage(raw)).toEqual({
      type: "user_message",
      text: "这页面是关于什么内容的？",
      context: { tabId: 12, title: "历史正在发生的地方", url: "https://zhuanlan.zhihu.com/p/1" },
    });
  });

  it("parses user_message with selected text", () => {
    const raw = JSON.stringify({
      type: "user_message",
      text: "这是什么",
      context: {
        tabId: 3,
        title: "MiroFish",
        url: "https://en.wikipedia.org/wiki/MiroFish",
        selection: { text: "MiroFish is a made-up term." },
      },
    });
    expect(parseClientMessage(raw)).toEqual({
      type: "user_message",
      text: "这是什么",
      context: {
        tabId: 3,
        title: "MiroFish",
        url: "https://en.wikipedia.org/wiki/MiroFish",
        selection: { text: "MiroFish is a made-up term." },
      },
    });
  });

  it("rejects user_message whose selection is empty or too long", () => {
    const ctx = { tabId: 1, title: "t", url: "https://a.b" };
    expect(
      parseClientMessage(JSON.stringify({ type: "user_message", text: "hi", context: { ...ctx, selection: { text: "" } } })),
    ).toBeNull();
    expect(
      parseClientMessage(
        JSON.stringify({ type: "user_message", text: "hi", context: { ...ctx, selection: { text: "x".repeat(2001) } } }),
      ),
    ).toBeNull();
  });

  it("accepts user_message without context (backward compatible)", () => {
    expect(parseClientMessage(JSON.stringify({ type: "user_message", text: "hi" }))).toEqual({
      type: "user_message",
      text: "hi",
    });
  });

  it("parses a valid user_message with image attachments", () => {
    const raw = JSON.stringify({
      type: "user_message",
      text: "look at this",
      attachments: [
        {
          id: "att_1",
          type: "image",
          name: "screenshot.png",
          dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          mimeType: "image/png",
        },
      ],
    });
    expect(parseClientMessage(raw)).toEqual({
      type: "user_message",
      text: "look at this",
      attachments: [
        {
          id: "att_1",
          type: "image",
          name: "screenshot.png",
          dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          mimeType: "image/png",
        },
      ],
    });
  });

  it("rejects user_message with invalid attachments", () => {
    expect(
      parseClientMessage(JSON.stringify({ type: "user_message", text: "hi", attachments: "not-array" })),
    ).toBeNull();
    expect(
      parseClientMessage(
        JSON.stringify({
          type: "user_message",
          text: "hi",
          attachments: [{ id: "1", type: "other", name: "bad.txt" }],
        }),
      ),
    ).toBeNull();
    expect(
      parseClientMessage(
        JSON.stringify({
          type: "user_message",
          text: "hi",
          attachments: [{ id: "1", type: "image", name: "x.png", dataBase64: "", mimeType: "image/png" }],
        }),
      ),
    ).toBeNull();
  });


  it("parses a valid steer frame with page context", () => {
    const raw = JSON.stringify({
      type: "steer",
      text: "先点登录",
      context: { tabId: 7, title: "Locked", url: "https://example.com/a" },
    });
    expect(parseClientMessage(raw)).toEqual({
      type: "steer",
      text: "先点登录",
      context: { tabId: 7, title: "Locked", url: "https://example.com/a" },
    });
  });

  it("accepts steer without context (backward compatible)", () => {
    expect(parseClientMessage(JSON.stringify({ type: "steer", text: "停一下" }))).toEqual({
      type: "steer",
      text: "停一下",
    });
  });

  it("rejects steer with malformed context", () => {
    expect(
      parseClientMessage(JSON.stringify({ type: "steer", text: "hi", context: { tabId: "7", title: "t", url: "u" } })),
    ).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "steer", text: "hi", context: { tabId: 7, title: "t" } }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "steer", text: "hi", context: null }))).toBeNull();
  });

  it("parses takeover and handback", () => {
    expect(parseClientMessage(JSON.stringify({ type: "takeover", requestId: "take-1" }))).toEqual({
      type: "takeover",
      requestId: "take-1",
    });
    expect(parseClientMessage(JSON.stringify({ type: "abort" }))).toEqual({ type: "abort" });
    const frozen = {
      type: "takeover",
      requestId: "take-team",
      groupId: "team-abc",
      generation: 3,
      members: [
        { sessionId: "main", role: "lead", activity: "waiting_tool", tabId: 11, title: "Lead real page", url: "https://example.com/lead" },
        { sessionId: "wiki", role: "worker", activity: "waiting_message", tabId: 21, title: "Wiki real page", url: "https://example.com/wiki" },
      ],
    };
    expect(parseClientMessage(JSON.stringify(frozen))).toEqual(frozen);
    expect(
      parseClientMessage(
        JSON.stringify({ type: "takeover", requestId: "take-team", groupId: "g", generation: 1, members: [] }),
      ),
    ).toBeNull();
    expect(
      parseClientMessage(
        JSON.stringify({
          ...frozen,
          members: [{ sessionId: "main", role: "lead", activity: "waiting_message", title: 42, url: "https://example.com" }],
        }),
      ),
    ).toBeNull();
    expect(
      parseClientMessage(
        JSON.stringify({
          type: "handback",
          requestId: "back-snap",
          members: [{ sessionId: "wiki", snapshotFailed: true, reason: "页面还在，但没读到新状态，未续跑" }],
        }),
      ),
    ).toMatchObject({
      type: "handback",
      members: [{ sessionId: "wiki", snapshotFailed: true }],
    });
    expect(parseClientMessage(JSON.stringify({ type: "takeover", requestId: "take-1" }))).not.toEqual(
      parseClientMessage(JSON.stringify({ type: "abort" })),
    );
    expect(
      parseClientMessage(
        JSON.stringify({
          type: "handback",
          requestId: "back-1",
          context: { tabId: 9, title: "flomo", url: "https://v.flomoapp.com/mine" },
          snapshot: "heading 笔记",
        }),
      ),
    ).toEqual({
      type: "handback",
      requestId: "back-1",
      context: { tabId: 9, title: "flomo", url: "https://v.flomoapp.com/mine" },
      snapshot: "heading 笔记",
    });
  });

  it("parses team handback members without requiring a single shared snapshot", () => {
    const raw = {
      type: "handback",
      requestId: "back-team",
      members: [
        {
          sessionId: "main",
          context: { tabId: 11, title: "Lead now", url: "http://127.0.0.1/lead" },
          snapshot: "lead-fresh",
          capturedAt: 10,
        },
        {
          sessionId: "wiki",
          context: { tabId: 21, title: "Wiki now", url: "http://127.0.0.1/wiki" },
          snapshot: "wiki-fresh",
          capturedAt: 11,
        },
      ],
    };
    expect(parseClientMessage(JSON.stringify(raw))).toEqual(raw);
    expect(
      parseClientMessage(
        JSON.stringify({
          type: "handback",
          requestId: "back-closed",
          members: [
            {
              sessionId: "main",
              context: { tabId: 11, title: "Lead", url: "http://127.0.0.1/lead" },
              snapshot: "lead-fresh",
              capturedAt: 12,
            },
            { sessionId: "wiki", closed: true, reason: "绑定页已关闭，未续跑" },
          ],
        }),
      ),
    ).toMatchObject({
      type: "handback",
      members: [{ sessionId: "main" }, { sessionId: "wiki", closed: true }],
    });
  });

  it("rejects control messages without a usable request id, context, or snapshot", () => {
    expect(parseClientMessage(JSON.stringify({ type: "takeover" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "takeover", requestId: "" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "handback" }))).toBeNull();
    expect(
      parseClientMessage(
        JSON.stringify({
          type: "handback",
          requestId: "back-team",
          members: [{ sessionId: "wiki", snapshot: "x" }],
        }),
      ),
    ).toBeNull();
    expect(
      parseClientMessage(
        JSON.stringify({
          type: "handback",
          requestId: "back-1",
          context: { tabId: "9", title: "t", url: "u" },
          snapshot: "page",
        }),
      ),
    ).toBeNull();
    expect(
      parseClientMessage(
        JSON.stringify({
          type: "handback",
          requestId: "back-1",
          context: { tabId: 9, title: "t", url: "u" },
          snapshot: 12,
        }),
      ),
    ).toBeNull();
  });

  it("验收装配消息只接受明确的 worker session 与 tab", () => {
    expect(
      parseClientMessage(
        JSON.stringify({
          type: "acceptance_prepare_team",
          requestId: "accept-team-1",
          capability: "a".repeat(64),
          worker: { sessionId: "wiki", tabId: 21 },
          tasks: {
            lead: { taskId: "lead-task", expectedSnapshotMarker: "lead-marker" },
            worker: { taskId: "worker-task", expectedSnapshotMarker: "worker-marker" },
          },
        }),
      ),
    ).toEqual({
      type: "acceptance_prepare_team",
      requestId: "accept-team-1",
      capability: "a".repeat(64),
      worker: { sessionId: "wiki", tabId: 21 },
      tasks: {
        lead: { taskId: "lead-task", expectedSnapshotMarker: "lead-marker" },
        worker: { taskId: "worker-task", expectedSnapshotMarker: "worker-marker" },
      },
    });
    expect(
      parseClientMessage(
        JSON.stringify({ type: "acceptance_prepare_team", requestId: "accept-team-1", worker: { sessionId: "", tabId: 21 } }),
      ),
    ).toBeNull();
    expect(
      parseClientMessage(
        JSON.stringify({
          type: "acceptance_prepare_team",
          requestId: "accept-team-1",
          worker: { sessionId: "wiki", tabId: 21 },
          tasks: {
            lead: { taskId: "lead-task", expectedSnapshotMarker: "lead-marker" },
            worker: { taskId: "worker-task", expectedSnapshotMarker: "worker-marker" },
          },
        }),
      ),
    ).toBeNull();
  });

  it("returns null for JSON without a string type field", () => {
    expect(parseClientMessage("{}")).toBeNull();
    expect(parseClientMessage('{"type":1}')).toBeNull();
    expect(parseClientMessage("null")).toBeNull();
    expect(parseClientMessage("123")).toBeNull();
    expect(parseClientMessage('"hello"')).toBeNull();
    expect(parseClientMessage("[]")).toBeNull();
  });
});

describe("parseServerMessage", () => {
  it("parses a valid status frame", () => {
    const raw = JSON.stringify({ type: "status", state: "running" });
    expect(parseServerMessage(raw)).toEqual({ type: "status", state: "running" });
  });

  it("parses status user as distinct from idle and running", () => {
    expect(parseServerMessage(JSON.stringify({ type: "status", state: "user" }))).toEqual({
      type: "status",
      state: "user",
    });
    const user = parseServerMessage(JSON.stringify({ type: "status", state: "user" }));
    const idle = parseServerMessage(JSON.stringify({ type: "status", state: "idle" }));
    const running = parseServerMessage(JSON.stringify({ type: "status", state: "running" }));
    expect(user?.type === "status" && user.state).toBe("user");
    expect(idle?.type === "status" && idle.state).toBe("idle");
    expect(running?.type === "status" && running.state).toBe("running");
    expect(user).not.toEqual(idle);
    expect(user).not.toEqual(running);
  });

  it("rejects unknown status states (teach/paused 不得冒充旁观)", () => {
    expect(parseServerMessage(JSON.stringify({ type: "status", state: "paused" }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: "status", state: "teach" }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: "status", state: "held" }))).toBeNull();
  });

  it("parses control_result and rejects malformed acknowledgements", () => {
    expect(
      parseServerMessage(
        JSON.stringify({
          type: "control_result",
          requestId: "back-1",
          action: "handback",
          ok: true,
          state: "running",
        }),
      ),
    ).toEqual({
      type: "control_result",
      requestId: "back-1",
      action: "handback",
      ok: true,
      state: "running",
    });
    expect(
      parseServerMessage(
        JSON.stringify({ type: "control_result", requestId: "", action: "takeover", ok: true, state: "user" }),
      ),
    ).toBeNull();
    expect(
      parseServerMessage(
        JSON.stringify({ type: "control_result", requestId: "x", action: "abort", ok: true, state: "idle" }),
      ),
    ).toBeNull();
    expect(
      parseServerMessage(
        JSON.stringify({ type: "control_result", requestId: "x", action: "handback", ok: "yes", state: "running" }),
      ),
    ).toBeNull();
  });

  it("returns null for garbage", () => {
    expect(parseServerMessage("nope")).toBeNull();
    expect(parseServerMessage("{}")).toBeNull();
    expect(parseServerMessage("null")).toBeNull();
  });

  it("parses tool_call / agent_event / status with sessionId", () => {
    expect(
      parseServerMessage(JSON.stringify({ type: "status", state: "running", sessionId: "wiki" })),
    ).toEqual({ type: "status", state: "running", sessionId: "wiki" });
    expect(
      parseServerMessage(
        JSON.stringify({ type: "tool_call", id: "1", name: "click", params: {}, sessionId: "wiki" }),
      ),
    ).toMatchObject({ type: "tool_call", sessionId: "wiki" });
    expect(
      parseServerMessage(
        JSON.stringify({ type: "agent_event", event: { kind: "agent_end" }, sessionId: "wiki" }),
      ),
    ).toMatchObject({ type: "agent_event", sessionId: "wiki" });
  });

  it("read_element 是协议内只读工具并保留 conversation/session 路由", () => {
    expect(TOOL_NAMES).toContain("read_element");
    expect(
      parseServerMessage(JSON.stringify({
        type: "tool_call",
        id: "read-1",
        name: "read_element",
        params: { tabId: 12, target: "#field" },
        conversationId: "conversation-A",
        sessionId: "writer",
      })),
    ).toMatchObject({ type: "tool_call", name: "read_element", conversationId: "conversation-A", sessionId: "writer" });
  });

  it("rejects empty sessionId on server frames", () => {
    expect(parseServerMessage(JSON.stringify({ type: "status", state: "idle", sessionId: "" }))).toBeNull();
  });

  it("omitted sessionId still parses (Lead 路径)", () => {
    expect(parseServerMessage(JSON.stringify({ type: "status", state: "idle" }))).toEqual({
      type: "status",
      state: "idle",
    });
  });

  it("parses team_status and rejects malformed team frames", () => {
    const team = {
      groupId: "g1",
      generation: 3,
      phase: "partial",
      capturedAt: 10,
      members: [
        {
          sessionId: "main",
          role: "lead",
          phase: "restored",
          tabId: 11,
          title: "Lead",
          url: "http://127.0.0.1/lead",
        },
        {
          sessionId: "wiki",
          role: "worker",
          phase: "paused_tab_closed",
          reason: "绑定页已关闭，未续跑",
        },
      ],
    };
    expect(parseServerMessage(JSON.stringify({ type: "team_status", team }))).toEqual({
      type: "team_status",
      team,
    });
    expect(parseServerMessage(JSON.stringify({ type: "team_status" }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: "team_status", team: { phase: "user" } }))).toBeNull();
  });

  it("parses control_result with team members on partial handback", () => {
    const msg = parseServerMessage(
      JSON.stringify({
        type: "control_result",
        requestId: "back-team",
        action: "handback",
        ok: true,
        state: "running",
        team: {
          groupId: "g1",
          generation: 4,
          phase: "partial",
          capturedAt: 11,
          members: [
            { sessionId: "main", role: "lead", phase: "restored", tabId: 11 },
            { sessionId: "wiki", role: "worker", phase: "paused_tab_closed", reason: "绑定页已关闭，未续跑" },
          ],
        },
      }),
    );
    expect(msg).toMatchObject({
      type: "control_result",
      action: "handback",
      ok: true,
      team: { phase: "partial" },
    });
    if (msg?.type === "control_result" && msg.team) {
      expect(msg.team.members.some((m) => m.phase === "paused_tab_closed")).toBe(true);
      expect(msg.team.phase).not.toBe("restored");
    }
  });

  it("parses acceptance_team_ready and rejects malformed readiness", () => {
    expect(
      parseServerMessage(
        JSON.stringify({
          type: "acceptance_team_ready",
          requestId: "accept-team-1",
          ok: true,
          members: ["main", "wiki"],
          continuity: [
            {
              sessionId: "main",
              instanceId: "instance-main",
              taskId: "lead-task",
              step: "before",
              active: true,
              expectedSnapshotMarker: "lead-marker",
            },
          ],
        }),
      ),
    ).toEqual({
      type: "acceptance_team_ready",
      requestId: "accept-team-1",
      ok: true,
      members: ["main", "wiki"],
      continuity: [
        {
          sessionId: "main",
          instanceId: "instance-main",
          taskId: "lead-task",
          step: "before",
          active: true,
          expectedSnapshotMarker: "lead-marker",
        },
      ],
    });
    expect(
      parseServerMessage(
        JSON.stringify({ type: "acceptance_team_ready", requestId: "accept-team-1", ok: true, members: [""] }),
      ),
    ).toBeNull();
  });
});

describe("session id helpers", () => {
  it("Lead 为空、main 或省略", () => {
    expect(isLeadSession(undefined)).toBe(true);
    expect(isLeadSession(LEAD_SESSION_ID)).toBe(true);
    expect(isLeadSession("wiki")).toBe(false);
  });
});

describe("conversation envelope", () => {
  it("accepts a stable conversation id and legacy omission", () => {
    expect(parseClientMessage(JSON.stringify({ type: "abort", conversationId: "conversation-a" }))).toMatchObject({ conversationId: "conversation-a" });
    expect(parseClientMessage(JSON.stringify({ type: "abort" }))).toEqual({ type: "abort" });
    expect(parseServerMessage(JSON.stringify({ type: "status", state: "running", conversationId: "conversation-a" }))).toMatchObject({ conversationId: "conversation-a" });
  });
  it("rejects wrong, empty, path-like and overlong ids in both directions", () => {
    for (const conversationId of [null, 8, {}, "", "../escape", "a".repeat(65)]) {
      expect(parseClientMessage(JSON.stringify({ type: "abort", conversationId }))).toBeNull();
      expect(parseServerMessage(JSON.stringify({ type: "status", state: "idle", conversationId }))).toBeNull();
    }
  });
  it("validates creation and server summaries", () => {
    expect(parseClientMessage(JSON.stringify({ type: "conversation_create", requestId: "request-a", title: "A" }))).not.toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "conversation_create", requestId: 4 }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: "conversation_list", conversations: [{ id: 4 }] }))).toBeNull();
  });
});

it('validates source-side plan receipts including unexecuted steps',()=>{
 const plan={id:'plan1',conversationId:'A',updatedAt:1,steps:[{action:'pause',text:'暂停B',targetId:'B',targetTitle:'阅读',status:'unexecuted'}]};
 const message={type:'agent_event',conversationId:'A',event:{kind:'notice',message:'语音计划',plan}};
 expect(parseServerMessage(JSON.stringify(message))).not.toBeNull();
 expect(parseServerMessage(JSON.stringify({...message,conversationId:'B'}))).toBeNull();
 expect(parseServerMessage(JSON.stringify({...message,event:{...message.event,plan:{...plan,steps:[{...plan.steps[0],status:'success-guessed'}]}}}))).toBeNull();
});
