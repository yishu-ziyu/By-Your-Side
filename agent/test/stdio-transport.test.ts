import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createStdioTransport, encodeFrame, FrameDecoder, MAX_FRAME_BYTES } from "../src/transport/stdio.js";

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

  it("rejects frames over the size cap", () => {
    const decoder = new FrameDecoder();
    const header = Buffer.alloc(4);
    header.writeUInt32LE(MAX_FRAME_BYTES + 1, 0);
    expect(() => decoder.push(header)).toThrow();
  });

  it("encodeFrame refuses oversized messages", () => {
    expect(() => encodeFrame("x".repeat(MAX_FRAME_BYTES + 1))).toThrow();
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
});
