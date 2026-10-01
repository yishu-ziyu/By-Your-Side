import { defineConfig } from "vitest/config";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Test sessions must never rotate the user's normal-use diagnostic history.
process.env.SIDEAGENT_TRACE_DIR ||= join(tmpdir(), `bys-vitest-traces-${process.pid}`);

export default defineConfig({
  // 扩展构建把 pi-ai 指到 dist 目录（extension/build.mjs），设备码登录模块只能这样取到；测试里同样解析，才能加载扩展的模型运行时。
  resolve: { alias: [{ find: /^@earendil-works\/pi-ai\/auth\/(.*)$/, replacement: fileURLToPath(new URL("./node_modules/@earendil-works/pi-ai/dist/auth/$1.js", import.meta.url)) }] },
  test: {
    include: ["agent/test/**/*.test.ts", "extension/test/**/*.test.ts"],
    environment: "node",
  },
});
