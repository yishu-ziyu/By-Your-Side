/** REV-02/03: real isolated Chrome, real extension executor, independent pixels
 * and page events. Faults affect replies only, never synthesize page success.
 * No model requests, daily reload, user profile, or clipboard operations. */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { IsolatedExtension } from "./isolated-extension.mts";
import type { ToolExecutionFact } from "../../shared/protocol.js";

if (!process.argv.includes("--headless")) throw new Error("Required: --headless");

const repo = resolve(import.meta.dirname, "../..");

const selected = new Set((process.argv.find(a => a.startsWith("--only="))?.slice(7) ?? "").split(",").filter(Boolean));

const out = join(repo, "out/acceptance", `browser-review-${new Date().toISOString().replace(/[:.]/g, "-")}`);

await mkdir(out, { recursive: true });

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

const sources = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: repo, encoding: "utf8" }).split("\0").filter(path => /^(agent\/src\/|extension\/src\/|shared\/)|(^|\/)(package(-lock)?\.json|build\.mjs)$/.test(path) || path === "scripts/acceptance/browser-review-regressions.mts").sort();

async function fileHash(path: string): Promise<string | null> {
  try { return hash(await readFile(path)); }
  catch (error) {
    // SAFETY: fs/promises readFile rejects with a Node system error whose `code` field
    // names the errno; "ENOENT" is the documented absent-path case, which this helper
    // reports as a missing hash instead of a failure.
    const code = (error as NodeJS.ErrnoException).code;

    if (code === "ENOENT") return null;

    throw error;
  }
}

const snapshotHashes = async () => Object.fromEntries(await Promise.all(sources.map(async path => [path, await fileHash(join(repo, path))])));

const sourceHashes = await snapshotHashes();

const daily = join(repo, "extension/dist/background.js");

const dailyBefore = await fileHash(daily);

const buildRoot = await mkdtemp(join(tmpdir(), "bys-review-build-"));

const buildDir = join(buildRoot, "extension/dist");

const build = spawnSync("node", ["build.mjs"], { cwd: join(repo, "extension"), env: { ...process.env, SIDEAGENT_BUILD_DIST: buildDir }, encoding: "utf8" });

await writeFile(join(out, "build.log"), build.stdout + build.stderr);

if (build.status !== 0) throw new Error(`Isolated build failed: ${out}`);

const previousCwd = process.cwd();

process.chdir(buildRoot);

const { launchIsolatedExtension } = await import("./isolated-extension.mts");

process.chdir(previousCwd);

const html = `<!doctype html><meta charset=utf-8><title>Review pixels and delivery</title>
<style>html,body{margin:0;background:white}body{width:800px;height:3300px}.mark{position:absolute;width:100px;height:100px}#red{left:40px;top:120px;background:rgb(255,102,102)}#blue{left:200px;top:160px;background:rgb(20,40,240)}#green{left:40px;top:3000px;background:rgb(20,180,60)}#edit{position:absolute;left:400px;top:20px}</style>
<div id=red class=mark></div><div id=blue class=mark></div><div id=green class=mark></div><input id=edit>
<script>window.review={wheels:[],clicks:0,greenClicks:0};document.addEventListener('wheel',e=>{if(e.deltaX||e.deltaY)window.review.wheels.push([e.deltaX,e.deltaY]);e.preventDefault()},{passive:false});document.querySelector('#red').onclick=()=>window.review.clicks++;document.querySelector('#green').onclick=()=>window.review.greenClicks++;</script>`;

type Case = { id: string; status: "PASS" | "FAIL" | "NOT_RUN"; evidence?: CaseEvidence; error?: string };

/** The value space a case body may hand back: JSON scalars, arrays and nested objects. */
type JsonValue = string | number | boolean | null | undefined | readonly JsonValue[] | { readonly [name: string]: JsonValue };

/** One case's evidence: the JSON value recorded in result.json and written to disk. */
type CaseEvidence = JsonValue;

/** Tool-call parameters forwarded to the extension's executeToolCall boundary, which
 * validates each field against ToolContract (shared/protocol.ts). */
type ToolParams = {
  url?: string;
  target?: string;
  value?: string;
  text?: string;
  point?: number[];
  deltaY?: number;
  scale?: "css" | "raw";
  clip?: { x: number; y: number; width: number; height: number; scale?: number };
  fullPage?: boolean;
};

/** Emulation.setDeviceMetricsOverride arguments — the only raw CDP method these cases
 * send; every other CDP traffic goes through the real tools. */
