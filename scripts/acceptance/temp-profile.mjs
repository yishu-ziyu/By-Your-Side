import { rmSync } from "node:fs";

const live = new Map();
let installed = false;

const SIGNAL_CODES = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

async function releaseAll() {
  await Promise.all([...live.values()].map(child => new Promise(resolve => {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(resolve, 3000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });

    try { child.kill("SIGKILL"); } catch { clearTimeout(timer); resolve(); }
  })));
  await new Promise(resolve => setTimeout(resolve, 200));

  for (const dir of live.keys()) {
    try { remove(dir); } catch {  }
  }

  live.clear();
}

function remove(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function install() {
  if (installed) return;
  installed = true;
  process.on("exit", () => {
    const killed = [...live.values()].filter(child => child?.pid && child.exitCode === null && child.signalCode === null);

    for (const child of killed) {
      try { child.kill("SIGKILL"); } catch {  }
    }

    if (killed.length) sleepSync(300);

    for (const dir of live.keys()) {
      try { remove(dir); } catch {  }
    }

    live.clear();
  });

  for (const [signal, code] of Object.entries(SIGNAL_CODES)) {
    process.on(signal, () => {
      if (process.listenerCount(signal) === 1) void releaseAll().finally(() => process.exit(128 + code));
    });
  }
}

export function trackTempDir(dir, child) {
  install();
  live.set(dir, child);

  return {
    setChild(next) { if (live.has(dir)) live.set(dir, next); },
    release() {
      const current = live.get(dir);
      live.delete(dir);
      try {
        remove(dir);
      } catch {
        live.set(dir, current);
      }
    },
  };
}
