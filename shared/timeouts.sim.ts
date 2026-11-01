import { strict as assert } from "node:assert";
import { test } from "node:test";
import { programDeadlineExpired } from "./timeouts.js";

test("程序期限到达时停止确认，没期限时不受影响", () => {
  assert.deepEqual([59_999, 60_000, 60_001].map(now => programDeadlineExpired(60_000, now) ? "stop" : "wait"), ["wait", "stop", "stop"]);
  assert.equal(programDeadlineExpired(undefined, 60_001), false);
});