type DeviceMetricsOverride = { width: number; height: number; deviceScaleFactor: number; mobile: boolean };

/** The host tool_result envelope as read back by the cancellation cases. */
type HostToolResult = { ok: boolean; data?: { tabId?: number }; error?: string; executionFact?: ToolExecutionFact };

const cases: Case[] = [];

let iso: IsolatedExtension | undefined;

let tabId = 0;

const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };

const tool = async (name: string, params: ToolParams) => {
  const result = await iso!.tool(name, params, "main");

  if (!result?.ok) throw Object.assign(new Error(result?.error ?? "Missing tool result"), { executionFact: result?.executionFact });

  return result.data;
};

// SAFETY: the isolated harness evaluates every expression through CDP
// Runtime.evaluate with returnByValue, so a resolved swEval is the page's own
// JSON value; the per-call shapes below narrow it further where they need to.
const json = async (expression: string): Promise<JsonValue> => iso!.swEval(expression) as Promise<JsonValue>;

const page = async (expression: string) => json(`(async()=>{const r=await chrome.scripting.executeScript({target:{tabId:${tabId}},world:'MAIN',func:()=>(${expression})});return r[0]?.result;})()`);

const raw = async (method: string, params: DeviceMetricsOverride) => json(`chrome.debugger.sendCommand({tabId:${tabId}},${JSON.stringify(method)},${JSON.stringify(params)})`);

const restoreTransport = () => iso!.swEval(`(()=>{if(globalThis.__reviewOriginal){chrome.debugger.sendCommand=globalThis.__reviewOriginal;delete globalThis.__reviewOriginal;}return true})()`);

const run = async (id: string, body: () => Promise<CaseEvidence>) => {
  if (selected.size && !selected.has(id.split("/")[0])) { cases.push({ id, status: "NOT_RUN" });

 return; }

  try { const evidence = await body(); cases.push({ id, status: "PASS", evidence }); console.log("PASS", id); }
  catch (error) { cases.push({ id, status: "FAIL", error: String(error) }); console.log("FAIL", id, String(error)); }
  finally {
    await restoreTransport();

    // Reset only the disposable fault-injection fixture between transport cases.
    // A synthetic lost reply must not poison the next, independent case's setup.
    if (id.startsWith("delivery/")) await iso!.swEval(`chrome.debugger.detach({tabId:${tabId}}).catch(()=>{})`);
  }
};

const pixels = async (base64: string, points: number[][]) => json(`(async()=>{
  const bytes=Uint8Array.from(atob(${JSON.stringify(base64)}),c=>c.charCodeAt(0));
  const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
  const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);bitmap.close();
  return ${JSON.stringify(points)}.map(p=>Array.from(ctx.getImageData(p[0],p[1],1,1).data).slice(0,3));
})()`);

let cleanup: unknown;

let fatal: string | undefined;

