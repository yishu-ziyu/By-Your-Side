import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { checkBoundaries, dependencyViolations } from '../../scripts/maintenance/check-boundaries.mjs';

describe('production dependency boundaries', () => {
  it('keeps the actual production source graph within host boundaries', async () => {
    const result = await checkBoundaries(fileURLToPath(new URL('../../', import.meta.url)));
    expect(result.files).toBeGreaterThan(0);
    expect(result.failures).toEqual([]);
  });
  it.each([
    ['agent/src/task.ts', 'import "/Users/example/ego/extension/src/background/index.ts";'],
    ['agent/src/task.ts', 'import "file:///Users/example/ego/extension/src/background/index.ts";'],
    ['agent/src/task.ts', 'import "C:/repo/extension/src/background/index.ts";'],
    ['shared/contract.ts', 'import { run } from "../agent/src/session.js"; run();'],
    ['shared/ticket.ts', 'export { createHash } from "node:crypto";'],
    ['extension/src/sidepanel/view.ts', 'import("../../../agent/src/session.js");'],
    ['agent/src/task.ts', 'export * from "../../extension/src/relay.js";'],
    ['agent/src/task.ts', 'import "../test/fixture.js";'],
    ['extension/src/sidepanel/view.ts', 'import "../background/state.js";'],
    ['extension/src/shared/state.ts', 'require("../sidepanel/main.js");'],
  ])('rejects wrong runtime direction in %s', async (file, source) => {
    expect(await dependencyViolations(file, source)).toHaveLength(1);
  });
  it('accepts shared contracts, same-host modules and Node inside agent', async () => {
    expect(await dependencyViolations('agent/src/task.ts', 'import "node:crypto"; import "../../shared/voice.js"; import "./session.js";')).toEqual([]);
    expect(await dependencyViolations('extension/src/sidepanel/view.ts', 'import "../relay.js"; import "../../../shared/voice.js";')).toEqual([]);
  });
  it('ignores comments, inert strings and erased type-only references', async () => {
    expect(await dependencyViolations('shared/contract.ts', '// import "node:crypto"\nconst text = `import("../agent/src/main.js")`; export {text};\nimport type { X } from "../agent/src/types.js";')).toEqual([]);
  });
});
