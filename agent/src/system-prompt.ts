export function composeSystemPrompt(customPrompt: string, append: readonly string[], cwd: string): string {
  const appendSystemPrompt = append.join("\n\n");
  const appendSection = append.length > 0 && appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

  return `${customPrompt}${appendSection}\nCurrent working directory: ${cwd.replace(/\\/g, "/")}\n`;
}