try {
  iso = await launchIsolatedExtension({ localOnly: true, fixtureHtml: html });
  tabId = (await tool("open_tab", { url: iso.fixtureOrigin })).tabId;
  await tool("snapshot", {});
  // Foreground setup belongs to the test, not production worker input code.
  await iso.swEval(`chrome.tabs.update(${tabId},{active:true})`);

  await run("delivery/insert-reply-lost", async () => {
    await tool("fill", { target: "#edit", value: "" });
    await iso.swEval(`(()=>{
      const original=chrome.debugger.sendCommand.bind(chrome.debugger);globalThis.__reviewOriginal=original;globalThis.__reviewInputSends=0;
      chrome.debugger.sendCommand=async(target,method,params)=>{
        const result=await original(target,method,params);
        if(method==='Input.insertText'){globalThis.__reviewInputSends++;if(globalThis.__reviewInputSends===1)throw new Error('Detached while handling command');}
        return result;
      };return true;
    })()`);
    const reply = await iso!.tool("type_text", { text: "X" }, "main");
    const value = await page("document.querySelector('#edit').value");
    const sends = await json("globalThis.__reviewInputSends");
    const evidence = { reply, value, sends };
    await writeFile(join(out, "insert-reply-lost.json"), JSON.stringify(evidence, null, 2));
    assert(value === "X" && sends === 1, "Applied input was replayed after its reply was lost");
    assert(reply?.ok === false && reply?.executionFact === "unknown", "Lost reply must preserve unknown execution");

    return evidence;
  });

  await run("delivery/wheel-trailing-reply-lost", async () => {
    await tool("snapshot", {});
    await iso.swEval(`(()=>{
      const original=chrome.debugger.sendCommand.bind(chrome.debugger);globalThis.__reviewOriginal=original;globalThis.__reviewWheels=0;
      chrome.debugger.sendCommand=async(target,method,params)=>{
        const result=await original(target,method,params);
        if(method==='Input.dispatchMouseEvent'&&params?.type==='mouseWheel'){
          if(params.deltaX||params.deltaY)globalThis.__reviewWheels++;
          else return new Promise(()=>{});
        }
        return result;
      };return true;
    })()`);
    const reply = await iso.tool("wheel", { point: [60, 150], deltaY: 120 }, "main");
    const sends = await json("globalThis.__reviewWheels");
    const wheelEvents = await page("window.review.wheels");
    const evidence = { reply, sends, wheelEvents };
    await writeFile(join(out, "wheel-reply-lost.json"), JSON.stringify(evidence, null, 2));
    assert(Array.isArray(wheelEvents) && wheelEvents.length >= 1, "Fault injection did not reach the real page");
    assert(sends === 1, "Trailing ACK failure replayed the main wheel delta");
    assert(!/mouseMoved 失败/.test(reply?.error ?? ""), "Fixture attach failed before the intended trailing-ACK fault");
    assert(reply?.ok === false && reply?.executionFact === "unknown", "Unconfirmed gesture reported success or not_executed");

    return evidence;
  });

  for (const dpr of [1, 2]) {
    for (const mode of ["viewport", "clip", "fullPage"] as const) for (const scale of ["css", "raw"] as const) {
      await run(`pixels/${mode}-dpr${dpr}-${scale}`, async () => {
        await tool("snapshot", {});
        // Test setup cannot assume a prior snapshot avoided its supported DOM fallback.
        await iso!.swEval(`chrome.debugger.attach({tabId:${tabId}},'1.3').catch(e=>{if(!/already attached/i.test(String(e)))throw e;})`);
        await raw("Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: dpr, mobile: false });
        // SAFETY: the evaluated page expression is an object literal returning exactly
        // innerWidth, innerHeight, devicePixelRatio and the two documentElement scroll
        // extents, so every field of the read-back is a number.
        const geometry = await page("({w:innerWidth,h:innerHeight,dpr:devicePixelRatio,fullW:document.documentElement.scrollWidth,fullH:document.documentElement.scrollHeight})") as { w: number; h: number; dpr: number; fullW: number; fullH: number };
        assert(geometry.dpr === dpr, "Actual fixture DPR differs from the case label");
        const clip = { x: 40, y: 120, width: 260, height: 160 };
        const shot = await tool("screenshot", { scale, ...(mode === "clip" ? { clip } : mode === "fullPage" ? { fullPage: true } : {}) });
        const png = Buffer.from(shot.imageBase64, "base64");
        await writeFile(join(out, `${mode}-${dpr}-${scale}.png`), png);
        const density = scale === "css" ? 1 : geometry.dpr;
        const cssW = mode === "clip" ? clip.width : mode === "fullPage" ? geometry.fullW : geometry.w;
        const cssH = mode === "clip" ? clip.height : mode === "fullPage" ? geometry.fullH : geometry.h;
        const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
        const points = mode === "clip" ? [[10, 10], [170, 70], [120, 30]] : [[50, 130], [210, 170], ...(mode === "fullPage" ? [[50, 3010]] : [])];
        const sampled = await pixels(shot.imageBase64, points.map(([x, y]) => [Math.floor(x * density), Math.floor(y * density)]));
        const expected = mode === "clip" ? [[255,102,102],[20,40,240],[255,255,255]] : [[255,102,102],[20,40,240], ...(mode === "fullPage" ? [[20,180,60]] : [])];
        assert(width === Math.round(cssW * density) && height === Math.round(cssH * density), `Wrong ${scale} size: ${width}x${height}; expected ${cssW*density}x${cssH*density}`);
        assert(JSON.stringify(sampled) === JSON.stringify(expected), `Wrong pixels/origin: ${JSON.stringify(sampled)}`);

        return { geometry, width, height, sampled, source: shot.source, documentId: shot.documentId, coordinates: shot.coordinates };
      });
    }
  }

  for (const dpr of [1, 2]) for (const clipScale of [0.5, 1.5]) for (const scale of ["css", "raw"] as const) {
    await run(`custom-scale/dpr${dpr}-clip${clipScale}-${scale}`, async () => {
      await tool("snapshot", {});
      await raw("Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: dpr, mobile: false });
      const actualDpr = await page("devicePixelRatio");
      assert(actualDpr === dpr, "Fixture DPR not established");
      const clip = { x: 40, y: 120, width: 260, height: 160, scale: clipScale };
      // Both flags deliberately provided: clip has contractual priority.
      const shot = await tool("screenshot", { fullPage: true, clip, scale });
      const density = dpr * clipScale;
      const png = Buffer.from(shot.imageBase64, "base64");
      await writeFile(join(out, `custom-${dpr}-${clipScale}-${scale}.png`), png);
      const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
      const colors = await pixels(shot.imageBase64, [[10,10],[170,70],[120,30]].map(([x,y]) => [x*density,y*density]));
      assert(width === 260*density && height === 160*density, "Explicit clip.scale was overridden or fullPage took precedence");
      assert(JSON.stringify(colors) === JSON.stringify([[255,102,102],[20,40,240],[255,255,255]]), "Custom-scale pixels do not belong to the requested region");
      assert(shot.fullPage !== true && shot.scale === undefined && shot.coordinates?.pixelsPerCssPixel === density, "Custom scale mislabeled as css/raw/fullPage");

      return { clip, outerScale: scale, actualDpr, width, height, colors, coordinates: shot.coordinates };
    });
  }

  await run("custom-scale/fractional-region", async () => {
    await tool("snapshot", {});
    await raw("Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: 2, mobile: false });
    const clip = { x: 40.25, y: 120.25, width: 260.25, height: 160.25, scale: 4 };
    const shot = await tool("screenshot", { clip, scale: "css" });
    const png = Buffer.from(shot.imageBase64, "base64");
    await writeFile(join(out, "fractional-region.png"), png);
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
    const colors = await pixels(shot.imageBase64, [[80,80],[1360,560],[960,240]]);
    assert(Math.abs(width - clip.width*8) <= 1 && Math.abs(height - clip.height*8) <= 1, "Premature CSS rounding changed capture dimensions");
    assert(shot.cssWidth === clip.width && shot.cssHeight === clip.height, "Fractional CSS area rounded in the receipt");
    assert(JSON.stringify(colors) === JSON.stringify([[255,102,102],[20,40,240],[255,255,255]]), "Fractional region pixels incorrect");

    return { clip, width, height, colors, cssWidth: shot.cssWidth, cssHeight: shot.cssHeight, coordinates: shot.coordinates };
  });

  for (const mutation of ["viewport", "late-document"] as const) {
    await run(`capture-boundary/${mutation}`, async () => {
      await tool("snapshot", {});
      await raw("Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
      await iso!.swEval(`(()=>{
        const original=chrome.debugger.sendCommand.bind(chrome.debugger);globalThis.__reviewOriginal=original;
        globalThis.__reviewBoundary=null;let captured=false,changed=false;
        chrome.debugger.sendCommand=async(target,method,params)=>{
          const result=await original(target,method,params);
          if(method==='Page.captureScreenshot')captured=true;
          if(captured&&!changed&&(${JSON.stringify(mutation)}==='viewport'?method==='Page.captureScreenshot':method==='Runtime.evaluate')){
            changed=true;
            if(${JSON.stringify(mutation)}==='viewport'){
              await original(target,'Emulation.setDeviceMetricsOverride',{width:700,height:500,deviceScaleFactor:2,mobile:false});
              globalThis.__reviewBoundary={kind:'viewport',width:700,dpr:2};
            }else{
              const read=async()=>(await chrome.scripting.executeScript({target:{tabId:target.tabId},func:()=>location.href}))[0];
              const before=await read();await chrome.tabs.reload(target.tabId);
              for(let i=0;i<100;i++){
                const after=await read().catch(()=>null);
                if(after?.documentId&&after.documentId!==before.documentId){globalThis.__reviewBoundary={kind:'late-document',before:before.documentId,after:after.documentId};break;}
                await new Promise(r=>setTimeout(r,20));
              }
            }
          }
          return result;
        };return true;
      })()`);
      const reply = await iso!.tool("screenshot", { clip: { x:40,y:120,width:260,height:160 } }, "main");
      const changed = await json("globalThis.__reviewBoundary");
      const evidence = { mutation, changed, reply: { ok:reply?.ok,error:reply?.error,documentId:reply?.data?.documentId } };
      await writeFile(join(out, `${mutation}.json`), JSON.stringify(evidence, null, 2));
      assert(changed !== null, "Fault fixture failed to apply the requested real change");
      assert(reply?.ok === false, `Accepted stale screenshot after ${mutation}`);
      assert((mutation === "viewport" ? /视口变化|DPR/ : /STALE_DOCUMENT/).test(reply.error ?? ""), "Unexpected error cannot stand in for the tested identity boundary");

      return evidence;
    });
  }

  await run("coordinates/scrolled-clip-to-real-click", async () => {
    await tool("snapshot", {});
    await raw("Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: 2, mobile: false });
    await page("(()=>{window.scrollTo(0,2800);return scrollY})()");
    const shot = await tool("screenshot", { scale: "raw", clip: { x: 40, y: 3000, width: 100, height: 100 } });
    const mapping = shot.coordinates;
    assert(mapping?.space === "document" && mapping.pixelsPerCssPixel === 2, "Missing actual coordinate mapping");
    const color = await pixels(shot.imageBase64, [[100,100]]);
    assert(JSON.stringify(color) === JSON.stringify([[20,180,60]]), "Clip did not capture the offscreen green target");

    const point = [100 / mapping.pixelsPerCssPixel + mapping.origin.x - mapping.scroll.x,
      100 / mapping.pixelsPerCssPixel + mapping.origin.y - mapping.scroll.y];

    await tool("click", { point });
    const actual = await page("window.review.greenClicks");
    assert(actual === 1, "Image-derived viewport coordinate did not click the pictured object");
    await page("(()=>{window.scrollTo(0,0);return scrollY})()");

    return { mapping, point, color, actual };
  });

  await run("identity/same-url-reload", async () => {
    await tool("snapshot", {});
    await iso.swEval(`(()=>{
      const original=chrome.debugger.sendCommand.bind(chrome.debugger);globalThis.__reviewOriginal=original;
      chrome.debugger.sendCommand=async(target,method,params)=>{
        const result=await original(target,method,params);
        if(method==='Page.captureScreenshot'){
          const readDocument=async()=> (await chrome.scripting.executeScript({target:{tabId:target.tabId},func:()=>location.href}))[0];
          const before=await readDocument();
          await chrome.tabs.reload(target.tabId);
          for(let i=0;i<100;i++){
            const after=await readDocument().catch(()=>null);
            if(after?.documentId&&after.documentId!==before.documentId){globalThis.__reviewReload={before:before.documentId,after:after.documentId};break;}
            await new Promise(r=>setTimeout(r,20));
          }
        }
        return result;
      };return true;
    })()`);
    const reply = await iso.tool("screenshot", { clip: { x: 40, y: 120, width: 260, height: 160 } }, "main");
    // SAFETY: the injected transport wrapper only ever assigns
    // globalThis.__reviewReload to the { before, after } document-id pair it read from
    // Page.captureScreenshot, so the read-back is that pair or undefined.
    const replacement = await iso.swEval("globalThis.__reviewReload") as { before?: string; after?: string } | undefined;
    assert(Boolean(replacement?.before && replacement.after && replacement.before !== replacement.after), "Fixture did not replace the document");
    assert(reply?.ok === false, "Screenshot accepted old pixels from a replaced document with the same URL");
    assert(/STALE_DOCUMENT|文档|document.*chang/i.test(reply.error ?? ""), "Failure was not caused by the tested document-identity guard");

    return { error: reply.error, replacement };
  });

  await run("arguments/clip-scale", async () => {
    const results = [];

    for (const scale of [0, -1, null]) {
      const reply = await iso!.tool("screenshot", { clip: { x: 40, y: 120, width: 100, height: 100, scale } }, "main");
      assert(reply?.ok === false, `Invalid clip.scale=${scale} was accepted`);
      results.push({ scale, error: reply.error });
    }

    return results;
  });

  await run("cancel/wheel-current-run", async () => {
    const conversationId = "review-cancel", runId = `review-${Date.now()}`;
    // SAFETY: __saCall answers with the host's tool_result envelope from
    // shared/protocol.ts, so ok/error/executionFact are always present and `data`
    // is the open_tab receipt this case reads its tabId from.
    const callInRun = (name: string, params: ToolParams) => iso!.swEval(`globalThis.__saCall(${JSON.stringify(`cancel-${name}-${Date.now()}`)},${JSON.stringify(name)},${JSON.stringify(params)},'main',null,${JSON.stringify(conversationId)},${JSON.stringify({runId})})`) as Promise<HostToolResult>;
    await iso!.swEval(`globalThis.__saHandleServer(${JSON.stringify({type:"conversation_updated",conversation:{id:conversationId,title:"Review cancellation",createdAt:Date.now(),updatedAt:Date.now(),state:"running",mode:"act",runId}})})`);
    const opened = await callInRun("open_tab", { url: iso!.fixtureOrigin });
    const openedTabId = opened.data?.tabId;

    assert(opened.ok && Number.isInteger(openedTabId), "Failed to open an actual current-run fixture");
    tabId = openedTabId!;
    assert((await callInRun("snapshot", {})).ok, "Failed to observe the current-run document");
    await iso!.swEval(`chrome.tabs.update(${tabId},{active:true})`);
    await iso!.swEval(`(()=>{
      const original=chrome.debugger.sendCommand.bind(chrome.debugger);globalThis.__reviewOriginal=original;globalThis.__reviewAfterCancel=[];
      let stopped=false;
      chrome.debugger.sendCommand=async(target,method,params)=>{
        if(stopped&&method==='Input.dispatchMouseEvent')globalThis.__reviewAfterCancel.push(params);
        const value=await original(target,method,params);
        if(!stopped&&method==='Input.dispatchMouseEvent'&&params.type==='mouseWheel'&&(params.deltaX||params.deltaY)){
          stopped=true;globalThis.__saHandleServer(${JSON.stringify({type:"task_control",conversationId,runId,action:"abort",requestId:"review-cancel-control"})});
        }
        return value;
      };return true;
    })()`);
    const reply = await callInRun("wheel", { point: [60,150], deltaY: 120 });
    const afterCancel = await json("globalThis.__reviewAfterCancel");
    assert(reply.ok === false && reply.executionFact === "unknown", "Cancellation lost the already-sent input fact");
    assert(Array.isArray(afterCancel) && afterCancel.length === 0, "Wheel dispatched more input after the current run was aborted");
    const next = await callInRun("click", { point: [60,150] });
    assert(next.ok === false, "Aborted run accepted a subsequent click");
    const clicks = await page("window.review.clicks");
    assert(clicks === 0, "Click after abort reached the page");

    return { runId, reply, afterCancel, next, clicks };
  });
} catch (error) {
  fatal = String(error);
} finally {
  cleanup = iso ? await iso.close() : { status: "NOT_STARTED" };
  const dailyAfter = await fileHash(daily);
  const afterHashes = await snapshotHashes();
  const executed = cases.filter(c => c.status !== "NOT_RUN");

  // SAFETY: the finally block assigns cleanup exactly once, either from
  // IsolatedExtension.close() (status "PASS"/"FAIL") or the launch-never-happened
  // sentinel { status: "NOT_STARTED" }; only that status field is read here.
  const result = {
    ok: !fatal && !selected.size && executed.length > 0 && executed.every(c => c.status === "PASS") && (cleanup as { status?: string }).status === "PASS" && dailyBefore === dailyAfter && JSON.stringify(sourceHashes) === JSON.stringify(afterHashes),
    runKind: selected.size ? "filtered" : "full", cases, cleanup, modelRequests: 0,
    sourceHashes, sourceUnchanged: JSON.stringify(sourceHashes) === JSON.stringify(afterHashes),
    buildHash: hash(await readFile(join(buildDir, "background.js"))), dailyDistUnchanged: dailyBefore === dailyAfter,
    entry: "isolated real extension executor; transport faults occur after real command delivery; independent page/PNG oracle",
  };

  // result.json omits `fatal` entirely unless one was recorded, so the property is
  // added only when present instead of being spread in from an empty object.
  if (fatal) Object.assign(result, { fatal });

  await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ out, pass: executed.filter(c => c.status === "PASS").length, fail: executed.filter(c => c.status === "FAIL").length, cleanup, dailyDistUnchanged: result.dailyDistUnchanged }));
  // SAFETY: the finally block assigns cleanup exactly once, either from
  // IsolatedExtension.close() (status "PASS"/"FAIL") or the launch-never-happened
  // sentinel { status: "NOT_STARTED" }; only that status field is read here.
  process.exitCode = !fatal && executed.length && executed.every(c => c.status === "PASS") && (cleanup as { status?: string }).status === "PASS" && result.sourceUnchanged && result.dailyDistUnchanged ? 0 : 1;
}
