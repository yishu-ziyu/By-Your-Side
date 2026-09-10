/**
 * native messaging stdio 传输：Chrome 通过 4 字节小端长度前缀 + UTF-8 JSON 与 host 通信。
 * 本模块是伴随进程一侧的实现；纪律：stdout 只能写协议帧，日志一律走 stderr。
 */
import type { Readable, Writable } from "node:stream";

/** host→Chrome 输出帧上限 1MiB（Chrome 协议限制）；Chrome→host 输入帧上限 64MiB。两个方向分别有界，不无限缓冲。 */
export const MAX_OUTPUT_FRAME_BYTES = 1024 * 1024;
export const MAX_INPUT_FRAME_BYTES = 64 * 1024 * 1024;

export function encodeFrame(message: string): Buffer {
  const body = Buffer.from(message, "utf8");
  if (body.byteLength > MAX_OUTPUT_FRAME_BYTES) throw new Error(`输出帧过大：${body.byteLength} 字节，上限 ${MAX_OUTPUT_FRAME_BYTES} 字节`);
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.byteLength, 0);
  return Buffer.concat([header, body]);
}

/** 增量解码器：push 任意切块的字节流，返回完整帧（可能多帧或零帧）。 */
export class FrameDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): string[] {
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    const frames: string[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > MAX_INPUT_FRAME_BYTES) throw new Error(`输入帧过大：${length} 字节，上限 ${MAX_INPUT_FRAME_BYTES} 字节`);
      if (this.buffer.length < 4 + length) break;
      frames.push(this.buffer.subarray(4, 4 + length).toString("utf8"));
      this.buffer = this.buffer.subarray(4 + length);
    }
    return frames;
  }
}

export interface StdioTransport {
  send(message: string): void;
  /** 收到一条完整消息。 */
  onMessage(cb: (message: string) => void): void;
  /** stdin 关闭（Chrome 端断开/退出）。 */
  onClose(cb: () => void): void;
}

/** 把进程 stdin/stdout 接成 native messaging 通道。 */
export function createStdioTransport(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): StdioTransport {
  let messageCb: ((message: string) => void) | null = null;
  let closeCb: (() => void) | null = null;
  let closed = false;
  const fireClose = (): void => {
    if (closed) return;
    closed = true;
    closeCb?.();
  };
  const decoder = new FrameDecoder();

  input.on("data", (chunk: Buffer) => {
    let frames: string[];
    try {
      frames = decoder.push(chunk);
    } catch (error) {
      // 拒绝诊断只含方向/字节数/限制，不含帧原文。
      console.error(`[stdio] 拒绝输入帧：${error instanceof Error ? error.message : String(error)}`);
      input.destroy();
      return;
    }
    for (const frame of frames) messageCb?.(frame);
  });
  input.on("end", fireClose);
  input.on("close", fireClose);

  return {
    send(message) {
      output.write(encodeFrame(message));
    },
    onMessage(cb) {
      messageCb = cb;
    },
    onClose(cb) {
      closeCb = cb;
    },
  };
}
