/** ≤50行：真实套餐会话、转写和原生回复前提，不冒充扩展分流验收。 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { RealtimeVoiceConnection } from "../../agent/src/realtime-voice-connection.ts";
const out = join("out/acceptance/session-recovery", `${new Date().toISOString().replace(/[:.]/g,"-")}-voice-plan-premise`);
await mkdir(out, { recursive: true });
const key = (await readFile(join(homedir(), ".sideagent/step-plan.key"), "utf8")).trim();
const wav = join(out, "microphone.wav");
execFileSync("say", ["-v", "Tingting", "-o", wav, "--data-format=LEI16@24000", "[[slnc 400]]你好，陪我聊两句吧。[[slnc 1000]]"]);
const raw = await readFile(wav), offset = raw.indexOf("data") + 8, pcm = raw.subarray(offset);
const events: Record<string, unknown>[] = [], logs: Record<string, unknown>[] = [];
let ready = false, done = false, error: string | null = null;
const c = new RealtimeVoiceConnection({ key, model: "stepaudio-2.5-realtime", tools: {},
  routeTranscript: async () => ({ native: true }), log: e => logs.push(e),
  send: e => { if (e.type !== "audio") events.push(e); else events.push({type:e.type,bytes:String(e.data??"").length}); if(e.type === "ready")ready=true; if(e.type === "response_done")done=true; if(e.type === "error")error=String(e.message??e.text); },
});
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
try {
  c.start();
  for(let i=0; !ready && !error && i<200; i++) await sleep(100);
  assert.ok(ready, `套餐会话未就绪：${error ?? "timeout"}`);
  for(let at=0; at<pcm.length && !error; at+=4800) { c.handle({type:"audio",data:pcm.subarray(at,at+4800).toString("base64")}); await sleep(100); }
  for(let i=0; !done && !error && i<300; i++) { c.handle({type:"audio",data:Buffer.alloc(4800).toString("base64")}); await sleep(100); }
  assert.ok(events.some(e=>e.type === "transcript" && e.role === "user" && e.final === true),"真实转写");
  assert.ok(events.some(e=>e.type === "audio"),"真实回答音频");
  assert.ok(done,"回答完整结束");
} catch(e) { error=e instanceof Error?e.message:String(e); }
finally { c.close(); await writeFile(join(out,"result.json"),JSON.stringify({status:error?"FAIL":"PASS",error,dependency:"real Step Plan; direct Node connection; router explicitly native; not extension acceptance",events,logs},null,2)); }
console.log(JSON.stringify({status:error?"FAIL":"PASS",out,error}));
if(error)process.exitCode=1;
