/** 扩展内构建替换 `node:crypto`：语音会话只用到 randomUUID。 */
export const randomUUID = () => crypto.randomUUID();

export const randomBytes = (size: number) => crypto.getRandomValues(new Uint8Array(size));
