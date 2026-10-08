/** ≤50行：ChatGPT 登录态（无 API key）开 gpt-live-1-codex；闲聊直答、要动手时委派。Node WebSocket，不冒充扩展验收。 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
const out = join("out/acceptance/gpt-live", `${new Date().toISOString().replace(/[:.]/g, "-")}-login-premise`);
await mkdir(out, { recursive: true });
const { access, accountId } = JSON.parse(await readFile(join(homedir(), ".pi/agent/auth.json"), "utf8"))["openai-codex"];
const pcm = (text: string) => { const wav = join(out, `${randomUUID()}.wav`); execFileSync("say", ["-v", "Tingting", "-o", wav, "--data-format=LEI16@24000", text]); return readFile(wav).then(b => b.subarray(b.indexOf("data") + 8)); };
const chat = await pcm("你好呀，今天天气真不错，陪我聊两句。"), act = await pcm("帮我去维基百科查一下全双工这个词。");
const headers = { Authorization: `Bearer ${access}`, "OpenAI-Alpha": "quicksilver=v2", "session-id": randomUUID(), "thread-id": randomUUID(), "x-session-id": randomUUID(), "chatgpt-account-id": accountId };
const events: Record<string, unknown>[] = []; let audioDeltas = 0, error: string | null = null, http: string | null = null;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const ws = new WebSocket(`wss://api.openai.com/v1/live?model=gpt-live-1-codex`, { headers });
ws.on("unexpected-response", (_req, res) => { let body = ""; res.on("data", c => body += c); res.on("end", () => { http = `${res.statusCode} ${body.slice(0, 400)}`; }); });
ws.on("error", e => { error ??= e.message; });
ws.on("message", raw => {
  const e = JSON.parse(String(raw));
  if (e.type === "output_audio.delta") { audioDeltas++; return; }
  events.push({ at: Date.now(), ...e });
  if (e.type === "error") error ??= JSON.stringify(e).slice(0, 400);
  if (e.type === "delegation.created") ws.send(JSON.stringify({ type: "delegation.context.append", delegation_item_id: e.item.id, channel: "speakable",
    content: [{ type: "input_text", text: "维基百科结果：全双工（full-duplex）指通信双方可以同时发送和接收，比如打电话时两人可以同时说话。" }] }));
});
const speak = async (buf: Buffer) => { for (let at = 0; at < buf.length; at += 4800) { ws.send(JSON.stringify({ type: "input_audio.append", audio: buf.subarray(at, at + 4800).toString("base64") })); await sleep(100); } };
const silence = async (ms: number) => { for (let t = 0; t < ms; t += 100) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input_audio.append", audio: Buffer.alloc(4800).toString("base64") })); await sleep(100); } };
try {
  await new Promise<void>((ok, no) => { ws.once("open", () => ok()); ws.once("close", (c, r) => no(new Error(`closed ${c} ${r}`))); setTimeout(() => no(new Error("open timeout")), 15000); });
  ws.send(JSON.stringify({ type: "session.update", session: { instructions: "你是浏览器助手。闲聊直接用中文简短回答；需要操作网页或查资料时委派给客户端，等结果再口播。", audio: { output: { voice: "cove" } }, delegation: { type: "client" } } }));
  await silence(1500); await speak(chat); await silence(9000);
  await speak(act); await silence(15000);
} catch (e) { error ??= e instanceof Error ? e.message : String(e); }
ws.close();
const types = [...new Set(events.map(e => e.type))];
const delegations = events.filter(e => e.type === "delegation.created");
const transcripts = events.filter(e => e.type === "turn.done").map(e => (e as { turn: { role: string; transcript: string } }).turn);
const pass = !error && audioDeltas > 0 && delegations.length === 1 && transcripts.some(t => t.role === "assistant");
const result = { status: pass ? "PASS" : "FAIL", error, http, audioDeltas, types, transcripts, delegations, dependency: "real ChatGPT login (pi openai-codex); Node WebSocket; delegation result is a fixed fake text; not extension acceptance" };
await writeFile(join(out, "result.json"), JSON.stringify({ ...result, events }, null, 2));
console.log(JSON.stringify({ ...result, out }, null, 1));
if (!pass) process.exitCode = 1;
