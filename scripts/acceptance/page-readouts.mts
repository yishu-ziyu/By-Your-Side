/** Page readouts: truncated names and input ranges (docs/evals/20261002-tier1-product-gaps.md, criteria 2–3).
 * Real isolated headless Chrome + the real extension executor built from the current tree into a temp dir;
 * the model-facing fill text comes from the real agent tool definition. No model requests, no daily Chrome,
 * no extension/dist writes. Oracles are independent: the fixture's own title/min/max attributes and the
 * browser's own ValidityState, read straight from the page.
 *
 *   npx tsx scripts/acceptance/page-readouts.mts --headless [--live] [--only=trunc,range,live]
 */
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { IsolatedExtension } from "./isolated-extension.mts";

if (!process.argv.includes("--headless")) throw new Error("Required: --headless");

const live = process.argv.includes("--live");

const selected = new Set((process.argv.find(a => a.startsWith("--only="))?.slice(7) ?? "").split(",").filter(Boolean));

const repo = resolve(import.meta.dirname, "../..");

const out = join(repo, "out/acceptance", `page-readouts-${new Date().toISOString().replace(/[:.]/g, "-")}`);

await mkdir(out, { recursive: true });

const dailyBefore = await readFile(join(repo, "extension/dist/background.js")).catch(() => null);

const buildRoot = await mkdtemp(join(tmpdir(), "bys-readouts-build-"));

const build = spawnSync("node", ["build.mjs"], { cwd: join(repo, "extension"), env: { ...process.env, SIDEAGENT_BUILD_DIST: join(buildRoot, "extension/dist") }, encoding: "utf8" });

await writeFile(join(out, "build.log"), build.stdout + build.stderr);

if (build.status !== 0) throw new Error(`Isolated build failed: ${out}/build.log`);

const previousCwd = process.cwd();

process.chdir(buildRoot);

const { launchIsolatedExtension } = await import("./isolated-extension.mts");

process.chdir(previousCwd);

const { createBrowserTools } = await import("../../agent/src/tools.ts");

// Same shapes as the eval sites: webscraper's product card (visible "…" text, full name in title)
// and httpbin's delivery time field. Plus controls for no-false-positive checks.
const products = `<!doctype html><meta charset=utf-8><title>products</title><body>
<div class=card><h4><a id=p1 href="/product/147" class="title" title="Asus ROG Strix GL702VM-GC146T">
  Asus ROG Strix...
</a></h4><span>$1399</span></div>
<div class=card><h4><a id=p2 href="/product/148" title="Lenovo Legion Y720 Gaming Edition">Lenovo Legion…</a></h4></div>
<p><span id=s1 title="Samsung Galaxy Book Pro 360">Samsung Galaxy...</span></p>
<p><span id=neg title="Opens in a new window">Read more...</span></p>
<p><a id=css href="/product/149" style="display:inline-block;width:70px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">Dell Latitude 5480 Business</a></p>
<p><a id=aria href="/product/150" aria-label="HP 250 G6 Silver">HP 250...</a></p>
</body>`;

const form = `<!doctype html><meta charset=utf-8><title>form</title><body><form>
<p><label>Preferred delivery time: <input type=time min="11:00" max="21:00" step="900" name="delivery"></label></p>
<p><label>Other time: <input type=time name="other" value="12:00"></label></p>
<p><label>Quantity <input type=number name=qty min=1 max=10 step=1></label></p>
<p><label>Day <input type=date name=day min="2026-10-01" max="2026-10-31"></label></p>
<p><label>Volume <input type=range name=vol min=0 max=50 step=5 value=20></label></p>
<p><label>Name <input type=text name=custname></label></p>
</form></body>`;

/** JSON evidence written to result.json. */
type JsonValue = string | number | boolean | null | undefined | readonly JsonValue[] | { readonly [name: string]: JsonValue };

/** Parameters forwarded to the extension's executeToolCall, which validates them against ToolContract. */
type ToolParams = { url?: string; target?: string; value?: string; scope?: "viewport" };

/** The browser's own verdict on the delivery field: the independent oracle for the fill cases. */
type Validity = { value: string; rangeOverflow: boolean; rangeUnderflow: boolean; stepMismatch: boolean };

