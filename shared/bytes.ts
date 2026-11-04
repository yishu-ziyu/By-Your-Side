const encoder = new TextEncoder();

export const utf8ByteLength = (text: string): number => encoder.encode(text).length;

export const base64Bytes = (base64: string): Uint8Array => Uint8Array.from(atob(base64), char => char.charCodeAt(0));
