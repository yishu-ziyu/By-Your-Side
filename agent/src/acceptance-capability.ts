import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./config.js";

export const ACCEPTANCE_CAPABILITY_PATH = join(dataDir(), "acceptance-team-capability.json");

export function consumeAcceptanceCapability(token: string, path = ACCEPTANCE_CAPABILITY_PATH): boolean {
  if (!token) return false;

  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { expiresAt?: unknown; tokens?: unknown };

    if (typeof raw.expiresAt !== "number" || raw.expiresAt < Date.now() || !Array.isArray(raw.tokens)) {
      try {
        unlinkSync(path);
      } catch {
        /* 已不存在 */
      }

      return false;
    }

    const tokens = raw.tokens.filter((item): item is string => typeof item === "string");
    const index = tokens.indexOf(token);

    if (index < 0) return false;
    tokens.splice(index, 1);

    if (tokens.length === 0) unlinkSync(path);
    else writeFileSync(path, `${JSON.stringify({ expiresAt: raw.expiresAt, tokens })}\n`, { mode: 0o600 });

    return true;
  } catch {
    return false;
  }
}
