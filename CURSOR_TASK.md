# Task: swap By-Your-Side's agent loop from pi-agent-core to pi-durable

## Goal

By-Your-Side is a Chrome MV3 extension; the assistant loop runs in the extension's offscreen document (`extension/src/inproc`, loop in `agent/src/pi-agent-loop.ts`, built on `@earendil-works/pi-agent-core`'s `Agent`). Replace that loop with `@earendil-works/pi-durable`'s `Harness` so that every turn, tool call, steer and follow-up is stored before it is shown, and a task interrupted by an extension reload or browser kill continues from where it stopped after reopen (`harness.resume()`), without repeating finished tool calls.

Everything the user sees must keep working: side panel streaming, tool cards, goal check, memory, separate asks (`agent/src/task-queue.ts`, `task-dispatcher.ts`), interjection judging, takeover/confirm-send holds, receipts replay after reopening the side panel.

The result will be compared against `main` on quality, speed and recovery (see "Acceptance"). It is an experiment branch: correctness and an honest report matter more than finishing everything.

## Return

1. Commits on branch `feat/pi-durable-core` in this worktree only (`/Users/mahaoxuan/Desktop/AI-products/bys-pi-durable-core`). Do not push.
2. A file `PI_DURABLE_REPORT.md` at the worktree root: what was replaced, what is not done or behaves differently, every check you ran with pass / fail / not run, and the known risks.

## Do not

- Do not write unit or integration tests. Verification is only real end-to-end cases under `scripts/acceptance/real-path/` (real extension in isolated headless Chrome).
- Do not touch the main checkout `/Users/mahaoxuan/Desktop/AI-products/By-Your-Side`, `extension/dist`, or the user's everyday Chrome. Never run `npm run build` (it writes the everyday extension); case scripts build into temp dirs themselves.
- Do not read, print or copy credential files (`~/.sideagent/providers.local.json`, `~/.pi/agent/auth.json`, `*.key`). Do not use real models; the scripted model is enough for the cases.
- Do not merge, push, or change git config. Do not delete other worktrees.
- Do not kill processes you did not start. Run at most 2 headless case runs at once; if `uptime` 1-minute load > 20, wait.

--

## Background and pointers

- Read `AGENTS.md` (project rules, Chinese) and `docs/testing/acceptance.md` first. Comments follow AGENTS.md "文档" rules: only non-obvious "why", no dates or history.
- pi-durable 1.0.4 is installed: `node_modules/@earendil-works/pi-durable/README.md` (Persist and Resume, Tools, Busy Conversations, Storage, Abort and Subagents). It is marked experimental.
- A working proof is in `experiments/pi-durable/` (already in this branch):
  - `opfs-fs.ts`: the `FileSystem` subset `JsonlStorage` needs, on OPFS. It passed pi-durable's own `createStorageConformance` 23/23 inside the offscreen document. Reuse it for storage.
  - `page.ts`: a Harness in the offscreen document with an OpenAI-compatible provider via `createProvider` + `openAICompletionsApi()`.
  - `run.mts`: e2e that interrupts mid-task (extension reload, or SIGKILL + same profile) and checks resume; `EXP_SCENARIO=midtool` shows replay behavior.
- Tool shapes differ: pi-agent-core `execute(toolCallId, params, signal, onUpdate)` vs pi-durable `execute(args, api, context)`. Tools live in `agent/src/tools.ts`, `realtime-browser-tool-defs.ts`, `realtime-browser-tools.ts`, `artifacts-tool.ts`.
- Replay rule (user decision): read-only tools (snapshot, screenshot, read_element(s), scroll, hover, tab listing, network/fetch reads) are `replay: "safe"`. Tools that change a page or produce side effects (click, double_click, fill, type_text, press_key, select_option, upload_file, download_url, accept/dismiss_dialog, navigate, js, browser_run, mark, guide_step, artifacts writes) stay not replay-safe: after an interruption the model gets the interrupted result, and the next turn must re-read the page before acting. Never auto-repeat them.
- The product already has a checkpoint/resume path (`agent/src/conversation-manager.ts` `resumeInterruptedTask`, `task-progress.ts`, `pi-session-persistence.ts`). Decide what pi-durable replaces and what stays; write the reasoning in the report.
- Model providers: the product resolves providers itself (`agent/src/` provider/model code, `pi-ai` providers). Keep using the same provider resolution; plug it into the Harness through `createModels()`/`setProvider`.

## Acceptance (you run the first three; the user's agent runs the comparison)

1. `npm run typecheck` passes after merging latest `origin/main` into the branch.
2. `npm test` (core real-path cases, scripted model) passes, or every failure is listed in the report with cause. Before changing anything, run it once on the untouched branch and record the baseline, so pre-existing failures are not blamed on the swap.
3. New case `scripts/acceptance/real-path/restart-resume.mts`: in the real side panel, a task calls a page-changing tool on a local practice page (e.g. clicks a submit button that the page counts), the extension reloads after the tool result is stored and before the model's next reply, and after reopen the task finishes without the user typing "继续", the submit count stays 1, and the side panel shows the finished answer. Break the product on purpose once (e.g. wipe storage before reopen) and confirm the case fails; say so in the report.
4. Comparison (not yours to run, but do not break it): `npm run lab -- eval guardrail` (24 real-site tasks: pass rate, time, tokens), `npm run lab -- eval duplex` (interjections), and `npm test` on `main` vs this branch.

Self-check before handing back (each one has broken past PRs here): reopen the side panel and replay from receipts; two windows with side panels open; the assistant waiting on the user (confirm send, takeover); reduced motion and dark mode; HTML written by the model into an answer; merge latest main then `npm run typecheck`.
