/** 字节层面的小工具：Node 与浏览器（扩展 offscreen 文档）通用，不依赖 Buffer。 */

const encoder = new TextEncoder();

/** 字符串按 UTF-8 编码后的字节数（与 Buffer.byteLength(text) 相同）。 */
export const utf8ByteLength = (text: string): number => encoder.encode(text).length;

/** 严格解码 base64；非法输入会抛错（调用方的输入都已先过校验）。 */
export const base64Bytes = (base64: string): Uint8Array => Uint8Array.from(atob(base64), char => char.charCodeAt(0));
