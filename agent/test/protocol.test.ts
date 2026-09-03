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

  it("rejects malformed page_event frames", () => {
    expect(parseClientMessage(JSON.stringify({ type: "page_event" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "page_event", event: "dom_changed", url: "https://a.b" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "page_event", event: "url_changed" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "page_event", event: "url_changed", url: 42 }))).toBeNull();
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
