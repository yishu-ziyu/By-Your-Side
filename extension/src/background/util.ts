/** 把任意异常压成一行人类可读的文本。 */
export function oneLine(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const line = raw.replace(/\s+/g, " ").trim();
  return (line || "未知错误").slice(0, 300);
}
