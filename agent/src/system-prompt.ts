/**
 * 会话的系统提示词：自定义提示词 + 模式附加段 + 工作目录行。
 * 与 pi-coding-agent buildSystemPrompt 在「自定义提示词、无技能、无项目说明文件」分支上的结果逐字一致
 * （dist/core/system-prompt.js）；扩展里的循环用它，本机由 AgentSession 自己拼。一致性见 agent/test/system-prompt.test.ts。
 */
export function composeSystemPrompt(customPrompt: string, append: readonly string[], cwd: string): string {
  const appendSystemPrompt = append.join("\n\n");
  const appendSection = append.length > 0 && appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

  return `${customPrompt}${appendSection}\nCurrent working directory: ${cwd.replace(/\\/g, "/")}\n`;
}
