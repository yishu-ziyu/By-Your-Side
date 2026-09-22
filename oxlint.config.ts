import { defineConfig } from "oxlint";

// Lint entry for the sideagent repository.
//
// The `anti-slop` plugin is vendored from https://github.com/dmmulroy/anti-slop
// into `tools/oxlint/anti-slop/` (pinned revision and provenance in that
// directory's VENDOR.md). Upstream intends the rules to be vendored and edited,
// so these rules and severities are project policy, not an upstream contract:
// read `tools/oxlint/anti-slop/src/rules/*.ts` before changing anything, and
// record why a rule is relaxed in `docs/NOTES.md`.
//
// Effect rules are intentionally not registered: this repository does not use
// the Effect library, so that policy group would be dead configuration.

export default defineConfig({
  ignorePatterns: [
    // Local agent tooling directories, not product code.
    ".agents/**",
    ".commandcode/**",
    ".kimi-code/**",
    ".mirasim/**",
    ".omo/**",
    ".pi/**",
    ".playwright-mcp/**",
    ".serena/**",
    ".statamcp/**",
    ".video_agent/**",
    // Vendored third-party ruleset: linted by upstream, not by this repo.
    "tools/oxlint/anti-slop/**",
    // Build output.
    "out/**",
  ],
  jsPlugins: [
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/src/index.ts" },
  ],
  rules: {
    // Native oxlint rule that pairs with no-reduce-accumulator-copy.
    "oxc/no-accumulating-spread": "error",
    // --- anti-slop: array and accumulator handling ---
    "anti-slop/no-array-filter-map": "error",
    "anti-slop/no-reduce-accumulator-copy": "error",
    // --- anti-slop: type evidence ---
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
    // --- anti-slop: boundary handling ---
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": "error",
    // --- anti-slop: naming ---
    "anti-slop/no-shape-in-symbol-names": "error",
    // --- anti-slop: test doubles ---
    "anti-slop/no-module-mocking": "error",
    // --- anti-slop: readability (has an autofix) ---
    "anti-slop/require-readable-spacing": "error",
  },
});
