import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Reuse the existing local TypeSafe credential; never put it in prompts or browser state. */
export function readTypeSafeKey(): string {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  try {
    return readFileSync(join(homedir(), ".sideagent", "typesafe.env"), "utf8").split("\n")
      .find(line => line.startsWith("TYPESAFE_API_KEY="))?.slice("TYPESAFE_API_KEY=".length).trim().replace(/^["']|["']$/g, "") ?? "";
  } catch { return ""; }
}