type Case = { id: string; status: "PASS" | "FAIL" | "NOT_RUN"; evidence?: JsonValue; error?: string };

const cases: Case[] = [];

let iso: IsolatedExtension | undefined;

let tabId = 0;

let panel = "";

let fixtureTarget = "";

let callSequence = 0;

const runId = "page-readouts-run";

const check = (condition: boolean | string | null | undefined, message: string, evidence?: JsonValue) => {
  if (!condition) throw new Error(`${message}${evidence === undefined ? "" : ` :: ${JSON.stringify(evidence).slice(0, 1500)}`}`);
};

// This is auxiliary executor acceptance, not offscreen-agent product acceptance.
// The scripted host supplies task identity; actions run without approval cards.
const callTool = async (name: string, params: ToolParams) => {
  if (live) return iso!.tool(name, params, "main");

  if (!["snapshot", "read_element", "fill", "navigate"].includes(name)) throw new Error(`Unplanned fixture tool: ${name}`);

  if (name === "navigate" && ![`${iso!.fixtureOrigin}/form`, `${iso!.fixtureOrigin}/products`].includes(params.url ?? "")) throw new Error("Navigation outside exact fixture pages refused");

  const exactParams = { ...params, tabId };
  const callId = `page-readouts-${++callSequence}`;

  await iso!.swEval(`globalThis.__readoutResult=null;void globalThis.__saCall(${JSON.stringify(callId)},${JSON.stringify(name)},${JSON.stringify(exactParams)},"main",undefined,"default",{runId:${JSON.stringify(runId)}}).then(result=>globalThis.__readoutResult=result,error=>globalThis.__readoutResult={ok:false,error:String(error)});true`);
  const deadline = Date.now() + 25_000;

  while (Date.now() < deadline) {
    // SAFETY: the local hook stores either its tool_result (optional data/error)
    // or the explicit {ok:false,error:string} rejection above; initial state is null.
    const result = await iso!.swEval("globalThis.__readoutResult") as { ok?: boolean; error?: string; data?: any } | null;

    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  throw new Error(`Fixture tool timed out: ${callId} ${name}`);
};

const tool = async (name: string, params: ToolParams) => {
  const result = await callTool(name, params);

  if (!result?.ok) throw new Error(`${name} failed: ${result?.error ?? "no result"}`);

  return result.data;
};

/** The real agent `fill` tool definition, wired straight to the isolated executor. */
const agentFill = async (target: string, value: string): Promise<string> => {
  const rpc = { call: async (name: string, params: ToolParams) => tool(name, params) };
  // SAFETY: createBrowserTools only calls rpc.call on this path (no execution scope);
  // the optional ToolRpc members are all guarded with `?.`.
  const tools = createBrowserTools(rpc as never);
  const fill = tools.find(t => t.name === "fill")!;
  // SAFETY: fill's schema is {target: string, value: string}; its execute returns the textResult shape.
  const result = await fill.execute("readouts", { target, value } as never, undefined, undefined, undefined as never) as { content: Array<{ text: string }> };

  return result.content.map(c => c.text).join("\n");
};

// SAFETY: swEval uses Runtime.evaluate with returnByValue, so the page hands back a plain JSON value.
const page = async (expression: string): Promise<JsonValue> => iso!.swEval(`(async()=>{const r=await chrome.scripting.executeScript({target:{tabId:${tabId}},world:'MAIN',func:()=>(${expression})});return r[0]?.result;})()`) as Promise<JsonValue>;

const go = async (url: string) => {
  await tool("navigate", { url });
  await page("document.readyState");
};

const lineWith = (text: string, needle: string) => text.split("\n").find(line => line.includes(needle));

/** The link line (not the heading above it) that shows this text. */
const linkWith = (text: string, needle: string) => text.split("\n").find(line => /\blink\b/.test(line) && line.includes(needle));

/** The native time field's own line (its label text has a separate line). */
const timeLine = (text: string) => text.split("\n").find(line => /InputTime|type=time/.test(line));

const refOf = (line: string | undefined) => /\[ref=(\d+)\]/.exec(line ?? "")?.[1];

const run = async (id: string, body: () => Promise<JsonValue>) => {
  if (selected.size && !selected.has(id.split("/")[0]!)) { cases.push({ id, status: "NOT_RUN" });

 return; }

  if (id.startsWith("live/") && !live) { cases.push({ id, status: "NOT_RUN" });

 return; }

  try { const evidence = await body(); cases.push({ id, status: "PASS", evidence }); console.log("PASS", id); }
  catch (error) { cases.push({ id, status: "FAIL", error: String(error) }); console.log("FAIL", id, String(error).slice(0, 400)); }
};

let fatal: string | undefined;

let cleanup: unknown;

try {
  iso = await launchIsolatedExtension({
    localOnly: !live,
    fixture: (req, res) => {
      const body = req.url?.startsWith("/form") ? form : req.url?.startsWith("/products") ? products : null;

      if (!body) return false;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(body);

      return true;
    },
  });

  if (live) {
    tabId = (await tool("open_tab", { url: `${iso.fixtureOrigin}/products` })).tabId;
  } else {
    // Fixture setup, not a model tool: never fake an approved open_tab result.
    fixtureTarget = await iso.newTarget(`${iso.fixtureOrigin}/products`);
    // SAFETY: chrome.tabs.query returns Chrome's numeric id for the exact page
    // created immediately above; a missing tab throws inside the expression.
    tabId = await iso.swEval(`(async()=> (await chrome.tabs.query({url:${JSON.stringify(`${iso.fixtureOrigin}/products`)}}))[0].id)()`) as number;
    const extensionId = await iso.swEval("chrome.runtime.id");
    panel = await iso.newTarget(`chrome-extension://${extensionId}/sidepanel.html`);
    await iso.swEval(`globalThis.__saSetSecurityHost({id:"default",title:"Page readouts fixture",createdAt:1,updatedAt:1,state:"running",mode:"act",runId:${JSON.stringify(runId)}})`);
    const { until } = await import("./isolated-extension.mts");
    await until(async () => {
      // SAFETY: __saSecurityProbe exposes the local hook's numeric panel count
      // and production ConversationSummary records set by __saSetSecurityHost.
      const state = await iso!.swEval("globalThis.__saSecurityProbe()") as { panels?: number; summaries?: Array<{ id: string; runId?: string }> };

      return (state.panels ?? 0) > 0 && state.summaries?.some(summary => summary.id === "default" && summary.runId === runId) ? true : undefined;
    }, 8000, "trusted sidebar attached to fixture task");
  }

  await run("trunc/ax-snapshot", async () => {
    await go(`${iso!.fixtureOrigin}/products`);
    const text: string = (await tool("snapshot", {})).text;
    await writeFile(join(out, "trunc-ax-snapshot.txt"), text);
    const asus = linkWith(text, "Asus ROG Strix...");
    const lenovo = linkWith(text, "Lenovo Legion…");
    const samsung = text.split("\n").filter(line => line.includes("Samsung Galaxy"));
    check(asus?.includes("Asus ROG Strix GL702VM-GC146T"), "truncated link (...) lacks its full title", asus);
    check(lenovo?.includes("Lenovo Legion Y720 Gaming Edition"), "truncated link (…) lacks its full title", lenovo);
    check(samsung.some(line => line.includes("Samsung Galaxy Book Pro 360")), "truncated plain text lacks its full title", samsung);
    check(!text.includes("Opens in a new window"), "unrelated title was presented as the full text", lineWith(text, "Read more"));
    check(lineWith(text, "Dell Latitude 5480 Business"), "CSS-clipped link lost its complete DOM text", text);
    check(lineWith(text, "HP 250 G6 Silver") && !text.includes('full="HP 250 G6 Silver"'), "aria-label name should already be complete, without a duplicate", lineWith(text, "HP 250"));

    return { asus, lenovo, samsung, readMore: lineWith(text, "Read more"), css: lineWith(text, "Dell"), aria: lineWith(text, "HP 250") };
  });

  await run("trunc/viewport-snapshot", async () => {
    const text: string = (await tool("snapshot", { scope: "viewport" })).text;
    await writeFile(join(out, "trunc-viewport-snapshot.txt"), text);
    const asus = linkWith(text, "Asus ROG Strix...");
    check(asus?.includes("Asus ROG Strix GL702VM-GC146T"), "DOM viewport snapshot lacks the full title", asus);
    check(text.split("\n").some(line => line.includes("Samsung Galaxy Book Pro 360")), "DOM viewport snapshot lacks full text of truncated span", text);
    check(!text.includes("Opens in a new window"), "DOM viewport snapshot presented an unrelated title", lineWith(text, "Read more"));

    return { asus, samsung: lineWith(text, "Samsung") };
  });

  await run("trunc/read-element", async () => {
    const asus = await tool("read_element", { target: "#p1" });
    const neg = await tool("read_element", { target: "#neg" });
    check(asus.fullText === "Asus ROG Strix GL702VM-GC146T", "read_element lacks fullText for truncated link", asus);
    check(neg.fullText === undefined, "read_element reported an unrelated title as fullText", neg);

    return { asus: { textContent: asus.textContent, fullText: asus.fullText }, neg: { textContent: neg.textContent, fullText: neg.fullText } };
  });

  await run("range/snapshot", async () => {
    await go(`${iso!.fixtureOrigin}/form`);
    const text: string = (await tool("snapshot", {})).text;
    await writeFile(join(out, "range-ax-snapshot.txt"), text);
    const time = timeLine(text);
    const qty = text.split("\n").find(line => /spinbutton "Quantity/.test(line));
    const day = lineWith(text, '"Day');
    const vol = lineWith(text, '"Volume');
    const name = lineWith(text, '"Name');
    check(time && /type=time/.test(time) && time.includes('min="11:00"') && time.includes('max="21:00"') && time.includes('step="900"'), "time input readout lacks type/min/max/step", time);
    check(qty && qty.includes('min="1"') && qty.includes('max="10"') && qty.includes('step="1"'), "number input readout lacks min/max/step", qty);
    check(day && day.includes('min="2026-10-01"') && day.includes('max="2026-10-31"'), "date input readout lacks min/max", day);
    check(vol && vol.includes('min="0"') && vol.includes('max="50"') && vol.includes('step="5"'), "range input readout lacks min/max/step", vol);
    check(name && !/min=|max=/.test(name), "text input gained range attributes", name);

    return { time, qty, day, vol, name };
  });

  await run("range/viewport-snapshot", async () => {
    const text: string = (await tool("snapshot", { scope: "viewport" })).text;
    const time = timeLine(text);
    check(time && time.includes('min="11:00"') && time.includes('max="21:00"') && time.includes('step="900"'), "DOM viewport snapshot lacks time range", time);

    return { time };
  });

  await run("range/read-element", async () => {
    const data = await tool("read_element", { target: "input[name=delivery]" });
    check(data.inputRange?.type === "time" && data.inputRange.min === "11:00" && data.inputRange.max === "21:00" && data.inputRange.step === "900", "read_element lacks inputRange", data);
    const plain = await tool("read_element", { target: "input[name=custname]" });
    check(plain.inputRange === undefined, "text input got an inputRange", plain);

    return { inputRange: data.inputRange };
  });

  const timeRef = async () => {
    const text: string = (await tool("snapshot", {})).text;
    const ref = refOf(timeLine(text));
    check(ref, "no ref for the delivery field", text);

    return `@${ref}`;
  };

  // SAFETY: the expression below returns exactly the Validity fields, read from the live input.
  const validity = () => page("(()=>{const e=document.querySelector('input[name=delivery]');return {value:e.value,rangeOverflow:e.validity.rangeOverflow,rangeUnderflow:e.validity.rangeUnderflow,stepMismatch:e.validity.stepMismatch}})()") as Promise<Validity>;

  await run("range/fill-invalid-time-format", async () => {
    await go(`${iso!.fixtureOrigin}/form`);

    for (const target of ["input[name=delivery]", await timeRef()]) {
      await tool("fill", { target, value: "19:00" });
      await page("(()=>{window.__timeEvents=[];const e=document.querySelector('input[name=delivery]');for(const type of ['input','change'])e.addEventListener(type,()=>window.__timeEvents.push(type));document.querySelector('input[name=custname]').focus();return true})()");
      const rejected = await callTool("fill", { target, value: "9:30pm" });
      const browser = await page("({value:document.querySelector('input[name=delivery]').value,events:window.__timeEvents,focused:document.activeElement.name})");

      check(rejected?.ok === false && /格式|format|HH:mm/.test(rejected.error ?? ""), "invalid time format did not report refusal", rejected);
      assert.deepEqual(browser, { value: "19:00", events: [], focused: "custname" }, "invalid time changed the value, focus or dispatched input/change");
    }

    return { value: (await validity()).value, events: [] };
  });

  await run("range/fill-native-time-subfields", async () => {
    await go(`${iso!.fixtureOrigin}/form`);
    const fields: string[] = [];
    let snapshotSequence = 0;

    const currentField = async (index: number) => {
      const text: string = (await tool("snapshot", {})).text;
      await writeFile(join(out, snapshotSequence++ === 0 ? "time-native-subfields.txt" : `time-native-subfields-${snapshotSequence}.txt`), text);
      // Filling recreates native UA children. Re-observe the exact first input's
      // Hours/Minutes field before each action; never reuse a disconnected ref.
      const lines = text.split("\n");
      const firstTime = lines.findIndex(line => /InputTime|type=time/.test(line));
      const nextTime = lines.findIndex((line, i) => i > firstTime && /InputTime|type=time/.test(line));
      const role = index === 0 ? /Hours|小时/ : /Minutes|分钟/;
      const field = lines.slice(firstTime + 1, nextTime < 0 ? undefined : nextTime).find(line => /spinbutton/.test(line) && role.test(line));

      check(firstTime >= 0 && field, "current native time subfield AX ref is missing", text);
      fields.push(field!);

      return field!;
    };

    for (const index of [0, 1]) {
      const field = await currentField(index);
      const ref = refOf(field);

      check(ref, "native time child has no executable ref", field);
      await tool("fill", { target: `@${ref}`, value: index === 0 ? "18:15" : "19:30" });
      const browser = await page("({delivery:document.querySelector('input[name=delivery]').value,other:document.querySelector('input[name=other]').value})");

      assert.deepEqual(browser, { delivery: index === 0 ? "18:15" : "19:30", other: "12:00" }, "native child fill did not update only its owning time input");
    }

    const rejected = await callTool("fill", { target: `@${refOf(await currentField(0))}`, value: "9:30pm" });
    check(rejected?.ok === false && /格式|format|HH:mm/.test(rejected.error ?? ""), "native child accepted invalid time format", rejected);
    check((await validity()).value === "19:30", "native child invalid format cleared its owning time input");

    if (!live) {
      await iso!.screenshot(fixtureTarget, join(out, "time-native-subfields.png"));
      await iso!.screenshot(panel, join(out, "time-sidebar.png"));
    }

    return { fields, value: (await validity()).value };
  });

  await run("range/fill-empty-time-and-plain-text", async () => {
    await tool("fill", { target: "input[name=delivery]", value: "" });
    check((await validity()).value === "", "empty time no longer clears the field");
    await tool("fill", { target: "input[name=custname]", value: "9:30pm" });
    const value = await page("document.querySelector('input[name=custname]').value");

    check(value === "9:30pm", "time format guard rejected ordinary text", value);

    return { time: "", text: value };
  });

  await run("range/fill-overflow-ref", async () => {
    const target = await timeRef();
    const data = await tool("fill", { target, value: "21:30" });
    const browser = await validity();
    check(browser.rangeOverflow === true, "oracle: the browser should call 21:30 an overflow", browser);
    check(data.rangeIssue?.problem === "rangeOverflow", "fill reported silent success for 21:30", data);
    check(/21:00/.test(data.rangeIssue.message) && /11:00/.test(data.rangeIssue.message), "message lacks the allowed range", data);
    const text = await agentFill(target, "21:30");
    check(/out of range|outside/i.test(text) && text.includes("11:00") && text.includes("21:00"), "agent fill text hides the range problem", text);
    const after: string = (await tool("snapshot", {})).text;
    const line = timeLine(after);
    check(line?.includes('value="21:30"') && line.includes("invalid=rangeOverflow"), "snapshot after an invalid fill hides the invalid state", line);

    return { data, browser, agentText: text, snapshotLine: line };
  });

  await run("range/fill-underflow-css", async () => {
    const data = await tool("fill", { target: "input[name=delivery]", value: "00:00" });
    const browser = await validity();
    check(browser.rangeUnderflow === true, "oracle: the browser should call 00:00 an underflow", browser);
    check(data.rangeIssue?.problem === "rangeUnderflow" && /11:00/.test(data.rangeIssue.message), "fill (CSS path) reported silent success for 00:00", data);

    return { data, browser };
  });

  await run("range/fill-step", async () => {
    const data = await tool("fill", { target: await timeRef(), value: "11:07" });
    const browser = await validity();
    check(browser.stepMismatch === true, "oracle: the browser should call 11:07 a step mismatch", browser);
    check(data.rangeIssue?.problem === "stepMismatch" && /900/.test(data.rangeIssue.message), "fill reported silent success for 11:07", data);

    return { data, browser };
  });

  await run("range/fill-valid", async () => {
    const data = await tool("fill", { target: await timeRef(), value: "19:00" });
    const browser = await validity();
    check(browser.value === "19:00" && !browser.rangeOverflow && !browser.rangeUnderflow && !browser.stepMismatch, "oracle: 19:00 should be valid", browser);
    check(data.filled === true && data.rangeIssue === undefined, "a valid value was flagged", data);
    const text = await agentFill("input[name=delivery]", "19:00");
    check(!/range|outside/i.test(text), "agent text warned about a valid value", text);

    return { data, agentText: text };
  });

  await run("range/fill-number-overflow", async () => {
    const data = await tool("fill", { target: "input[name=qty]", value: "11" });
    check(data.rangeIssue?.problem === "rangeOverflow" && /10/.test(data.rangeIssue.message), "number overflow not reported", data);

    return { data };
  });

  await run("live/webscraper-last-page", async () => {
    await go("https://webscraper.io/test-sites/e-commerce/static/computers/laptops?page=20");
    const text: string = (await tool("snapshot", {})).text;
    await writeFile(join(out, "live-webscraper-snapshot.txt"), text);
    const line = linkWith(text, "Asus ROG Strix");
    check(line?.includes("Asus ROG Strix GL702VM-GC146T"), "live webscraper link lacks the full model name", line);

    return { line };
  });

  await run("live/httpbin-delivery", async () => {
    await go("https://httpbin.org/forms/post");
    const text: string = (await tool("snapshot", {})).text;
    await writeFile(join(out, "live-httpbin-snapshot.txt"), text);
    const line = timeLine(text);
    check(line?.includes('min="11:00"') && line.includes('max="21:00"') && line.includes('step="900"'), "live httpbin delivery field lacks its range", line);
    const ref = refOf(line);
    // Fill only; never submit the public form.
    const agentText = await agentFill(`@${ref}`, "21:30");
    check(/out of range|outside/i.test(agentText) && agentText.includes("21:00"), "live fill of 21:30 reported silent success", agentText);

    return { line, agentText };
  });
} catch (error) {
  fatal = String(error);
} finally {
  cleanup = iso ? await iso.close() : { status: "NOT_STARTED" };
  const dailyAfter = await readFile(join(repo, "extension/dist/background.js")).catch(() => null);
  const executed = cases.filter(c => c.status !== "NOT_RUN");
  const dailyDistUnchanged = String(dailyBefore) === String(dailyAfter);
  // SAFETY: cleanup is either IsolatedExtension.close()'s {status} or the NOT_STARTED sentinel.
  const cleanStatus = (cleanup as { status?: string }).status;
  const ok = !fatal && executed.length > 0 && executed.every(c => c.status === "PASS") && cleanStatus === "PASS" && dailyDistUnchanged;
  const result = { ok, runKind: selected.size ? "filtered" : live ? "full+live" : "full", cases, cleanup, dailyDistUnchanged, modelRequests: 0 };

  if (fatal) Object.assign(result, { fatal });
  await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ out, pass: executed.filter(c => c.status === "PASS").length, fail: executed.filter(c => c.status === "FAIL").length, notRun: cases.length - executed.length, fatal, dailyDistUnchanged }));
  process.exitCode = ok ? 0 : 1;
}
