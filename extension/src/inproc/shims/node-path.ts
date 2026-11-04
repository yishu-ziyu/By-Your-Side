export const sep = "/";

export const join = (...parts: string[]): string => parts.filter(Boolean).join("/").replace(/\/{2,}/g, "/");

export const dirname = (path: string): string => path.replace(/\/[^/]*$/, "") || "/";

export const basename = (path: string, ext?: string): string => {
  const base = path.replace(/\/+$/, "").split("/").pop() ?? "";

  return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
};

export const extname = (path: string): string => /(\.[^./]+)$/.exec(basename(path))?.[1] ?? "";

export const isAbsolute = (path: string): boolean => path.startsWith("/");
