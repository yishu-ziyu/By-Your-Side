import { describe, expect, it } from "vitest";
import { withTimeout } from "../src/background/timeout.js";

describe("snapshot timeout", () => {
  it("正常快照在截止时间前原样返回", async () => {
    await expect(withTimeout(Promise.resolve({ text: "fresh" }), 50, "timeout")).resolves.toEqual({ text: "fresh" });
  });

  it("调试通道不回调时按时失败，不让交还永久挂住", async () => {
    await expect(withTimeout(new Promise<never>(() => {}), 5, "snapshot timed out")).rejects.toThrow(
      "snapshot timed out",
    );
  });
});
