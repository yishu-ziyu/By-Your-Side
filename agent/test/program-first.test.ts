import { describe, expect, it, vi } from "vitest";
import { runBrowserProgram } from "../src/browser-program.js";
import { PROGRAM_FIRST_GUIDANCE, programFirstGuidance } from "../src/program-first.js";

describe("program-first host boundary", () => {
  it("does not silently enable an execution-policy experiment that failed its paired gate", () => {
    const previous = process.env.SIDEAGENT_PROGRAM_FIRST;

    try {
      delete process.env.SIDEAGENT_PROGRAM_FIRST; expect(programFirstGuidance()).toBe("");
      process.env.SIDEAGENT_PROGRAM_FIRST = "1"; expect(programFirstGuidance()).toBe(PROGRAM_FIRST_GUIDANCE);
      process.env.SIDEAGENT_PROGRAM_FIRST = "0"; expect(programFirstGuidance()).toBe("");
    } finally {
      if (previous === undefined) delete process.env.SIDEAGENT_PROGRAM_FIRST; else process.env.SIDEAGENT_PROGRAM_FIRST = previous;
    }
  });
  it.each(["stale ref", "outcome unknown", "page changed", "permission denied"])("a caught %s cannot authorize another write", async message => {
    const call = vi.fn(async () => { throw new Error(message); });
    await expect(runBrowserProgram({ code: 'try { await browser.click({target:"@1"}); } catch {} await browser.fill({target:"@2",value:"must-not-write"}); return {done:true};', call })).rejects.toThrow(message);
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("already queued writes stop too", async () => {
    const call = vi.fn(async () => { throw new Error("outcome unknown"); });
    await expect(runBrowserProgram({ code: 'await Promise.all([browser.click({target:"@1"}),browser.fill({target:"@2",value:"must-not-write"})]).catch(()=>{});', call })).rejects.toThrow();
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("requires user-outcome verification rather than treating a returned program as success", () => { expect(PROGRAM_FIRST_GUIDANCE).toContain("not success"); expect(PROGRAM_FIRST_GUIDANCE).toContain("read_element expect"); });
  it("labels only host-generated polling as read-only, never user-authored JavaScript", async () => {
    const origins: Array<string | undefined> = [];
    await runBrowserProgram({ code: 'await browser.waitFor({selector:"#ready"}); await browser.js({code:"arbitrary()"});',
      call: async (name, _params, _id, origin) => {
        origins.push(origin);

        // waitFor 走宿主的 read_element expect 轮询；其它调用按原样返回。
        return name === "read_element" ? { check: { matched: true } } : { value: { ready: true } };
      } });
    // 契约：宿主轮询一律 readonly-poll（且不止一次采样）；用户编写的页面 JS 永不标成 read-only。
    expect(origins.at(-1)).toBeUndefined();
    expect(origins.length).toBeGreaterThan(1);
    expect(origins.slice(0, -1).every(origin => origin === "readonly-poll")).toBe(true);
  });
});

describe("ten deterministic multi-step execution fixtures (not a model benchmark)", () => {
  it.each(Array.from({ length: 10 }, (_, i) => i + 1))("fixture %i preserves actions and proof in one program", async fixture => {
    const calls: string[] = [];
    let value = "", submitted = false;

    const result = await runBrowserProgram({ id: `fixture-${fixture}`, code: `await browser.fill({target:"@1",value:${JSON.stringify(`material-${fixture}`)}}); await browser.click({target:"@2"}); const proof=await browser.read_element({target:"@3",expect:{property:"textContent",contains:${JSON.stringify(`material-${fixture}`)}}}); if(!proof.check.matched)throw new Error("unverified"); return {verified:true};`,
      call: async (name, params) => {
        calls.push(name);

        if (name === "fill") { value = String(params.value);

 return { filled: true }; }

        if (name === "click") { submitted = true;

 return { clicked: true }; }

        if (!submitted || value !== `material-${fixture}`) throw new Error("not complete");

        return { check: { matched: true }, textContent: value };
      },
    });

    expect(result.value).toEqual({ verified: true }); expect(calls).toEqual(["fill", "click", "read_element"]); expect(result.steps).toBe(3);
  });
});
