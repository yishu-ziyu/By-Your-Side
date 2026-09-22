import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, resolveConfig, saveConfigModel } from "../src/config.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sideagent-config-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("returns {} when the file does not exist", () => {
    expect(loadConfig(join(dir, "nope.json"))).toEqual({});
  });

  it("returns {} on invalid JSON", () => {
    const p = join(dir, "config.json");
    writeFileSync(p, "{not json");
    expect(loadConfig(p)).toEqual({});
  });

  it("reads model and proxy", () => {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ model: "kimi-coding/kimi-for-coding", proxy: "http://127.0.0.1:7897" }));
    expect(loadConfig(p)).toEqual({ model: "kimi-coding/kimi-for-coding", proxy: "http://127.0.0.1:7897" });
  });

  it("reads both display fast-path switches independently", () => {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ displayFastPath: true, displaySteerFastPath: false }));
    expect(loadConfig(p)).toEqual({ displayFastPath: true, displaySteerFastPath: false });
    writeFileSync(p, JSON.stringify({ displaySteerFastPath: "yes" }));
    expect(loadConfig(p)).toEqual({});
  });

  it("ignores malformed fields", () => {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ model: 42, proxy: "socks5://x", extra: true }));
    expect(loadConfig(p)).toEqual({});
  });

  it("reads routeShadow and routeShadowDailyLimit independently, rejecting out-of-range or wrong-typed limits", () => {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ routeShadow: true, routeShadowDailyLimit: 200 }));
    expect(loadConfig(p)).toEqual({ routeShadow: true, routeShadowDailyLimit: 200 });
    writeFileSync(p, JSON.stringify({ routeShadow: false, routeShadowDailyLimit: 1 }));
    expect(loadConfig(p)).toEqual({ routeShadow: false, routeShadowDailyLimit: 1 });
    writeFileSync(p, JSON.stringify({ routeShadowDailyLimit: 5000 }));
    expect(loadConfig(p)).toEqual({ routeShadowDailyLimit: 5000 });

    for (const bad of [0, 5001, 3.5, -1, "200"]) {
      writeFileSync(p, JSON.stringify({ routeShadowDailyLimit: bad }));
      expect(loadConfig(p)).toEqual({});
    }

    writeFileSync(p, JSON.stringify({ routeShadow: "yes" }));
    expect(loadConfig(p)).toEqual({});
  });
});

it('voiceSpokenResultGate is opt-in and independent of routeShadow', () => {
  const p = join(dir, 'config.json');

  for (const gate of [undefined, false, 'true', 1]) {
    writeFileSync(p, JSON.stringify({routeShadow:true,voiceSpokenResultGate:gate}));
    expect(loadConfig(p).voiceSpokenResultGate === true).toBe(false);
  }

  writeFileSync(p, JSON.stringify({routeShadow:false,voiceSpokenResultGate:true}));
  expect(loadConfig(p)).toMatchObject({routeShadow:false,voiceSpokenResultGate:true});
});

describe("resolveConfig", () => {
  it("CLI wins over config file", () => {
    expect(
      resolveConfig({ model: "a/b" }, { model: "c/d", proxy: "http://127.0.0.1:1" }),
    ).toEqual({ model: "a/b", proxy: "http://127.0.0.1:1" });
  });

  it("falls back to config file then to undefined", () => {
    expect(resolveConfig({}, { model: "c/d" })).toEqual({ model: "c/d" });
    expect(resolveConfig({}, {})).toEqual({});
  });
});

describe("saveConfigModel", () => {
  it("writes model while preserving other fields", () => {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ model: "openai-codex/gpt-5.5", proxy: "http://127.0.0.1:7897", extra: 1 }));
    saveConfigModel("kimi-coding/kimi-for-coding", p);
    expect(loadConfig(p)).toEqual({ model: "kimi-coding/kimi-for-coding", proxy: "http://127.0.0.1:7897" });
    expect(JSON.parse(readFileSync(p, "utf8")).extra).toBe(1);
  });

  it("creates the file from scratch when missing or corrupt", () => {
    const p = join(dir, "config.json");
    saveConfigModel("kimi-coding/k3", p);
    expect(loadConfig(p)).toEqual({ model: "kimi-coding/k3" });
    writeFileSync(p, "{broken");
    saveConfigModel("kimi-coding/k3-256k", p);
    expect(loadConfig(p)).toEqual({ model: "kimi-coding/k3-256k" });
  });
});
