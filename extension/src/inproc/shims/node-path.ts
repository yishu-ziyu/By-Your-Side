/** 扩展内构建替换 `node:path`：只做 POSIX 风格的字符串拼接，任务核心只用它拼存储路径与取文件名。 */
export const sep = "/";

export const join = (...parts: string[]): string => parts.filter(Boolean).join("/").replace(/\/{2,}/g, "/");

export const dirname = (path: string): string => path.replace(/\/[^/]*$/, "") || "/";

export const basename = (path: string, ext?: string): string => {
  const base = path.replace(/\/+$/, "").split("/").pop() ?? "";

  return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
};

export const extname = (path: string): string => /(\.[^./]+)$/.exec(basename(path))?.[1] ?? "";

export const isAbsolute = (path: string): boolean => path.startsWith("/");
