/**
 * 授权参数 hash 与请求指纹共用的规范化序列化。
 * 这是既有落盘格式：对象键按 localeCompare 排序、忽略 undefined 值：
 * 数组保持原顺序，非对象值交给 JSON.stringify。已有旧记录按此格式计算，
 * 改动输出会让旧授权 hash 与已落盘请求指纹全部失效，不要顺手替换成 RFC 规范或 JSON.stringify 默认行为。
 */
export function canonicalValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalValue(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
