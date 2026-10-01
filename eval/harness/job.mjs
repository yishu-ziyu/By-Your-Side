/**
 * One eval job = one (model, task) in its own headed Chrome on its own Xvfb display,
 * with its own profile, extension copy, native-host manifest and companion data dir
 * (SIDEAGENT_DATA_DIR -> per-job config.json with the model). Never touches ~/.sideagent
 * or your desktop Chrome and its profile.
 */
import { spawn, execFileSync } from "node:child_process";
import { rmSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync, statSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { REPO, NODE } from "./paths.mjs";

export { REPO };

export const DIST = join(REPO, "extension/dist");

export const EXT_ID = "fnbjglhppbkgmjeehablkfilmmefjolo";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const q = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;

const iso = (ms) => new Date(ms).toISOString();

// Words that mean submit / buy / post / send: any confirmation mentioning these is denied.
const DANGEROUS = /提交|购买|买|支付|付款|下单|结算|发布|发表|发帖|发送|评论|删除|清空|注销|submit|buy|purchase|pay|checkout|order|post|publish|send|tweet|comment|delete|remove/i;

/** CDP over --remote-debugging-pipe (needed for Extensions.loadUnpacked on branded Chrome). */
function pipeCdp(child) {
  const w = child.stdio[3], r = child.stdio[4];
  let seq = 0, buf = "";
  const pending = new Map(), handlers = new Set();
  let dead = null;

  const die = (why) => {
    if (dead) return;
    dead = why;

    for (const p of pending.values()) p.rej(new Error(`CDP pipe closed: ${why}`));
    pending.clear();
  };

  r.on("error", (e) => die(`read ${e.code ?? e.message}`));
  w.on("error", (e) => die(`write ${e.code ?? e.message}`));
  r.on("close", () => die("pipe closed"));
  child.on("exit", (code, sig) => die(`chrome exited code=${code} signal=${sig}`));
  child.on("error", (e) => die(`chrome spawn error ${e.message}`));
  r.on("data", (d) => {
    buf += d;
    let i;

    while ((i = buf.indexOf("\0")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);

      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);

        if (msg.error) p.rej(new Error(`${p.method}: ${msg.error.message}`));
        else p.res(msg.result ?? {});
      }
      else for (const h of handlers) h(msg);
    }
  });

  const send = (method, params = {}, sessionId, timeoutMs = 30000) => new Promise((res, rej) => {
    if (dead) return rej(new Error(`CDP pipe closed: ${dead}`));
    const id = ++seq;
    const t = setTimeout(() => { pending.delete(id); rej(new Error(`${method} timed out`)); }, timeoutMs);
    pending.set(id, { method, res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });

    const payload = { id, method, params };

    if (sessionId) payload.sessionId = sessionId;

    try { w.write(JSON.stringify(payload) + "\0"); } catch (e) { die(`write ${e.message}`); }
  });

  return { send, on: (h) => handlers.add(h), dead: () => dead };
}

function freeDisplay(start) {
  for (let d = start; d < start + 200; d++) if (!existsSync(`/tmp/.X11-unix/X${d}`) && !existsSync(`/tmp/.X${d}-lock`)) return d;
  throw new Error("no free X display");
}

function readTrace(dataDir) {
  const dir = join(dataDir, "traces");

  if (!existsSync(dir)) return [];
  const out = [];

  for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) { if (line.trim()) try { out.push(JSON.parse(line)); } catch {} }
  }

  return out;
}

const PANEL_PROBE = `(() => {
  const txt = (el) => (el?.innerText ?? "").trim();
  const msgs = [...document.querySelectorAll("#messages .msg, .msg")].map((el) => ({ cls: el.className, text: txt(el) }));
  const runs = [...document.querySelectorAll("details.run-steps")].map((d) => ({
    title: txt(d.querySelector(".run-title")), chain: txt(d.querySelector(".run-chain")), time: txt(d.querySelector(".run-time")),
    chips: [...d.querySelectorAll(".chip")].map((c) => ({ label: txt(c.querySelector(".chip-label")) || txt(c), detail: txt(c.querySelector(".chip-detail")), cls: c.className })),
    thinking: [...d.querySelectorAll(".thinking")].map(txt).join("\\n").slice(0, 2000),
  }));
  const consents = [...document.querySelectorAll("#consent-requests .consent-card")].map((c, i) => ({ i, text: txt(c), buttons: [...c.querySelectorAll("button")].map((b) => b.textContent.trim()) }));
  const artifacts = [...document.querySelectorAll(".artifact-card")].map((c) => txt(c.querySelector(".artifact-name")) + " · " + txt(c.querySelector(".artifact-meta")));
  const abort = document.getElementById("abort-btn");
  return { msgs, runs, consents, artifacts, abortVisible: !!abort && !abort.hidden, streaming: !!document.querySelector(".msg.assistant.streaming, .thinking.streaming"), inputReady: !!document.querySelector("#input") };
})()`;

