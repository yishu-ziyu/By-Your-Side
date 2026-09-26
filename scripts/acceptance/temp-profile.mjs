/**
 * Temporary Chrome profiles and build folders created by acceptance launchers. Every tracked folder is
 * removed when the caller releases it, and otherwise when the process ends — normal exit, a thrown error,
 * process.exit() or SIGINT/SIGTERM/SIGHUP — after the Chrome using it is killed. Before this, each
 * isolated run left its profile in the temp folder; ~880 of them (11 GB) filled the disk on 2026-09-26.
 */
import { rmSync } from "node:fs";

/** @type {Map<string, import("node:child_process").ChildProcess | undefined>} */
const live = new Map();
let installed = false;

const SIGNAL_CODES = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Kill every tracked Chrome, wait until it has exited, then remove every tracked folder. */
async function releaseAll() {
  await Promise.all([...live.values()].map(child => new Promise(resolve => {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(resolve, 3000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });

    try { child.kill("SIGKILL"); } catch { clearTimeout(timer); resolve(); }
  })));
  await new Promise(resolve => setTimeout(resolve, 200));

  for (const dir of live.keys()) {
    try { remove(dir); } catch { /* reported by the leftover check, not here */ }
  }

  live.clear();
}

function remove(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function install() {
  if (installed) return;
  installed = true;
  // Last resort for process.exit() and thrown errors: kill, give Chrome a moment to stop writing, remove.
  process.on("exit", () => {
    const killed = [...live.values()].filter(child => child?.pid && child.exitCode === null && child.signalCode === null);

    for (const child of killed) {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }

    if (killed.length) sleepSync(300);

    for (const dir of live.keys()) {
      try { remove(dir); } catch { /* best effort while exiting */ }
    }

    live.clear();
  });

  for (const [signal, code] of Object.entries(SIGNAL_CODES)) {
    // Only exit when nobody else handles the signal; a caller's own handler exits and triggers "exit".
    // Clean up asynchronously first: a Ctrl+C also reaches the tsx parent, which SIGKILLs a child whose
    // event loop stays blocked for more than ~30 ms, so the synchronous "exit" path must stay short.
    process.on(signal, () => {
      if (process.listenerCount(signal) === 1) void releaseAll().finally(() => process.exit(128 + code));
    });
  }
}

/**
 * Track a temporary folder until release() (or process end) removes it.
 * @param {string} dir
 * @param {import("node:child_process").ChildProcess} [child] Chrome using the folder; killed first at process end.
 */
export function trackTempDir(dir, child) {
  install();
  live.set(dir, child);

  return {
    setChild(next) { if (live.has(dir)) live.set(dir, next); },
    release() {
      live.delete(dir);
      remove(dir);
    },
  };
}
