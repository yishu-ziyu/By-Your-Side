/** 技能结果优先呈现可读正文；没有正文的数组和对象保留完整结构。 */
export function skillResultText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data && typeof data === "object" && !Array.isArray(data) && typeof (data as { text?: unknown }).text === "string") return (data as { text: string }).text;
  if (Array.isArray(data) && data.every(item => typeof item === "string")) return data.join("\n");
  try { return JSON.stringify(data, null, 2) ?? "没有返回内容"; } catch { return "返回内容无法显示"; }
}
