import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["docs/tasks/20260910-binding-ab/**/*.test.ts"] },
});
