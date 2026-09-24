// 扩展里用纯 JS 的 sha256 替换 node:crypto 的 createHash；这里与 Node 的实现逐个对拍。
import { createHash as nodeCreateHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createHash } from "../src/inproc/shims/node-crypto.js";

const lengths = [0, 1, 3, 31, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 70_000];

describe("扩展里的 sha256 替身", () => {
  it("各种长度（含分块边界）的字符串与 Node 一致", () => {
    for (const length of lengths) {
      const text = "中文🙂abc".repeat(Math.ceil(length / 7)).slice(0, length);
      expect(createHash("sha256").update(text).digest("hex")).toBe(nodeCreateHash("sha256").update(text).digest("hex"));
    }
  });

  it("多次 update 与字节输入与 Node 一致", () => {
    const bytes = Uint8Array.from({ length: 300 }, (_, i) => (i * 37) % 256);
    const ours = createHash("sha256").update("image/png").update("\0").update(bytes).digest("hex");
    const node = nodeCreateHash("sha256").update("image/png").update("\0").update(bytes).digest("hex");
    expect(ours).toBe(node);
  });

  it("不支持的算法与编码直接报错", () => {
    expect(() => createHash("md5")).toThrow();
    // SAFETY: 故意传入不支持的编码，验证会报错而不是给出错误结果。
    expect(() => createHash("sha256").update("x").digest("base64" as "hex")).toThrow();
  });
});
