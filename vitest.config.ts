import { defineConfig } from "vitest/config";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Test sessions must never rotate the user's normal-use diagnostic history.
process.env.SIDEAGENT_TRACE_DIR ||= join(tmpdir(), `bys-vitest-traces-${process.pid}`);
// Same isolation for shadow-routing logs: never touch the real ~/.sideagent/route-shadow directory.
process.env.SIDEAGENT_ROUTE_SHADOW_DIR ||= join(tmpdir(), `bys-vitest-route-shadow-${process.pid}`);

export default defineConfig({
  test: {
    include: ["agent/test/**/*.test.ts", "extension/test/**/*.test.ts"],
    environment: "node",
  },
});
