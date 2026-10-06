/**
 * 会话的系统提示词：自定义提示词 + 模式附加段 + 工作目录行。
 * 起初逐字照抄 pi-coding-agent 0.84.4 的 buildSystemPrompt（自定义提示词、无技能、无项目说明文件）。
 * 本机模式退役、升到 Pi 1.0 后只有扩展的循环用它；模型实际收到的内容见 offtopic-reply-diagnostics.test.ts。
 */
export function composeSystemPrompt(customPrompt: string, append: readonly string[], cwd: string): string {
  const appendSystemPrompt = append.join("\n\n");
  const appendSection = append.length > 0 && appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

  return `${customPrompt}${appendSection}\nCurrent working directory: ${cwd.replace(/\\/g, "/")}\n`;
}
