import { describe, expect, it } from "vitest";
import { parseClientMessage, parseServerMessage } from "../../shared/protocol.js";

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

  it("returns null for garbage", () => {
    expect(parseServerMessage("nope")).toBeNull();
    expect(parseServerMessage("{}")).toBeNull();
    expect(parseServerMessage("null")).toBeNull();
  });
});
