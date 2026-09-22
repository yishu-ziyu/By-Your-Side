#!/usr/bin/env npx tsx
/**
 * U02: delivery into extension → visible in real panel, p95 ≤300ms, 100 samples.
 * C01: takeover button → write gate closed, p95 ≤100ms, 100 samples.
 * Isolated headless CFT, real SW + chrome-extension panel. No daily Chrome.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchIsolatedExtension, sleep, until } from "../acceptance/isolated-extension.mts";
import { REPO_ROOT } from "./lib/verify.js";

if (!process.argv.includes("--headless=new") && !process.argv.includes("--headless")) {
  console.error("native-latency 只允许无头：请加 --headless=new");
  process.exit(2);
}

function p95(values: number[]): number {
  const ordered = [...values].sort((a, b) => a - b);

  return ordered[Math.ceil(ordered.length * 0.95) - 1]!;
}

const iso = await launchIsolatedExtension();

const report: Record<string, unknown> = { ok: false, u02: null, c01: null };

try {
  const extId = await iso.swEval("chrome.runtime.id") as string;
  const panelId = await iso.newTarget(`chrome-extension://${extId}/sidepanel.html`);
  await until(async () => (await iso.evalIn(panelId, "Boolean(document.querySelector('#input') && document.querySelector('#takeover-btn'))").catch(() => false)) || undefined, 20_000, "面板 DOM");
  await sleep(400);
  const panelCid = await iso.evalIn(panelId, `document.querySelector('#conversation-switcher')?.textContent ?? ''`) as string;
  const swSelected = await iso.swEval(`globalThis.__saGate ? {gate: globalThis.__saGate(), hasDeliver: typeof globalThis.__saDeliverUser === 'function', hasServer: typeof globalThis.__saHandleServer === 'function', hasTakeover: typeof globalThis.__saTakeover === 'function'} : {gate:null}`) as Record<string, unknown>;
  report.probe = { extId, panelCid, swSelected };

  const u02: number[] = [];

  for (let i = 0; i < 100; i++) {
    const text = `交付可见-${i}-${Date.now()}`;
    const t0 = Date.now();

    const sent = await iso.swEval(`globalThis.__saDeliverUser ? globalThis.__saDeliverUser(${JSON.stringify({
      conversationId: "default",
      id: `d-${i}`,
      runId: `run-${i}`,
      kind: "finding",
      text,
      composedAt: Date.now(),
      status: "composed",
    })}) : globalThis.__saHandleServer(${JSON.stringify({
      type: "agent_event",
      conversationId: "default",
      event: { kind: "user_delivery", delivery: { conversationId: "default", id: `d-${i}`, runId: `run-${i}`, kind: "finding", text, composedAt: Date.now(), status: "composed" } },
    })})`);

    if (!sent) throw new Error("SW 无法投递 user_delivery");
    await until(async () => {
      const visible = await iso.evalIn(panelId, `document.body.innerText.includes(${JSON.stringify(text)})`);

      return visible || undefined;
    }, 5_000, `交付 ${i} 可见`);
    u02.push(Date.now() - t0);
  }

  report.u02 = { n: u02.length, p95: p95(u02), max: Math.max(...u02), min: Math.min(...u02), target: 300, ok: u02.length === 100 && p95(u02) <= 300 };

  await iso.swEval(`globalThis.__saHandleServer && globalThis.__saHandleServer(${JSON.stringify({ type: "status", conversationId: "default", state: "running" })})`);
  await sleep(100);
  await iso.evalIn(panelId, `document.querySelector('#takeover-btn') && (document.querySelector('#takeover-btn').hidden = false)`);

  const c01: number[] = [];

  for (let i = 0; i < 100; i++) {
    await iso.swEval(`(globalThis.__saResetControl || globalThis.__saAbortGate)(); globalThis.__saHandleServer && globalThis.__saHandleServer(${JSON.stringify({ type: "status", conversationId: "default", state: "running" })})`);
    const t0 = Date.now();
    await iso.evalIn(panelId, `document.querySelector('#takeover-btn').click()`);
    await until(async () => {
      const gate = await iso.swEval(`globalThis.__saGate ? globalThis.__saGate() : null`) as { user?: boolean; draining?: boolean } | null;

      return (gate && (gate.user || gate.draining)) || undefined;
    }, 3_000, `闸门 ${i}`);
    c01.push(Date.now() - t0);
  }

  report.c01 = { n: c01.length, p95: p95(c01), max: Math.max(...c01), min: Math.min(...c01), target: 100, ok: c01.length === 100 && p95(c01) <= 100 };

  const u02ok = (report.u02 as { ok: boolean }).ok;
  const c01ok = (report.c01 as { ok: boolean }).ok;
  report.ok = u02ok && c01ok;
} catch (error) {
  report.error = String(error);
} finally {
  await iso.close();
}

const outDir = join(REPO_ROOT, "eval", "runs");

await mkdir(outDir, { recursive: true });

const path = join(outDir, `native-latency-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

await writeFile(path, JSON.stringify({ ...report, path }, null, 2));

console.log(JSON.stringify({ path, ok: report.ok, u02: report.u02, c01: report.c01, probe: report.probe, error: report.error }, null, 2));

process.exit(report.ok ? 0 : 1);
