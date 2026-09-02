import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["agent/test/**/*.test.ts", "extension/test/**/*.test.ts"],
    environment: "node",
  },
});
