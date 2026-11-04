export function skillResultText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data && typeof data === "object" && !Array.isArray(data) && typeof (data as { text?: unknown }).text === "string") return (data as { text: string }).text;
  if (Array.isArray(data) && data.every(item => typeof item === "string")) return data.join("\n");
  if (data === null || data === undefined) return "没有返回内容";
  if (typeof data !== "object") return String(data);
  const lines = readableLines(data, 0);

  return lines.length ? lines.join("\n") : "没有返回内容";
}

function readableLines(value: object, depth: number): string[] {
  const pad = "  ".repeat(depth);
  const entries: Array<[string | null, unknown]> = Array.isArray(value) ? value.map((item) => [null, item]) : Object.entries(value);

  return entries.flatMap(([key, item]) => {
    const head = key === null ? `${pad}- ` : `${pad}${key}：`;

    if (item && typeof item === "object") return [head.trimEnd(), ...readableLines(item, depth + 1)];

    return [`${head}${item ?? "（空）"}`];
  });
}