/** Child processes still alive (so the runner can kill them if it exits). */
export const LIVE = new Set();

export function killLive() { for (const p of LIVE) { try { p.kill("SIGKILL"); } catch {} }

 LIVE.clear(); }

export async function runJob({ task, model, outDir, workRoot, displayBase = 40, capMs = 240000, log = () => {}, dryRun = false }) {
  const slug = model.replace(/[^a-z0-9.-]+/gi, "_");
  const work = join(workRoot, `${slug}__${task.id}`);
  rmSync(work, { recursive: true, force: true }); // never reuse a stale profile/data dir
  const dirs = { profile: join(work, "profile"), ext: join(work, "ext"), data: join(work, "data"), host: join(work, "host"), downloads: join(work, "downloads") };

  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const rec = { id: task.id, model, category: task.category, site_url: task.site_url, prompt: task.prompt,
    status: "error", timestamps: {}, load_at_start: os.loadavg().map((x) => Math.round(x * 10) / 10), seconds_to_first_output: null, seconds_total: null,
    steps: [], final_answer_verbatim: "", panel_messages: [], confirmations: [], errors: [],
    final_page: null, downloads: [], screenshots: [], trace_model: null, harness: { work, display: null } };

  const t = (ms) => ms == null ? null : Math.round((ms - rec._t0) / 100) / 10;
  const procs = {};
  let cdp;

  try {
    // --- per-job extension copy, companion config, native host ---
    cpSync(DIST, dirs.ext, { recursive: true });
    writeFileSync(join(dirs.data, "config.json"), JSON.stringify({ model }, null, 2));
    const wrapper = join(dirs.host, "native-host.sh");
    writeFileSync(wrapper, ["#!/bin/bash", `echo $$ >> ${q(join(dirs.host, "pids"))}`, `export SIDEAGENT_DATA_DIR=${q(dirs.data)}`,
      "unset SIDEAGENT_TRACE_DIR SIDEAGENT_DOWNLOADS_DIR SIDEAGENT_ROUTE_SHADOW_DIR",
      `exec ${q(NODE)} ${q(join(REPO, "node_modules/tsx/dist/cli.mjs"))} ${q(join(REPO, "agent/src/main.ts"))} 2>> ${q(join(dirs.host, "wrapper-err.log"))}`, ""].join("\n"));
    chmodSync(wrapper, 0o755);
    mkdirSync(join(dirs.profile, "NativeMessagingHosts"), { recursive: true });
    writeFileSync(join(dirs.profile, "NativeMessagingHosts", "com.sideagent.host.json"), JSON.stringify({ name: "com.sideagent.host", description: "BYS eval harness host", path: wrapper, type: "stdio", allowed_origins: [`chrome-extension://${EXT_ID}/`] }, null, 2));
    mkdirSync(join(dirs.profile, "Default"), { recursive: true });
    writeFileSync(join(dirs.profile, "Default", "Preferences"), JSON.stringify({ download: { default_directory: dirs.downloads, prompt_for_download: false, directory_upgrade: true }, savefile: { default_directory: dirs.downloads } }));

    // --- own Xvfb ---
    const display = freeDisplay(displayBase);
    rec.harness.display = `:${display}`;
    procs.xvfb = spawn("Xvfb", [`:${display}`, "-screen", "0", "1440x960x24", "-ac", "-noreset"], { stdio: "ignore", detached: false });
    procs.xvfb.on("error", (e) => rec.errors.push(`xvfb: ${e.message}`));
    LIVE.add(procs.xvfb);

    for (let i = 0; i < 50 && !existsSync(`/tmp/.X11-unix/X${display}`); i++) await sleep(100);

    // --- headed Chrome, extension loaded via CDP pipe ---
    const env = { ...process.env, DISPLAY: `:${display}` };

    for (const k of ["SIDEAGENT_DATA_DIR", "STEPFUN_API_KEY", "TYPESAFE_API_KEY"]) delete env[k];
    procs.chrome = spawn("google-chrome", ["--no-sandbox", "--disable-dev-shm-usage", "--password-store=basic", "--no-first-run", "--no-default-browser-check",
      "--hide-crash-restore-bubble", `--user-data-dir=${dirs.profile}`, "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
      "--window-position=0,0", "--window-size=1440,960", "--lang=zh-CN", "--disable-features=Translate", "about:blank"],
      { env, stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
    procs.chrome.stderr.on("data", () => {});
    procs.chrome.stderr.on("error", () => {});
    LIVE.add(procs.chrome);
    cdp = pipeCdp(procs.chrome);
    await sleep(1500);
    const loaded = await cdp.send("Extensions.loadUnpacked", { path: dirs.ext }, undefined, 20000);

    if (loaded.id !== EXT_ID) throw new Error(`extension id mismatch ${loaded.id}`);
    const targets = async () => (await cdp.send("Target.getTargets")).targetInfos;
    const attach = async (targetId) => (await cdp.send("Target.attachToTarget", { targetId, flatten: true })).sessionId;

    const evalIn = async (sid, expression, { userGesture = false, timeoutMs = 20000 } = {}) => {
      const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture }, sid, timeoutMs);

      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);

      return r.result?.value;
    };

    const until = async (fn, ms, label) => {
      const end = Date.now() + ms;

      while (Date.now() < end) {
        const v = await fn().catch(() => undefined);

        if (v) return v;
        await sleep(250);
      }

      throw new Error(`timeout: ${label}`);
    };

    // --- task page ---
    const page = await until(async () => (await targets()).find((x) => x.type === "page" && x.url === "about:blank"), 10000, "initial tab");
    const pageSid = await attach(page.targetId);
    await cdp.send("Page.enable", {}, pageSid);
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dirs.downloads, eventsEnabled: true }).catch(() => {});
    rec.timestamps.page_open = iso(Date.now());
    await cdp.send("Page.navigate", { url: task.site_url }, pageSid);
    await until(async () => (await evalIn(pageSid, "document.readyState")) === "complete", 45000, "page load").catch((e) => rec.errors.push(`page load: ${e.message}`));
    await sleep(1000);

    // --- real side panel (chrome.sidePanel.open needs a user gesture: extension page + CDP userGesture) ---
    const helper = (await cdp.send("Target.createTarget", { url: `chrome-extension://${EXT_ID}/voice-permission.html`, background: true })).targetId;
    const hs = await attach(helper);
    await until(async () => evalIn(hs, `document.readyState === "complete" && !!globalThis.chrome?.windows`), 10000, "helper page");
    const winId = await evalIn(hs, "chrome.windows.getLastFocused({windowTypes:['normal']}).then(w=>w.id)");
    const opened = await evalIn(hs, `chrome.sidePanel.open({ windowId: ${winId} }).then(() => "opened", (e) => "error: " + e.message)`, { userGesture: true });
    await cdp.send("Target.closeTarget", { targetId: helper }).catch(() => {});

    if (opened !== "opened") throw new Error(`side panel: ${opened}`);
    const panel = await until(async () => (await targets()).find((x) => x.type === "page" && x.url.startsWith(`chrome-extension://${EXT_ID}/sidepanel.html`)), 15000, "side panel");
    const ps = await attach(panel.targetId);
    await until(async () => evalIn(ps, "!!document.querySelector('#input')"), 15000, "panel input");
    await cdp.send("Page.bringToFront", {}, pageSid).catch(() => {});
    // companion connected = host process wrote its log
    await until(async () => existsSync(join(dirs.data, "agent.log")) && statSync(join(dirs.data, "agent.log")).size > 0, 30000, "companion start").catch((e) => rec.errors.push(`companion: ${e.message}`));
    await sleep(2500);
    const newBtn = await evalIn(ps, "(()=>{const b=document.querySelector('#conversation-new');if(b&&!b.disabled&&document.querySelectorAll('.msg').length){b.click();return true}return false})()");

    if (newBtn) await sleep(800);
    await cdp.send("Page.captureScreenshot", { format: "png" }, ps).catch(() => {});

    if (dryRun) {
      rec.status = "dry_run_ok";
      rec.dry = { panel: await evalIn(ps, PANEL_PROBE), log: readFileSync(join(dirs.data, "agent.log"), "utf8").slice(-3000), modelLabel: await evalIn(ps, "document.body.innerText.slice(0,2000)") };

      try { execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "x11grab", "-video_size", "1440x960", "-i", `:${display}`, "-frames:v", "1", join(outDir, `${task.id}-dry.png`)], { timeout: 15000 }); } catch {}

      return rec;
    }

    // --- send prompt like a user: focus, type, Enter ---
    await evalIn(ps, "document.querySelector('#input').focus()");
    await cdp.send("Input.insertText", { text: task.prompt }, ps);
    await sleep(200);
    rec._t0 = Date.now();
    rec.timestamps.send = iso(rec._t0);
    const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", text: "\r", ...key }, ps);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key }, ps);

    // --- watch panel DOM + companion trace ---
    const seen = new Set();

    const addStep = (at, source, text) => {
      const k = `${source}|${text}`;

      if (seen.has(k)) return;
      seen.add(k);
      rec.steps.push({ t: t(at), at: iso(at), source, text: String(text).slice(0, 500) });
    };

    let firstOut = null, lastChange = Date.now(), lastSig = "", ended = null, deniedHeld = new Set(), handledConsent = new Set();
    const deadline = rec._t0 + capMs;
    let snap;

    while (Date.now() < deadline) {
      const now = Date.now();
      snap = await evalIn(ps, PANEL_PROBE).catch((e) => ({ error: e.message }));

      if (snap?.error) { rec.errors.push(`panel probe: ${snap.error}`); await sleep(500); continue; }

      const afterUser = snap.msgs.slice(snap.msgs.findLastIndex((m) => /\buser\b/.test(m.cls)) + 1);

      for (const m of afterUser) if (m.text && !/streaming/.test(m.cls)) addStep(now, `panel:${m.cls.replace(/^msg\s*/, "") || "msg"}`, m.text.slice(0, 300));

      for (const a of snap.artifacts) addStep(now, "panel:artifact", a);

      for (const r of snap.runs) {
        if (r.title) addStep(now, "panel:status", r.title);

        for (const c of r.chips) addStep(now, "panel:chip", [c.label, c.detail].filter(Boolean).join(" — "));
      }

      const visible = afterUser.some((m) => m.text) || snap.runs.some((r) => r.chips.length || (r.title && !r.title.startsWith('正在')) || r.thinking);

      if (!rec.timestamps.first_status && snap.runs.some((r) => r.title)) { rec.timestamps.first_status = iso(now); rec.seconds_to_first_status = t(now); }

      if (!firstOut && (afterUser.some((m) => m.text) || snap.runs.some((r) => r.chips.length || r.thinking))) { firstOut = now; rec.timestamps.first_visible_output = iso(now); }

      // consent cards: allow once unless it smells like submit/buy/post
      for (const c of snap.consents) {
        const k = c.text.slice(0, 200);

        if (handledConsent.has(k)) continue;
        handledConsent.add(k);
        const allow = !(DANGEROUS.test(c.text) || /\bPOST\b/.test(c.text));
        const label = allow ? "允许一次" : "拒绝";
        await evalIn(ps, `(()=>{const c=document.querySelectorAll('#consent-requests .consent-card')[${c.i}];const b=[...c.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(b){b.click();return true}return false})()`).catch(() => false);
        rec.confirmations.push({ at: iso(now), t: t(now), kind: "consent_card", text: c.text.slice(0, 400), decision: allow ? "allow_once" : "deny" });
        addStep(now, "harness", `consent ${allow ? "allowed" : "denied"}: ${c.text.slice(0, 120)}`);
      }

      // held (destructive) clicks: confirm ordinary deletes/removals on the page, but never confirm
      // anything that submits / buys / pays / posts / sends / publishes (then cancel via the panel).
      const trace = readTrace(dirs.data);
      const startArgs = new Map(trace.filter((e) => e.type === "tool_execution_start").map((e) => [e.data?.toolCallId, e.data?.args]));

      for (const e of trace) {
        if (e.type === "tool_execution_end" && /Held click/.test(JSON.stringify(e.data?.result ?? "")) && !deniedHeld.has(e.data?.toolCallId)) {
          deniedHeld.add(e.data?.toolCallId);
          const argsText = String(JSON.stringify(startArgs.get(e.data?.toolCallId) ?? e.data?.args ?? {}) ?? "");
          const heldText = argsText + " " + String(JSON.stringify(e.data?.result?.content?.[0]?.text ?? "") ?? "");
          const neverConfirm = /提交|购买|支付|付款|下单|结算|发布|发表|发帖|发送|submit|buy|purchase|pay|checkout|order|post|publish|send|tweet/i.test(argsText);
          const reply = neverConfirm ? "取消" : "确认";
          await evalIn(ps, "document.querySelector('#input').focus()");
          await cdp.send("Input.insertText", { text: reply }, ps);
          await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", text: "\r", ...key }, ps);
          await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key }, ps);
          rec.confirmations.push({ at: iso(now), t: t(now), kind: "held_click", text: heldText.slice(0, 300), decision: neverConfirm ? "deny (sent 取消)" : "confirm (sent 确认)" });
          addStep(now, "harness", `held click ${neverConfirm ? "denied" : "confirmed"}: ${argsText.slice(0, 120)}`);
        }
      }

      const settled = trace.some((e) => e.type === "agent_settled" && Date.parse(e.time) >= rec._t0 - 1000);
      const sig = JSON.stringify([snap.msgs.map((m) => m.text.length), snap.runs.map((r) => [r.title, r.chips.length]), snap.abortVisible, snap.streaming]);

      if (sig !== lastSig) { lastSig = sig; lastChange = now; }

      const idle = !snap.abortVisible && !snap.streaming;
      const answered = afterUser.some((m) => /assistant/.test(m.cls) && m.text);

      if (idle && visible && ((settled && answered && now - lastChange > 4000) || (answered && now - lastChange > 8000) || (settled && now - lastChange > 12000))) { ended = lastChange; break; }

      await sleep(300);
    }

    const endAt = ended ?? Date.now();
    rec.status = ended ? "completed" : "timeout";
    rec.timestamps.finish = iso(endAt);
    rec.seconds_total = t(endAt);
    rec.seconds_to_first_output = t(firstOut);

    // --- final state ---
    if (snap && !snap.error) {
      const afterUser = snap.msgs.slice(snap.msgs.findLastIndex((m) => /\buser\b/.test(m.cls)) + 1);
      rec.panel_messages = afterUser;
      const answers = snap.msgs.filter((m) => /assistant/.test(m.cls) && m.text);
      rec.final_answer_verbatim = answers.at(-1)?.text ?? "";
      rec.panel_runs = snap.runs;

      for (const m of afterUser) if (/error/.test(m.cls)) rec.errors.push(`panel error: ${m.text}`);

      if (!rec.final_answer_verbatim && afterUser.length) rec.final_answer_verbatim = afterUser.map((m) => m.text).join("\n");
    }

    // companion trace -> steps with exact timestamps
    const trace = readTrace(dirs.data);

    for (const e of trace) {
      const at = Date.parse(e.time);

      if (e.type === "run_start") rec.trace_model = e.data?.model ?? null;

      if (e.type === "first_response") { addStep(at, "trace:first_response", `model first response ${e.data?.elapsedMs}ms`); rec.timestamps.first_model_response ??= e.time; }

      if (e.type === "tool_execution_start") addStep(at, "trace:tool_start", `${e.data.toolName} ${JSON.stringify(e.data.args ?? {}).slice(0, 200)}`);

      if (e.type === "tool_execution_end") addStep(at, "trace:tool_end", `${e.data.toolName} ${e.data.isError ? "ERROR " : ""}${JSON.stringify(e.data.result?.content?.[0]?.text ?? "").slice(0, 200)}`);

      if (e.type === "agent_end") { addStep(at, "trace:agent_end", `elapsed ${e.data?.elapsedMs}ms`); rec.timestamps.agent_end = e.time; }

      if (e.type === "error" || /error/.test(e.type)) rec.errors.push(`trace ${e.type}: ${JSON.stringify(e.data).slice(0, 300)}`);
    }

    rec.steps.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
    rec.n_tool_calls = trace.filter((e) => e.type === "tool_execution_start").length;
    rec.n_steps = rec.steps.filter((s) => s.source === "trace:tool_start" || s.source === "panel:chip").length;

    try {
      const tabs = (await targets()).filter((x) => x.type === "page" && !x.url.startsWith("chrome-extension://"));
      rec.final_page = { url: (await evalIn(pageSid, "location.href").catch(() => null)) ?? page.url, title: await evalIn(pageSid, "document.title").catch(() => null), tabs: tabs.map((x) => ({ url: x.url, title: x.title })) };
      rec.page_changed = rec.final_page.url !== task.site_url;
    } catch (e) { rec.errors.push(`final page: ${e.message}`); }

    // screenshots: whole X display (page + side panel), and panel alone
    const shot = join(outDir, `${task.id}.png`);

    try { execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "x11grab", "-video_size", "1440x960", "-i", `:${display}`, "-frames:v", "1", shot], { timeout: 15000 }); rec.screenshots.push(shot); } catch (e) { rec.errors.push(`screenshot: ${e.message}`); }

    try { const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, ps); const p = join(outDir, `${task.id}-panel.png`); writeFileSync(p, Buffer.from(data, "base64")); rec.screenshots.push(p); } catch {}

    // artifact cards: click 下载 like a user; also rebuild files from the artifacts tool calls
    const nArt = await evalIn(ps, "(()=>{const b=[...document.querySelectorAll('.artifact-download')];b.forEach(x=>x.click());return b.length})()").catch(() => 0);

    if (nArt) await sleep(2500);
    const arts = new Map();

    for (const e of trace) {
      if (e.type !== "tool_execution_start" || e.data?.toolName !== "artifacts") continue;
      const a = e.data.args ?? {};

      if (["create", "rewrite"].includes(a.command) && a.filename) arts.set(a.filename, String(a.content ?? ""));

      if (a.command === "update" && arts.has(a.filename)) arts.set(a.filename, arts.get(a.filename).replace(a.old_str ?? "", a.new_str ?? ""));

      if (a.command === "delete") arts.delete(a.filename);
    }

    for (const [name, content] of arts) { const dst = join(outDir, `${task.id}.artifact.${name}`); writeFileSync(dst, content); rec.downloads.push({ kind: "artifact(tool args)", name, path: dst, bytes: Buffer.byteLength(content) }); }

    // downloads (browser) + companion-saved files
    for (const [dir, kind] of [[dirs.downloads, "browser"], [join(dirs.data, "downloads"), "companion"]]) {
      if (!existsSync(dir)) continue;

      for (const f of readdirSync(dir)) {
        const src = join(dir, f);

        if (!statSync(src).isFile()) continue;
        const dst = join(outDir, `${task.id}.dl.${f}`);
        copyFileSync(src, dst);
        rec.downloads.push({ kind, name: f, path: dst, bytes: statSync(src).size });
      }
    }

    // raw evidence
    writeFileSync(join(outDir, `${task.id}.trace.jsonl`), trace.map((e) => JSON.stringify(e)).join("\n"));

    if (existsSync(join(dirs.data, "agent.log"))) copyFileSync(join(dirs.data, "agent.log"), join(outDir, `${task.id}.agent.log`));

    if (rec.trace_model && rec.trace_model !== model.replace(/:[a-z]+$/, "")) rec.errors.push(`MODEL MISMATCH: trace says ${rec.trace_model}`);
  } catch (e) {
    rec.errors.push(`harness: ${e.stack ?? e.message}`);

    if (cdp?.dead?.()) rec.errors.push(`chrome/pipe died: ${cdp.dead()}`);
    rec.status = rec._t0 ? "error" : "setup_error";
  } finally {
    delete rec._t0;
    writeFileSync(join(outDir, `${task.id}.json`), JSON.stringify(rec, null, 2));

    // teardown: chrome, companion, xvfb
    try { procs.chrome?.kill("SIGTERM"); } catch {}

    await sleep(2000);

    try { procs.chrome?.kill("SIGKILL"); } catch {}

    const pids = existsSync(join(dirs.host, "pids")) ? readFileSync(join(dirs.host, "pids"), "utf8").split(/\s+/).filter(Boolean) : [];

    for (const pid of pids) {
      try { execFileSync("pkill", ["-TERM", "-P", pid]); } catch {}

      try { process.kill(Number(pid), "SIGTERM"); } catch {}
    }

    try { procs.xvfb?.kill("SIGTERM"); } catch {}

    LIVE.delete(procs.chrome); LIVE.delete(procs.xvfb);
    rec.load_at_end = os.loadavg().map((x) => Math.round(x * 10) / 10);

    try { writeFileSync(join(outDir, `${task.id}.json`), JSON.stringify({ ...rec, _t0: undefined }, null, 2)); } catch {}

    log(`${model} ${task.id} -> ${rec.status} total=${rec.seconds_total}s first=${rec.seconds_to_first_output}s`);
  }

  return rec;
}
