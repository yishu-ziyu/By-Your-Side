// Offline repro: B #18 delay_ready browser_run program ("Unawaited browser calls").
// Read-only: imports workspace product code, modifies nothing. Stub call mirrors real tool payloads.
// SUPERSEDED by repro-b18.test.ts — run that one (`npx vitest run --config docs/tasks/20260910-binding-ab/vitest.repro.config.ts`).
// This .mts is kept only as the drafting record; `tsx` cannot run here (its IPC pipe listen is blocked by the sandbox).
import { runBrowserProgram } from "../../../agent/src/browser-program.js";

const modelCode = `
(async () => {
  // Poll until the button is enabled
  const start = Date.now();
  while (Date.now() - start < 60000) {
    const info = await browser.js({code: \`(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const b = btns.find(x => (x.textContent||'').trim().includes('确认提交'));
      if (!b) return {found:false};
      return {found:true, disabled: !!b.disabled};
    })()\`});
    if (!info.value.found) {
      return {ok:false, reason:'button_not_found'};
    }
    if (!info.value.disabled) break;
    await browser.sleep({ms: 500});
  }
  // Re-check enabled state
  const state = await browser.js({code: \`(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const b = btns.find(x => (x.textContent||'').trim().includes('确认提交'));
    return {found:!!b, disabled: b?!!b.disabled:true};
  })()\`});
  if (!state.value.found || state.value.disabled) {
    return {ok:false, reason:'still_disabled', state: state.value};
  }
  await browser.click({target: 'loc=css:button:not([disabled])'});
  await browser.sleep({ms: 1000});
  const after = await browser.snapshot();
  return {ok:true, clicked:true, snapshot: after.text};
})().catch(e => ({ok:false, error: String(e)}));
`;

async function run(label: string, latencyMs: number) {
  let js = 0;
  const seen: string[] = [];
  const call = async (name: string, params: any) => {
    await new Promise(r => setTimeout(r, latencyMs));
    seen.push(name);
    if (name === "js") { js++; return { value: { found: true, disabled: js < 2 } }; }
    if (name === "click") return { clicked: true };
    if (name === "snapshot") return { text: 'RootWebArea "收件箱"\n  [ref=6] button "确认提交"' };
    throw new Error("unexpected method " + name);
  };
  try {
    const r = await runBrowserProgram({ code: modelCode, call, id: "program-1" });
    console.log(`[${label} latency=${latencyMs}ms] FULFILLED value=${JSON.stringify(r.value)} steps=${r.steps} calls=${seen.join(",")}`);
  } catch (e) {
    console.log(`[${label} latency=${latencyMs}ms] REJECTED: ${(e as Error).message}`);
    console.log(`         dispatched before stop: ${seen.join(",") || "(none)"}`);
  }
}

await run("model call#2 exact", 0);
await run("model call#2 exact", 120);
await run("model call#2 exact", 1200);
