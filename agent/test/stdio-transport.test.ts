import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createStdioTransport, encodeFrame, FrameDecoder, MAX_INPUT_FRAME_BYTES, MAX_OUTPUT_FRAME_BYTES } from "../src/transport/stdio.js";

/** 手工拼输入帧（encodeFrame 有 1MiB 输出上限，大输入帧需直接构造）。 */
const inputFrame = (body: string): Buffer => {
  const payload = Buffer.from(body, "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(payload.byteLength, 0);
  return Buffer.concat([header, payload]);
};

describe("encodeFrame / FrameDecoder", () => {
  it("roundtrips a single frame", () => {
    const decoder = new FrameDecoder();
    expect(decoder.push(encodeFrame('{"type":"hello"}'))).toEqual(['{"type":"hello"}']);
  });

  it("handles frames split across chunks", () => {
    const frame = encodeFrame('{"type":"abort"}');
    const decoder = new FrameDecoder();
    expect(decoder.push(frame.subarray(0, 3))).toEqual([]);
    expect(decoder.push(frame.subarray(3, 6))).toEqual([]);
    expect(decoder.push(frame.subarray(6))).toEqual(['{"type":"abort"}']);
  });

  it("decodes multiple frames in one chunk", () => {
    const decoder = new FrameDecoder();
    const buf = Buffer.concat([encodeFrame("a"), encodeFrame('{"x":1}'), encodeFrame("ccc")]);
    expect(decoder.push(buf)).toEqual(["a", '{"x":1}', "ccc"]);
  });

  it("handles utf8 multibyte content", () => {
    const decoder = new FrameDecoder();
    const text = JSON.stringify({ text: "你好，浏览器" });
    expect(decoder.push(encodeFrame(text))).toEqual([text]);
  });

  it("rejects input frames over the 64MiB cap with direction and limit, no content", () => {
    const decoder = new FrameDecoder();
    const header = Buffer.alloc(4);
    header.writeUInt32LE(MAX_INPUT_FRAME_BYTES + 1, 0);
    expect(() => decoder.push(header)).toThrow(/输入帧过大：\d+ 字节，上限 67108864 字节/);
  });

  it("accepts chunked input frames between 1MiB and 64MiB, then small frames still work", () => {
    const decoder = new FrameDecoder();
    const big = JSON.stringify({ type: "snapshot", data: "图".repeat(700_000) }); // ~2.1MiB UTF-8
    const frame = inputFrame(big);
    expect(frame.byteLength).toBeGreaterThan(MAX_OUTPUT_FRAME_BYTES);
    const results: string[] = [];
    for (let at = 0; at < frame.byteLength; at += 65_537) results.push(...decoder.push(frame.subarray(at, at + 65_537)));
    expect(results).toEqual([big]);
    expect(decoder.push(encodeFrame('{"type":"hello"}'))).toEqual(['{"type":"hello"}']);
  });

  it("encodeFrame refuses oversized output with direction and limit, no content", () => {
    expect(() => encodeFrame("x".repeat(MAX_OUTPUT_FRAME_BYTES + 1))).toThrow(/输出帧过大：\d+ 字节，上限 1048576 字节/);
    expect(() => encodeFrame("x".repeat(MAX_OUTPUT_FRAME_BYTES + 1))).toThrow(/^(?!.*secret).*$/);
  });
});

describe("createStdioTransport", () => {
  it("writes length-prefixed frames to stdout only", () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = createStdioTransport(input, output);
    const chunks: Buffer[] = [];
    output.on("data", (c: Buffer) => chunks.push(c));

    transport.send('{"type":"hello_ok","version":1}');
    const buf = Buffer.concat(chunks);
    expect(buf.readUInt32LE(0)).toBe(buf.byteLength - 4);
    expect(buf.subarray(4).toString("utf8")).toBe('{"type":"hello_ok","version":1}');
  });

  it("delivers inbound messages and fires onClose exactly once", () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = createStdioTransport(input, output);
    const received: string[] = [];
    let closes = 0;
    transport.onMessage((m) => received.push(m));
    transport.onClose(() => {
      closes += 1;
    });

    input.write(encodeFrame('{"type":"hello"}'));
    input.write(encodeFrame('{"type":"abort"}'));
    expect(received).toEqual(['{"type":"hello"}', '{"type":"abort"}']);

    input.end();
    input.emit("close");
    expect(closes).toBe(1);
  });

  it("delivers a >1MiB screenshot-sized inbound frame through the transport", () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = createStdioTransport(input, output);
    const received: string[] = [];
    transport.onMessage((m) => received.push(m));
    const big = JSON.stringify({ type: "snapshot", data: "屏".repeat(600_000) });
    input.write(inputFrame(big));
    input.write(encodeFrame('{"type":"after"}'));
    expect(received).toEqual([big, '{"type":"after"}']);
  });

  it("rejects an oversized inbound header safely: no content in diagnostics, stream closed", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const transport = createStdioTransport(input, output);
    const received: string[] = [];
    let closes = 0;
    transport.onMessage((m) => received.push(m));
    transport.onClose(() => { closes += 1; });
    try {
      const header = Buffer.allocUnsafe(4);
      header.writeUInt32LE(MAX_INPUT_FRAME_BYTES + 1, 0);
      input.write(header);
      input.write(Buffer.from("SECRET_FRAME_BODY_NEVER_READ"));
      await new Promise(r => setImmediate(r));
      expect(received).toEqual([]);
      expect(closes).toBe(1);
      const log = spy.mock.calls.map(c => String(c[0])).join("\n");
      expect(log).toContain("输入帧过大");
      expect(log).toContain(String(MAX_INPUT_FRAME_BYTES));
      expect(log).not.toContain("SECRET_FRAME_BODY_NEVER_READ");
    } finally {
      spy.mockRestore();
    }
  });
});
