/** 扩展内构建替换 `node:os`：扩展里没有用户目录。 */
export const homedir = (): string => "";

export const tmpdir = (): string => "";
