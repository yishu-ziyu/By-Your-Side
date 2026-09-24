// 扩展里的循环自己拼系统提示词；这里用 Pi 真实创建的会话读出它交给模型的提示词，逐字比较。
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { appendPromptForMode, SYSTEM_PROMPT } from "../src/prompt.js";
import { composeSystemPrompt } from "../src/system-prompt.js";

async function piPrompt(mode: "act" | "teach", cwd: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "bys-prompt-"));

  try {
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true }, steeringMode: "all" });

    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir: dir, settingsManager, noExtensions: true, noContextFiles: true,
      systemPromptOverride: () => SYSTEM_PROMPT,
      skillsOverride: () => ({ skills: [], diagnostics: [] }),
      appendSystemPromptOverride: base => appendPromptForMode(mode, base),
    });

    await resourceLoader.reload();
    const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    const { session } = await createAgentSession({ cwd, modelRuntime, noTools: "builtin", resourceLoader, sessionManager: SessionManager.inMemory(cwd), settingsManager });
    const prompt = session.agent.state.systemPrompt;
    session.dispose();

    return prompt;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("系统提示词拼装", () => {
  for (const mode of ["act", "teach"] as const) {
    it(`${mode} 模式与 Pi 会话实际使用的提示词逐字一致`, async () => {
      const cwd = "/tmp/by-your-side";
      expect(composeSystemPrompt(SYSTEM_PROMPT, appendPromptForMode(mode, []), cwd)).toBe(await piPrompt(mode, cwd));
    });
  }
});
