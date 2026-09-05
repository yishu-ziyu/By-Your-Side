import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { consumeAcceptanceCapability } from "../src/acceptance-capability.js";

const dirs: string[] = [];

function capabilityPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "sideagent-acceptance-capability-"));
  dirs.push(dir);
  return join(dir, "capability.json");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("consumeAcceptanceCapability", () => {
  it("默认没有本地能力文件时拒绝普通客户端", () => {
    expect(consumeAcceptanceCapability("a".repeat(64), capabilityPath())).toBe(false);
  });

  it("只消费匹配令牌一次，错误令牌不能改变能力文件", () => {
    const path = capabilityPath();
    const first = "a".repeat(64);
    const second = "b".repeat(64);
    const expiresAt = Date.now() + 60_000;
    writeFileSync(path, JSON.stringify({ expiresAt, tokens: [first, second] }), { mode: 0o600 });

    expect(consumeAcceptanceCapability("c".repeat(64), path)).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ expiresAt, tokens: [first, second] });
    expect(consumeAcceptanceCapability(first, path)).toBe(true);
    expect(consumeAcceptanceCapability(first, path)).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ expiresAt, tokens: [second] });
    expect(consumeAcceptanceCapability(second, path)).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it("过期能力不可用并会被删除", () => {
    const path = capabilityPath();
    const token = "a".repeat(64);
    writeFileSync(path, JSON.stringify({ expiresAt: Date.now() - 1, tokens: [token] }), { mode: 0o600 });

    expect(consumeAcceptanceCapability(token, path)).toBe(false);
    expect(existsSync(path)).toBe(false);
  });
});
