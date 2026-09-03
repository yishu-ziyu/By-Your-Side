import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, resolveConfig } from "../src/config.js";

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

  it("ignores malformed fields", () => {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ model: 42, proxy: "socks5://x", extra: true }));
    expect(loadConfig(p)).toEqual({});
  });
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
