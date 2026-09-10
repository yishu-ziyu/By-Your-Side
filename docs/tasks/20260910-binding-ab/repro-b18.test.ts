// Offline repro for B #18 delay_ready ("Unawaited browser calls"). Read-only: imports product code, edits nothing.
import { describe, expect, it } from "vitest";
import { runBrowserProgram } from "../../../agent/src/browser-program.js";

const modelStatement = `(async () => {
  const info = await browser.js({code: "1"});
  if (!info.value.found) return {ok:false, reason:'button_not_found'};
  await browser.sleep({ms: 100});
  const after = await browser.snapshot();
  return {ok:true, snapshot: after.text};
})().catch(e => ({ok:false, error: String(e)}));`;

const properBody = `const info = await browser.js({code: "1"});
if (!info.value.found) return {ok:false, reason:'button_not_found'};
await browser.sleep({ms: 100});
const after = await browser.snapshot();
return {ok:true, snapshot: after.text};`;

function stub(seen: string[]) {
  return async (name: string) => {
    seen.push(name);
    if (name === "js") return { value: { found: true, disabled: false } };
    if (name === "snapshot") return { text: 'RootWebArea "收件箱"' };
    throw new Error("unexpected method " + name);
  };
}

describe("repro B#18 unawaited guard", () => {
  it("rejects the model's IIFE-statement shape", async () => {
    const seen: string[] = [];
    await expect(runBrowserProgram({ code: modelStatement, call: stub(seen), id: "p" }))
      .rejects.toThrow(/Unawaited browser calls/);
    console.log("[repro] model statement dispatched:", seen.join(",") || "(none)");
  });

  it("accepts the same logic written as a program body", async () => {
    const seen: string[] = [];
    const r = await runBrowserProgram({ code: properBody, call: stub(seen), id: "p" });
    console.log("[repro] body variant value:", JSON.stringify(r.value), "dispatched:", seen.join(","));
    expect(r.value).toMatchObject({ ok: true });
  });
});
