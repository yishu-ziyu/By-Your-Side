/**
 * GPT-Live 免按键语音：真实隔离扩展 + 真实 GPT-Live + 真实主模型（ChatGPT 登录）。
 *   npx tsx scripts/acceptance/real-path/gpt-live-voice.mts --headless                     # 闲聊、查维基、重复委派、插话
 *   npx tsx scripts/acceptance/real-path/gpt-live-voice.mts --headless --case=no-login     # 没用 ChatGPT 登录：说明原因、不连接
 *   npx tsx scripts/acceptance/real-path/gpt-live-voice.mts --headless --case=api-key      # 存的是 API key 而不是登录：同上
 *   npx tsx scripts/acceptance/real-path/gpt-live-voice.mts --headless --case=barge-result # 播报任务结果时插话
 *   加 --model=provider/model：选择执行任务的模型；语音仍独立使用 ChatGPT 登录。
 *   加 --fast-model=provider/model：在隔离配置里选择快速模型；NO_STALL=1 只跳过后台阻塞，保留完整六句与结果检查。
 *   --case=long-result：真实维基长回答、完整开头与侧栏提示、真实结果音频。
 *   --case=current-page：真实 wikipedia.org 标题与英语、日语、西班牙语入口。
 *   --case=handoff：先约定“那个技术”指逆向工程，再用真实语音请求维基查询。
 *   --case=host-gate：关掉 GPT-Live 的委派、让它只会口头答应（复现「嘴上说做了、页面没动」），用户要标出段落时宿主自己接下、真的标出来并念出结果。
 *   --case=reading：只用语音读中文维基文章：标出感兴趣的段落、去别的网站接着查、记下来、回到原文；每步只记用户看得到的结果，一步没过也走完，看清断在哪几处。
 *   --case=server-error：人工注入服务错误，只证明故障处理，不是真服务失败。
 *   外语名称/音译和中文覆盖率只记录人工复核证据；数字仍自动核对。
 *   加 --extra-fact：回传时多加一个假事实，播报核对必须失败（反证）
 * 麦克风是设备静音与脚本放音混合的一路流：脚本何时放音就是「用户何时开口」，插话能放在播报中途。
 * 判据只看用户能观察到的：侧栏收到的远端声音、数据通道上的转写与委派、网络请求、导出的任务记录。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, exportDiagnosticsViaSettings, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { DEFAULT_TEST_MODEL, loadModelPlan, modelStorageItems } from "./inproc-config.mts";

requireHeadless();
const caseName = process.argv.find((a) => a.startsWith("--case="))?.slice(7) ?? "main";
assert.ok(["main", "api-key", "no-login", "barge-result", "long-result", "current-page", "server-error", "handoff", "page-context", "followup", "reading", "host-gate"].includes(caseName), `未知用例：${caseName}`);
const model = process.argv.find((a) => a.startsWith("--model="))?.slice(8) ?? DEFAULT_TEST_MODEL;
assert.match(model, /^[^/]+\/.+$/, "--model 需要 provider/model");
const fastModel = process.argv.find((a) => a.startsWith("--fast-model="))?.slice(13);
if (fastModel) assert.match(fastModel, /^[^/]+\/.+$/, "--fast-model 需要 provider/model");
const longResult = caseName === "long-result", currentPage = caseName === "current-page", serverError = caseName === "server-error", handoff = caseName === "handoff";
const pageContext = caseName === 'page-context';
const followup = caseName === 'followup';
const reading = caseName === 'reading' || caseName === 'host-gate';
const hostGate = caseName === 'host-gate';
const ARTICLE = 'https://zh.wikipedia.org/zh-cn/%E9%80%86%E5%90%91%E5%B7%A5%E7%A8%8B';
const apiKey = process.argv.includes("--case=api-key"), noLogin = apiKey || process.argv.includes("--case=no-login"), bargeResult = process.argv.includes("--case=barge-result");
const extraFact = process.argv.includes("--extra-fact") ? "另外，全双工技术最早由爱迪生在1873年提出。" : "";
const VOICE_MODEL = "gpt-live-1-codex";
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-gpt-live-voice${caseName !== "main" ? `-${caseName}` : extraFact ? "-extra-fact" : ""}`);
await mkdir(out, { recursive: true });

/** 用 macOS say 合成一句话，返回 base64 WAV。 */
const speech = async (text: string, file: string) => {
  const cache = join(REPO,'out/voice-audio-cache'); await mkdir(cache,{recursive:true});
  const key = createHash('sha256').update('Tingting/LEI16@48000/'+text).digest('hex');
  const cached = join(cache,key+'.wav'), path = join(out,file);
  let bytes = await readFile(cached).catch(()=>null);
  if (!bytes) { execFileSync('say',['-v','Tingting','-o',path,'--data-format=LEI16@48000',text]); bytes=await readFile(path); await writeFile(cached,bytes); }
  else await writeFile(path,bytes);
  return bytes.toString('base64');
};
const CHAT = "你好，给我讲一个长一点的小故事吧。", ASK = "帮我去维基百科查一下全双工这个词。", BARGE = "等一下，先停一下。";
const taskAsk = longResult ? "帮我去维基百科查一下全双工。请先用一句简短的完整句子给出结论，不要标题。然后详细解释定义、工作方式、与半双工和单工的区别、实际应用、优缺点和来源，至少一千二百字。不要生成文件或附件，直接在侧栏的回答正文里完整写出全部内容，不要只给摘要。" : currentPage ? "请查看我当前打开的页面，告诉我页面标题，以及英语、日语、西班牙语这三个语言入口分别叫什么。" : handoff ? "现在通过维基百科查一下刚才那个技术，用两句话介绍。" : ASK;
const topicAsk = "先不要查网页，我们先约定，接下来我说的那个技术是逆向工程，先记住这个话题。";
const voices = { chat: await speech(CHAT, "chat.wav"), ask: await speech(taskAsk, "ask.wav"), barge: await speech(BARGE, "barge.wav"), topic: handoff ? await speech(topicAsk, "topic.wav") : "", pageName: pageContext ? await speech('我现在打开的网页叫什么？', 'page-name.wav') : '' };

/** 数字自动核对；外语可能被转写为音译，不能用拼写差异判错。 */
function spokenCheck(spoken: string, source: string) {
  const plain = (t: string) => t.replace(/[\s\p{P}]/gu, "").toLowerCase();
  const src = plain(source);
  const missing = (spoken.match(/\d+(\.\d+)?/g) ?? []).filter((t) => !src.includes(t.toLowerCase()));
  const sentences = spoken.split(/[。！？!?]/).map((s) => s.trim()).filter((s) => plain(s).length >= 6).map((s) => {
    const p = plain(s), grams = [...Array(Math.max(0, p.length - 1)).keys()].map((i) => p.slice(i, i + 2));
    return { sentence: s, coverage: +(grams.filter((g) => src.includes(g)).length / Math.max(1, grams.length)).toFixed(2) };
  });
  return { missing, foreignNamesManualReview: { required: true, note: "外语名称和音译需人工核对；这里没有通用音译判定。" }, lowCoverage: sentences.filter((s) => s.coverage < 0.3) };
}

/** 远端轨道在本地静音前的音量；此结果不是用户实际听到停声的延迟。 */
function stopAfter(g: { in: Ev[]; meter: Array<[number, number]> }, at: number) {
  const LOUD = 0.01, RUN = 40;
  const i = g.meter.findIndex(([t], k) => t >= at && g.meter.slice(k, k + RUN).length === RUN && g.meter.slice(k, k + RUN).every(([, r]) => r <= LOUD));
  const quietAt = i < 0 ? null : g.meter[i]![0];
  const heard = g.in.find((e) => e.type === "input_transcript.added" && e.at >= at)?.at ?? null;
  const kept = g.in.filter((e) => e.type === "output_transcript.added" && e.at > at + 1000 && (heard === null || e.at < heard + 3000)).map((e) => e.item?.text ?? "").join("");
  return { stopMs: quietAt && quietAt - at, transcriptMs: heard && heard - at, keptTalking: kept };
}

const plan = await loadModelPlan(model);
const voicePlan = model === DEFAULT_TEST_MODEL ? plan : await loadModelPlan(DEFAULT_TEST_MODEL);
const fastPlan = fastModel ? await loadModelPlan(fastModel) : null;

const site = createServer((_q, r) => r.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><title>语音练习页</title><h1>语音练习页</h1><p>这一页只用来放侧栏。</p>"));
await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
// 底下垫一路真实假麦克风设备（只有静音）：只用 AudioContext 造的流时，GPT-Live 收到结果后一直不播报（10-09 三次）；用设备流时正常。
const silence = Buffer.alloc(44 + 48000 * 2 * 600);
silence.write('RIFF',0);silence.writeUInt32LE(silence.length-8,4);silence.write('WAVEfmt ',8);
silence.writeUInt32LE(16,16);silence.writeUInt16LE(1,20);silence.writeUInt16LE(1,22);
silence.writeUInt32LE(48000,24);silence.writeUInt32LE(96000,28);silence.writeUInt16LE(2,32);silence.writeUInt16LE(16,34);
silence.write('data',36);silence.writeUInt32LE(silence.length-44,40);await writeFile(join(out,'silence.wav'),silence);
const rp = await launchRealPath({ microphoneWav: join(out, "silence.wav") });
const evidence: Record<string, unknown> = {};
let error: string | null = null, panel = "";
type Ev = { at: number; delegation_item_id?: string; type: string; channel?: string; item?: { id?: string; text?: string; user_bidi_turn_id?:string }; turn?: { id?:string; role: string; transcript: string }; content?: Array<{ text: string }>; error?: { type?: string; code?: string; message?: string } };
const readRaw = async () => (await rp.evaluate(panel, "window.__gl")) as { in: Ev[]; out: Ev[]; meter: Array<[number, number]>; said: Array<{ at: number; ms: number }> };
const read = async () => {
  const g = await readRaw();
  const upstream = g.in.find((e) => e.type === "error");
  if (upstream) throw new Error(`GPT-Live 上游错误：${JSON.stringify(upstream)}`);
  return g;
};
const say = async (b64: string) => (await rp.evaluate(panel, `window.__say(${JSON.stringify(b64)})`)) as { at: number; ms: number };
const answerText = async () => String(await rp.evaluate(panel, `(() => {
  const answer = [...document.querySelectorAll("#messages .msg.assistant")].pop();
  if (!answer) return "";
  const copy = answer.cloneNode(true);
  copy.querySelectorAll(".answer-actions, .answer-panel").forEach(node => node.remove());
  return copy.textContent.trim();
})()`));
const calls: Array<{ url: string; status?: number }> = [], sockets: string[] = [];
const hostDiagnostics: unknown[] = [];

try {
  const blank = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "空白页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.navigate", { url: reading ? ARTICLE : currentPage || handoff || pageContext || followup ? "https://www.wikipedia.org/" : `http://127.0.0.1:${siteAddress(site).port}/` }, work);
  // 用户正读到「相关法律」这一节：滚到它，让它在屏幕上。
  if (reading) evidence.article = await until(async () => await rp.evaluate(work, `(() => { const h = document.getElementById("相关法律"); if (!h) return null; h.scrollIntoView({ block: "start" }); return { url: location.href, title: document.title }; })()`) || undefined, 30_000, "逆向工程条目与「相关法律」一节");
  if (currentPage || handoff || pageContext || followup) {
    const source = await until(async () => await rp.evaluate(work, `(() => {
      const languages = ["en", "ja", "es"].map((lang) => { const a = document.querySelector('a#js-link-box-' + lang); return a && { lang, text: a.innerText, url: a.href }; });
      return languages.every(Boolean) && { title: document.title, url: location.href, languages };
    })()`) || undefined, 30_000, "维基首页与三个语言入口");
    evidence.pageSource = source;
    await rp.screenshot(work, join(out, "wikipedia.png"));
  }
  panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  const items = { ...modelStorageItems(plan), "inproc_cred:openai-codex": voicePlan.credential, inproc_voice_model: VOICE_MODEL };
  if (fastPlan) {
    const { inproc_model_config: fastConfig, ...fastCredentials } = modelStorageItems(fastPlan);
    Object.assign(items, fastCredentials, { inproc_fast_model_config: fastConfig });
  }
  evidence.modelSelection = { main: model, fast: fastModel ?? null };
  if (apiKey) (items as Record<string, unknown>)["inproc_cred:openai-codex"] = { type: "api_key", key: "sk-not-a-chatgpt-login" };
  else if (noLogin) delete (items as Record<string, unknown>)["inproc_cred:openai-codex"];
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)})`);
  if (followup) { await rp.evaluate(panel, `localStorage.setItem('sideagent.thinkingDeep', '1')`); await rp.cdp.send('Page.reload', {}, panel); }
  // 网络记录：侧栏向 chatgpt.com 建通话；任何页面（含离屏页）开出的语音 WebSocket 都记下，查是否退回别的语音。
  const offscreen = await until(async () => (await rp.targets()).find((t) => t.url.endsWith("/inproc.html")), 10_000, "离屏页");
  const worker=(await rp.targets()).find(t=>t.type==='service_worker'&&t.url.endsWith('/background.js'));
  for (const s of [panel, await rp.attach(offscreen.targetId), ...(worker?[await rp.attach(worker.targetId)]:[])]) { await rp.cdp.send("Network.enable", {}, s); await rp.cdp.send('Runtime.enable',{},s); }
  rp.cdp.onEvent('Runtime.consoleAPICalled',(m:any)=>{const text=(m.params.args??[]).map((a:any)=>typeof a.value==='string'?a.value:'').join(' ');if(/\[(?:voice|voice-turn|voice-classifier)\]/u.test(text)){const record={at:Date.now(),text};hostDiagnostics.push(record);void appendFile(join(out,'host-diagnostics.jsonl'),JSON.stringify(record)+'\n');}});
  rp.cdp.onEvent("Network.requestWillBeSent", (m: any) => { if (/chatgpt\.com\/backend-api\/codex\/realtime/.test(m.params.request.url)) calls.push({ url: m.params.request.url }); });
  rp.cdp.onEvent("Network.responseReceived", (m: any) => { const c = calls.find((x) => x.url === m.params.response.url && x.status === undefined); if (c) c.status = m.params.response.status; });
  rp.cdp.onEvent("Network.webSocketCreated", (m: any) => sockets.push(m.params.url));
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "侧栏就绪");
  // 麦克风换成「设备静音 + 脚本放的语音」混合的一路流；数据通道收发、远端声音音量都在侧栏里记下（只观察，不改产品消息，--extra-fact 除外）。
  await rp.evaluate(panel, `(() => {
    const gl = window.__gl = { in: [], out: [], meter: [], said: [] }, ctx = new AudioContext({ sampleRate: 48000 }), mic = ctx.createMediaStreamDestination();
    const device = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => { ctx.createMediaStreamSource(await device(c)).connect(mic); return mic.stream; };
    window.__say = async (b64) => { await ctx.resume(); const buf = await ctx.decodeAudioData(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer);
      const src = ctx.createBufferSource(); src.buffer = buf; src.connect(mic); const at = Date.now(); src.start(); gl.said.push({ at, ms: Math.round(buf.duration * 1000) }); return { at, ms: Math.round(buf.duration * 1000) }; };
    const create = RTCPeerConnection.prototype.createDataChannel;
    RTCPeerConnection.prototype.createDataChannel = function (...a) { const dc = create.apply(this, a); window.__dc = dc;
      dc.addEventListener("message", (e) => { try { const m = JSON.parse(e.data); if (!/audio\\.(delta|append)$/.test(m.type)) gl.in.push({ at: Date.now(), ...m }); } catch {} });
      const send = dc.send.bind(dc); dc.send = (d) => { try { const m = JSON.parse(d); if (${JSON.stringify(extraFact)} && m.type === "delegation.context.append" && m.channel === "speakable") { m.content[0].text += ${JSON.stringify(extraFact)}; d = JSON.stringify(m); } gl.out.push({ at: Date.now(), ...m }); } catch {} return send(d); };
      this.addEventListener("track", (e) => { const an = ctx.createAnalyser(); ctx.createMediaStreamSource(new MediaStream([e.track])).connect(an); const b = new Float32Array(an.fftSize);
        setInterval(() => { an.getFloatTimeDomainData(b); gl.meter.push([Date.now(), +Math.sqrt(b.reduce((s, v) => s + v * v, 0) / b.length).toFixed(4)]); }, 20); });
      return dc; };
    return true; })()`);
  // 语音层不委派：建通话时去掉委派能力，并让它对操作请求只口头答应，宿主得自己接住。
  if (hostGate) await rp.evaluate(panel, `(() => { const real = window.fetch.bind(window); window.fetch = (url, init) => {
    if (String(url).includes('/realtime') && typeof init?.body === 'string') { try { const body = JSON.parse(init.body); if (body.session) { delete body.session.delegation; body.session.instructions = '你是浏览器助手的语音层，不能委派，也没有任何工具。用户要你操作网页时，口头答应一句就好。一律用中文，简短。'; init = { ...init, body: JSON.stringify(body) }; } } catch {} }
    return real(url, init); }; return true; })()`);
  await rp.click(panel, "#input");
  await rp.click(panel, ".voice-start");

  if (noLogin) {
    await sleep(8000);
    // 原因写在语音区状态下面一行，读整个侧栏文字。
    const status = String(await rp.evaluate(panel, "document.body.innerText"));
    Object.assign(evidence, { status, calls, sockets });
    assert.equal(calls.length, 0, "没用 ChatGPT 登录时不能向 chatgpt.com 建通话");
    assert.ok(!sockets.some((u) => /stepfun|realtime/.test(u)), "不能退回别的语音");
    assert.match(status, /ChatGPT|登录/, "侧栏说明要先用 ChatGPT 登录");
  } else {
    await until(async () => (await read()).in.some((e) => e.type === "session.started") || undefined, 30_000, "GPT-Live 连上");
    assert.ok(calls.length === 1 && calls[0]!.status === 201, `向 chatgpt.com 建通话一次并成功：${JSON.stringify(calls)}`);
    assert.ok(!sockets.some((u) => /stepfun/.test(u)), "没有连 StepFun");
    if (followup) {
      const replies: Array<{question:string;spoken:string;waitMs:number;at:number}> = [];
      evidence.dialogue = replies;
      const questions = ['你好', '这是什么网站呀', '我想了解一下逆向工程', '你就在这个网站里面查吧', '嗯。具体是什么脚本呢？在执行什么', '我想知道是什么脚本，它在执行什么的'];
      for (const [index, question] of questions.entries()) {
        console.log(`真实对话 ${index + 1}/${questions.length}：${question}`);
        const wav = await speech(question, `followup-${index}.wav`);
        const input = await say(wav);
        const userTurn = await until(async () => (await read()).in.find(e=>e.type==='turn.done'&&e.turn?.role==='user'&&e.at>input.at),60_000,'本轮原话已被服务完整接收');
        let replyAfter = userTurn.at;
        const delegated = (await read()).in.find(e => e.type === 'delegation.created' && e.item?.user_bidi_turn_id === userTurn.turn?.id);
        if (delegated) {
          // 网页任务进行中让后台卡住 17 秒（机器满载时实测后台 13 秒不回消息；心跳 5 秒一次、10 秒没回才换端口，17 秒一定触发）：
          // 侧栏会换端口，语音通话和任务结果都不能因此丢掉。
          if (index === 3 && !process.env.NO_STALL) {
            const sw = await rp.attach((await until(() => rp.serviceWorker(), 15_000, "service worker")).targetId);
            const stallAt = Date.now();
            await rp.evaluate(sw, `(() => { const end = Date.now() + 17000; while (Date.now() < end); return true; })()`, { timeoutMs: 30_000 });
            evidence.backgroundStall = { at: stallAt, ms: Date.now() - stallAt };
          }
          const delivery = await until(async () => (await read()).out.find(e => e.type === 'delegation.context.append' && e.delegation_item_id === delegated.item?.id && (e.channel === 'speakable' || e.channel === 'commentary' && e.content?.some(part => part.text?.includes('这句是闲聊')))), 120_000, '本轮正式回答，不能把开场应答当结果');
          const acknowledged=await until(async()=>(await read()).in.find(e=>e.type==='delegation.context.appended'&&e.delegation_item_id===delegated.item?.id&&e.at>=delivery.at),30_000,'服务确认收到本轮正式回答');
          replyAfter = acknowledged.at;
          if (index === 3) evidence.taskDelivery = delivery;
        }
        // 回答可能在结果送到前就开口、一口气说到结果之后：取送到之后才说完的第一轮，开场应答在那之前已说完。
        const completed = await until(async()=>(await read()).in.find(e=>e.type==='turn.done'&&e.turn?.role==='assistant'&&e.at>=replyAfter-100),150_000,'本轮回答完整结束');
        const assistant = (await read()).in.find(e=>e.type==='turn.created'&&e.turn?.id===completed.turn?.id)??completed;
        const spoken=completed.turn?.transcript??'';
        const firstAudio=(await read()).meter.find(([at,rms])=>at>replyAfter-500&&rms>0.01)??[assistant.at,0];
        await sleep(2500);
        replies.push({question,spoken,waitMs:firstAudio[0]-(input.at+input.ms),at:input.at});
        await rp.screenshot(panel, join(out, `followup-${index}.png`));
        console.log(JSON.stringify(replies.at(-1)));
        assert.doesNotMatch(spoken, /请求超时|这句话?还没执行|分流.{0,8}(失败|没有完成)/u, '每一句都得到正式回答，不能把分类失败提示算作完成');
        if(index===1)assert.match(spoken,/维基|Wikipedia/i,'认出当前网站');
        if(index===3){
          assert.match(await answerText(),/逆向工程|reverse engineering/i,'前文主题交给真实网页任务');
          // 选中的这一轮必须真把结果说出来：说出的话里至少三成两字词来自送回的结果，不能只是提前开口的闲聊。
          const pairs=(t:string)=>{const c=t.replace(/[\s\p{P}]/gu,'');return new Set([...c].slice(1).map((ch,i)=>c[i]+ch));};
          const said=pairs(spoken),result=pairs((evidence.taskDelivery as {content?:Array<{text?:string}>}|undefined)?.content?.map(p=>p.text??'').join('')??'');
          const overlap=said.size?[...said].filter(p=>result.has(p)).length/said.size:0;
          evidence.taskSpokenOverlap=overlap;
          assert.ok(overlap>=0.3,`这一轮播报说出了任务结果（重合 ${overlap.toFixed(2)}）`);
        }
      }
      await rp.click(panel,'.voice-start');
      const exported=await exportDiagnosticsViaSettings(rp,rp.extensionId,join(out,'downloads'));
      const traces=String((exported as {traces?:string}).traces??'').split('\n').filter(Boolean).map(l=>JSON.parse(l));
      await writeFile(join(out,'trace.json'),JSON.stringify(traces,null,2));
      const taskStart=traces.find(t=>t.type==='run_start'&&Date.parse(t.time)>=replies[3]!.at);
      const run=traces.filter(t=>t.runId===taskStart?.runId);
      const end=run.find(t=>t.type==='agent_end');
      const firstTool=run.find(t=>t.type==='tool_execution_start');
      evidence.timing={taskMs:taskStart&&end?Date.parse(end.time)-Date.parse(taskStart.time):null,firstActionMs:taskStart&&firstTool?Date.parse(firstTool.time)-Date.parse(taskStart.time):null};
      evidence.realPages=(await rp.targets()).filter(t=>t.type==='page'&&/^https?:/.test(t.url)).map(t=>({url:t.url,title:t.title}));
      for(const reply of replies.slice(4)){
        assert.match(reply.spoken,/读取|读了|提取|获取|抓取|搜索|检索|查询|抓.{0,5}(内容|正文)|没有.{0,6}脚本/,'脚本追问解释具体做了什么，不只重复任务结论');
        assert.doesNotMatch(reply.spoken,/还有.{0,15}未完成|执行遇到阻碍|没做成|还没做完|脚本.{0,8}没完成/,'成功后的追问不再被旧错误占据');
      }
      assert.ok(!traces.some(t=>t.type==='tool_execution_start'&&Date.parse(t.time)>=replies[4]!.at),'解释追问不能重新操作网页');
      if (fastModel) {
        const plans = traces.filter(t => t.type === 'side_call' && t.data?.purpose === 'voice_plan');
        const observedModels = [...new Set(plans.map(t => t.data?.model))];
        evidence.voicePlanRouting = { expected: fastModel, count: plans.length, observedModels };
        assert.ok(plans.length > 0, '六句对话必须实际触发语音计划判断，零条记录不能算快速模型通过');
        assert.ok(plans.every(t => t.data?.model === fastModel), `语音计划必须使用已配置快速模型 ${fastModel}；实际 ${observedModels.join(', ')}`);
      }
      const stall = evidence.backgroundStall as { at: number } | undefined;
      if (!process.env.NO_STALL) {
        assert.ok(stall, '网页任务进行中确实让后台卡住过');
        const after = hostDiagnostics.filter((d): d is { at: number; text: string } => (d as { at: number }).at >= stall.at).map(d => d.text);
        assert.ok(after.some(t => t.includes('panel_port_replaced')) && after.some(t => t.includes('voice_host_reattached')), '后台卡住时侧栏换了端口，并用原来的语音会话接上');
      }
      assert.equal(calls.length, 1, '六句对话沿用原来的通话，没有挂断重拨');
      console.log('真实对话复验完成');
    } else if (hostGate) {
      const text = '这篇文章里讲法律的那一段挺有意思的，你帮我在页面上标出来。';
      const input = await say(await speech(text, 'host-gate.wav'));
      const spokenEnd = input.at + input.ms;
      const userTurn = await until(async () => (await read()).in.find(e => e.type === 'turn.done' && e.turn?.role === 'user' && e.at > input.at), 60_000, '这句已被服务完整接收');
      const appended = await until(async () => (await read()).out.find(e => e.type === 'session.context.append' && e.channel === 'speakable' && e.at > userTurn.at), 120_000, '宿主把结果送到会话层');
      const done = await until(async () => (await read()).in.find(e => e.type === 'turn.done' && e.turn?.role === 'assistant' && e.at >= appended.at), 60_000, '结果念完');
      await sleep(2000);
      const g = await read();
      await rp.screenshot(work, join(out, 'host-gate-page.png'));
      await rp.screenshot(panel, join(out, 'host-gate-panel.png'));
      await rp.click(panel, '.voice-start').catch(() => {});
      const exported = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(out, 'downloads'));
      const traces = String((exported as { traces?: string }).traces ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l)) as Array<{ time: string; type: string; data?: { toolName?: string; isError?: boolean; text?: string } }>;
      await writeFile(join(out, 'trace.json'), JSON.stringify(traces, null, 2));
      const sent = appended.content?.map(c => c.text).join('') ?? '';
      Object.assign(evidence, {
        heard: userTurn.turn?.transcript, delegations: g.in.filter(e => e.type === 'delegation.created').length, sent,
        spoken: done.turn?.transcript ?? '', firstReply: g.in.filter(e => e.type === 'output_transcript.added' && e.at > spokenEnd && e.at < appended.at).map(e => e.item?.text ?? '').join(''),
        resultMs: appended.at - spokenEnd, tasks: traces.filter(t => t.type === 'run_start').map(t => t.data?.text),
      });
      console.log(JSON.stringify(evidence));
      assert.equal(evidence.delegations, 0, '语音层确实没有委派');
      assert.ok(traces.some(t => t.type === 'run_start'), '宿主自己开了任务');
      assert.ok(traces.some(t => t.type === 'tool_execution_end' && t.data?.toolName === 'mark' && !t.data?.isError), '页面上真的标出来了');
      assert.match(sent + String(evidence.spoken), /标/, '念出的结果说标好了');
    } else if (reading) {
      type Tab = { url: string; title: string; active: boolean };
      type Step = { key: string; question: string; heard: string | null; delegated: boolean; channel: string | null; spoken: string; waitMs: number | null; resultMs: number | null; doneMs: number | null; at: number; end: number; tabs: Tab[] | null; error: string | null };
      const turns = [
        { key: 'mark', text: '这篇文章里讲法律的那一段挺有意思的，你帮我在页面上标出来。' },
        { key: 'explore', text: '那你去别的网站帮我查查，现实里有没有因为逆向工程打官司的例子。' },
        { key: 'record', text: '把这个例子和刚才那段的要点帮我记下来。' },
        { key: 'back', text: '好，回到刚才那篇文章吧。' },
      ];
      const steps: Step[] = [];
      evidence.reading = steps;
      const tabs = async () => await rp.evaluate(panel, `chrome.tabs.query({}).then(ts => ts.filter(t => /^https?:/.test(t.url ?? "")).map(t => ({ url: t.url, title: t.title, active: t.active })))`) as Tab[];
      const shoot = async (name: string) => {
        for (const [i, t] of (await rp.targets()).filter(t => t.type === 'page' && /^https?:/.test(t.url)).entries()) await rp.screenshot(await rp.attach(t.targetId), join(out, `${name}-page-${i}.png`)).catch(() => {});
      };
      for (const [index, turn] of turns.entries()) {
        console.log(`读文章 ${index + 1}/${turns.length}：${turn.text}`);
        const input = await say(await speech(turn.text, `reading-${turn.key}.wav`));
        const spokenEnd = input.at + input.ms;
        const step: Step = { key: turn.key, question: turn.text, heard: null, delegated: false, channel: null, spoken: '', waitMs: null, resultMs: null, doneMs: null, at: input.at, end: 0, tabs: null, error: null };
        steps.push(step);
        try {
          const userTurn = await until(async () => (await read()).in.find(e => e.type === 'turn.done' && e.turn?.role === 'user' && e.at > input.at), 60_000, '本轮原话已被服务完整接收');
          step.heard = userTurn.turn?.transcript ?? null;
          let replyAfter = userTurn.at;
          const delegated = await until(async () => (await read()).in.find(e => e.type === 'delegation.created' && e.item?.user_bidi_turn_id === userTurn.turn?.id), 8_000, '委派').catch(() => undefined);
          if (delegated) {
            step.delegated = true;
            const delivery = await until(async () => (await read()).out.find(e => e.type === 'delegation.context.append' && e.delegation_item_id === delegated.item?.id && (e.channel === 'speakable' || e.channel === 'commentary' && e.content?.some(part => part.text?.includes('这句是闲聊')))), 300_000, '本轮正式回答');
            step.channel = delivery.channel ?? null;
            replyAfter = (await until(async () => (await read()).in.find(e => e.type === 'delegation.context.appended' && e.delegation_item_id === delegated.item?.id && e.at >= delivery.at), 30_000, '服务确认收到本轮回答')).at;
            step.resultMs = replyAfter - spokenEnd;
          }
          const completed = await until(async () => (await read()).in.find(e => e.type === 'turn.done' && e.turn?.role === 'assistant' && e.at >= replyAfter - 100), 150_000, '本轮回答完整结束');
          step.spoken = completed.turn?.transcript ?? '';
          const firstAudio = (await read()).meter.find(([at, rms]) => at > spokenEnd && rms > 0.01);
          step.waitMs = firstAudio ? firstAudio[0] - spokenEnd : null;
          step.doneMs = completed.at - spokenEnd;
        } catch (e) {
          step.error = e instanceof Error ? e.message : String(e);
        }
        step.end = Date.now();
        step.tabs = await tabs().catch(() => null);
        await shoot(`reading-${turn.key}`);
        await rp.screenshot(panel, join(out, `reading-${turn.key}-panel.png`)).catch(() => {});
        console.log(JSON.stringify({ ...step, tabs: step.tabs?.map(t => `${t.active ? '*' : ''}${t.url}`) }));
        await sleep(2500);
      }
      // 每句照真人节奏在回答说完后就接着说；最后一句之后等任务真的停下（停止键消失 3 秒），再看浏览器停在哪。
      let idleSince = 0;
      const settledAt = await until(async () => {
        if (await rp.evaluate(panel, `document.querySelector("#send-btn")?.classList.contains("stopping")`)) { idleSince = 0; return undefined; }
        idleSince ||= Date.now();
        return Date.now() - idleSince >= 3000 ? Date.now() : undefined;
      }, 240_000, '最后一句的任务停下').catch(() => null);
      const finalTabs = await tabs().catch(() => null);
      evidence.readingFinal = { settledAt, tabs: finalTabs };
      await shoot('reading-final');
      await rp.screenshot(panel, join(out, 'reading-final-panel.png')).catch(() => {});
      await rp.click(panel, '.voice-start').catch(() => {});
      const exported = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(out, 'downloads'));
      const traces = String((exported as { traces?: string }).traces ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l)) as Array<{ time: string; type: string; runId?: string; data?: { toolName?: string; args?: unknown; isError?: boolean; text?: string } }>;
      await writeFile(join(out, 'trace.json'), JSON.stringify(traces, null, 2));
      // 一句的窗口到下一句开口为止；排队的任务会落进后面的窗口，所以按任务原话另取。
      const during = (s: Step) => { const next = steps[steps.indexOf(s) + 1]?.at ?? settledAt ?? Date.now(); return traces.filter(t => Date.parse(t.time) >= s.at && Date.parse(t.time) < next); };
      const plain = (t: string) => t.replace(/[\s\p{P}]/gu, '');
      const runOf = (s: Step) => { const ids = new Set(traces.filter(t => t.type === 'run_start' && s.heard && plain(t.data?.text ?? '') === plain(s.heard)).map(t => t.runId)); return traces.filter(t => ids.has(t.runId)); };
      const succeeded = (events: typeof traces, tool: string) => events.some(t => t.type === 'tool_execution_end' && t.data?.toolName === tool && !t.data?.isError);
      const READS = ['snapshot', 'read_element', 'read_elements', 'fetch', 'tabs', 'navigate', 'scroll'];
      const wrote = (events: typeof traces) => events.some(t => t.type === 'tool_execution_start' && !READS.includes(t.data?.toolName ?? '') && !(t.data?.toolName === 'user_memory' && /"action":"(history|search)"/.test(JSON.stringify(t.data?.args))));
      const toolsIn = (s: Step) => during(s).filter(t => t.type === 'tool_execution_start').map(t => ({ tool: t.data?.toolName ?? '', args: JSON.stringify(t.data?.args ?? null).slice(0, 300) }));
      const failedIn = (s: Step) => during(s).filter(t => t.type === 'tool_execution_end' && t.data?.isError).map(t => t.data?.toolName ?? '');
      evidence.readingTools = steps.map(s => ({ key: s.key, tools: toolsIn(s), failed: failedIn(s) }));
      const isArticle = (url: string) => /^https:\/\/zh\.wikipedia\.org\/[^#]*(%E9%80%86%E5%90%91%E5%B7%A5%E7%A8%8B|逆向工程)/.test(url);
      const [mark, explore, record] = steps as [Step, Step, Step, Step];
      const claimsRecorded = /记下来了|记好了|已记录|已保存|保存好了|记上了/.test(record.spoken);
      const checks = [
        { name: '标出感兴趣的段落，并且说标好了', pass: !mark.error && succeeded(during(mark), 'mark') && !/没法|无法|不能|做不到|查找/.test(mark.spoken), review: '标在哪一段：看 reading-mark-page-*.png' },
        { name: '去别的网站接着查', pass: !explore.error && (!!explore.tabs?.some(t => !/wikipedia\.org/.test(t.url)) || toolsIn(explore).some(t => /navigate|tabs/.test(t.tool) && /https?:\/\/(?![a-z-]+\.wikipedia\.org)/.test(t.args))) && /案|诉|官司|法院|判/.test(explore.spoken), review: '说出的例子是否来自打开的网页：看 reading-explore-panel.png' },
        { name: '原文还在，没被助手的查询顶掉', pass: !!explore.tabs?.some(t => isArticle(t.url)), review: null },
        { name: '说「记下来了」时真的写进去了', pass: claimsRecorded ? !record.error && wrote(runOf(record)) : null, review: claimsRecorded ? null : '没说记好：人工看记到了哪里，有没有让你自己发文字' },
        { name: '回到原文', pass: !!finalTabs?.some(t => t.active && isArticle(t.url)), review: '阅读位置和标注还在不在：看 reading-final-page-*.png' },
      ];
      evidence.readingChecks = checks;
      for (const c of checks) console.log(`${c.pass === null ? '待人工' : c.pass ? '通过' : '没过'}  ${c.name}${c.review ? `（${c.review}）` : ''}`);
      const broken = checks.filter(c => c.pass === false).map(c => c.name);
      assert.deepEqual(broken, [], `只用语音读文章，没过的步骤：${broken.join('、')}`);
    } else if (serverError) {
      const injected = { type: "error", error: { type: "invalid_request_error", code: "invalid_value", message: "Context append text must not exceed 500 tokens." } };
      evidence.faultInjection = { synthetic: true, event: injected, note: "人工数据通道事件，不是真服务失败。" };
      await rp.evaluate(panel, `window.__dc.dispatchEvent(new MessageEvent("message", { data: ${JSON.stringify(JSON.stringify(injected))} }))`);
      const view = await until(async () => {
        const v = await rp.evaluate(panel, `({ status: document.querySelector(".voice-state")?.innerText, detail: document.querySelector(".voice-state-detail")?.innerText, connection: window.__dc.readyState })`) as { status: string; detail: string; connection: string };
        return /失败|出错|异常|中断|无法|不可用/.test(v.status) && v.connection === "closed" ? v : undefined;
      }, 5000, "侧栏明确失败并关闭通话");
      evidence.failureView = view;
      assert.doesNotMatch(view.status, /在听/, "失败后不能仍显示在听");
      assert.match(view.detail, /语音服务.*失败|未能播报/, "侧栏说明语音处理失败，而非让用户重新描述需求");
      assert.match(view.detail, /后台任务不受影响/, "不把语音失败说成任务已经停止");
      await rp.screenshot(panel, join(out, "injected-error.png"));
    } else if (pageContext) {
      const replies: Array<{ title: string; spoken: string }> = [];
      const otherWindow = Number(await rp.evaluate(panel, `chrome.windows.create({ url: 'https://example.org/', focused: false }).then(window => window.id)`));
      await rp.evaluate(panel, `chrome.sidePanel.open({ windowId: ${otherWindow} })`, { userGesture: true });
      await until(async () => (await rp.targets()).filter(t => t.type === 'page' && t.url.endsWith('/sidepanel.html')).length >= 2 || undefined, 10_000, '两个窗口都有侧栏');
      evidence.twoPanels = true;
      for (const [title, url, match] of [
        ['Wikipedia', 'https://www.wikipedia.org/', /维基百科|Wikipedia/i],
        ['Example Domain', 'https://example.com/', /Example\s*Domain|示例域名|示例域/i],
      ] as const) {
        await rp.cdp.send('Page.navigate', { url }, work);
        await until(async () => String(await rp.evaluate(work, 'document.title')).includes(title) || undefined, 30_000, `${title}加载`);
        await until(async () => (await read()).out.some(e => e.type === 'session.context.append' && e.content?.some(c => c.text.includes(title))) || undefined, 10_000, '当前页面背景已同步');
        const at = (await say(voices.pageName)).at;
        const spoken = await until(async () => {
          const text = (await read()).in.filter(e => e.type === 'output_transcript.added' && e.at > at).map(e => e.item?.text ?? '').join('');
          return match.test(text) ? text : undefined;
        }, 30_000, '真实语音说出当前页面名');
        replies.push({ title, spoken });
        await rp.screenshot(panel, join(out, `${title.split(' ')[0]}-context.png`));
        const pageUpdates = (await read()).out.filter(e => e.type === 'session.context.append').flatMap(e => e.content?.map(c => c.text) ?? []);
        assert.ok(!pageUpdates.some(text => text.includes('example.org')), '另一窗口的页面不能进入这次通话背景');
        await sleep(2500);
      }
      await rp.evaluate(panel, `chrome.windows.remove(${otherWindow})`);
      evidence.pageContextReplies = replies;
    } else {
      if (handoff) {
        const topicAt = (await say(voices.topic)).at;
        evidence.handoffTopic = { text: topicAsk, at: topicAt };
        await until(async () => (await read()).in.find((e) => e.type === "output_transcript.added" && e.at > topicAt), 30_000, "话题约定的真实回复");
        const topicAudio = await until(async () => (await read()).meter.find(([at, rms]) => at > topicAt && rms > 0.01), 30_000, "话题约定回复出声");
        await until(async () => {
          const g = await read();
          return g.meter.some(([at], k) => at > topicAudio[0] && g.meter.slice(k, k + 75).length === 75 && g.meter.slice(k, k + 75).every(([, rms]) => rms <= 0.01)) || undefined;
        }, 30_000, "话题约定回复播完");
        const g = await read();
        const view = await rp.evaluate(panel, `({ text: document.body.innerText, taskCount: document.querySelectorAll("#messages details.run-steps").length })`) as { text: string; taskCount: number };
        const pages = (await rp.targets()).filter((t) => t.type === "page" && /^https?:/.test(t.url)).map((t) => t.url);
        Object.assign(evidence, { handoffFirstReply: g.in.filter((e) => e.at >= topicAt && e.type === "output_transcript.added"), handoffBeforeRequest: { view, pages, at: Date.now() } });
        await rp.screenshot(panel, join(out, "handoff-topic.png"));
        assert.equal(view.taskCount, 0, "只约定话题时，侧栏不能开始网页任务");
        assert.ok(pages.length > 0 && pages.every((url) => /^https:\/\/(www\.)?wikipedia\.org\/?$/.test(url)), "只约定话题时，浏览器保留维基首页、不打开查询页面");
      }
      if (!longResult && !currentPage && !handoff) {
        // R2 闲聊
        await sleep(1500);
        const chatAt = (await say(voices.chat)).at;
        // 助手这一轮的 turn.done 要等下一轮开始才到，所以看回答转写。
        await until(async () => (await read()).in.find((e) => e.type === "output_transcript.added" && e.at > chatAt), 30_000, "闲聊回答");
        // 闲聊回答出声 1.2 秒后插话：对照 GPT-Live 自己的回答能不能被打断。
        const chatVoice = await until(async () => (await read()).meter.find(([at, rms]) => at > chatAt + 1000 && rms > 0.01), 30_000, "闲聊回答出声");
        await sleep(Math.max(0, chatVoice[0] + 1200 - Date.now()));
        const chatBargeAt = (await say(voices.barge)).at;
        await sleep(6000);
        evidence.chatBargeIn = stopAfter(await read(), chatBargeAt);
        const chatStop = (evidence.chatBargeIn as { stopMs: number | null }).stopMs;
        assert.ok(chatStop !== null && chatStop <= 500, `闲聊插话后，远端轨道0.5秒内静音（不代表本地听感）（实际 ${chatStop ?? "没停"} 毫秒）`);
        const afterChat = (await read()).in.filter((e) => e.at > chatAt);
        evidence.chat = { reply: afterChat.filter((e) => e.type === "output_transcript.added").map((e) => e.item?.text ?? "").join(""), delegations: afterChat.filter((e) => e.type === "delegation.created").length };
        assert.equal(evidence.chat && (evidence.chat as { delegations: number }).delegations, 0, "闲聊不委派");
      }
      // R3 查维基：一次委派、重复送达也只开一个任务、回传的是任务回答
      const ask = await say(voices.ask);
      const askAt = ask.at;
      // 长请求本身就要说约 30 秒：从说完起算等待，模型听完整句再委派才是对的。
      const delegation = await until(async () => (await read()).in.find((e) => e.type === "delegation.created" && e.at > askAt), ask.ms + 30_000, "委派");
      if (!handoff && !process.env.NO_DUP) await rp.evaluate(panel, `window.__dc.dispatchEvent(new MessageEvent("message", { data: ${JSON.stringify(JSON.stringify({ ...delegation, at: undefined }))} }))`);
      const appended = await until(async () => (await read()).out.find((e) => e.type === "delegation.context.append" && e.channel === "speakable" && e.at >= askAt), 180_000, "任务结果送回 GPT-Live");
      if (handoff) evidence.handoffRequest = { text: taskAsk, at: askAt, delegation };
      const sent = appended.content?.map((c) => c.text).join("") ?? "";
      const answer = await answerText();
      Object.assign(evidence, { sent, answer });
      if (longResult) evidence.resultAcknowledged = await until(async () => (await read()).in.find((e) => e.type === "delegation.context.appended" && e.at >= appended.at), 30_000, "真实服务确认收到结果");
      const LOUD = 0.01;
      const playing = await until(async () => (await read()).meter.find(([at, rms]) => at > appended.at && rms > LOUD), 30_000, "结果开始出声");
      evidence.resultAudio = { at: playing[0], rms: playing[1], observation: "侧栏收到的远端轨道音频，非真人试听" };
      const plainText = (t: string) => t.replace(/[\s\p{P}]/gu, "");
      if (longResult) {
        const opening = sent.match(/先说开头[：:]\s*([\s\S]*?)\s*完整内容在侧栏[。.]?$/)?.[1]?.trim() ?? "";
        Object.assign(evidence, { sent, answer, sentUtf8Bytes: Buffer.byteLength(sent), opening });
        assert.ok(answer.replace(/\s/g, "").length >= 800, "侧栏保留足够长的详细回答，不能只返回短摘要");
        assert.ok(opening.length >= 6 && /[。！？.!?]$/.test(opening), "语音回传保留完整句子，不切半句");
        assert.ok(plainText(answer).startsWith(plainText(opening)), "回传开头逐字来自侧栏回答的开头");
        assert.ok(sent.length < answer.length, "语音回传有边界，侧栏仍保留全文");
        evidence.serviceAcceptance = "字节数仅留证；真实服务未报错且结果音频出现才证明服务接收。";
      } else {
        const resultText = sent.replace(/^先说开头[：:]\s*/, '').replace(/\s*完整内容在侧栏[。.]?$/, '');
        assert.ok(plainText(answer).includes(plainText(resultText).slice(0, 40)), "送回 GPT-Live 的是侧栏里这次任务的回答，长答允许明确标出的摘读");
      }
      if (handoff) {
        assert.match(answer, /逆向工程|reverse[ -]+engineering/i, "第二轮侧栏回答正确解析刚才约定的技术");
        evidence.handoffResultPages = (await rp.targets()).filter((t) => t.type === "page" && /^https?:/.test(t.url)).map((t) => ({ url: t.url, title: t.title }));
      }
      if (currentPage) {
        assert.match(answer, /Wikipedia|维基百科/i, "回答包含真实页面标题");
        for (const language of [/English|英语|英文/i, /日本語|日语|日文/, /Español|Spanish|西班牙语|西语/i]) assert.match(answer, language, "回答包含所问语言入口");
        evidence.currentPage = { answer, taskAsk, source: evidence.pageSource };
      }
      if (bargeResult) {
        // R4 播报结果时插话：结果出声 1.2 秒后开口。
        await sleep(Math.max(0, playing[0] + 1200 - Date.now()));
        const bargeAt = (await say(voices.barge)).at;
        await sleep(6000);
        const g = await read();
        const bargeIn = { ...stopAfter(g, bargeAt), cleared: g.in.some((e) => e.type === "output_audio_buffer.cleared" && e.at >= bargeAt) };
        Object.assign(evidence, { sent, answer, bargeIn });
        assert.ok(bargeIn.stopMs !== null && bargeIn.stopMs <= 500, `结果播报插话后，远端轨道0.5秒内静音（不代表本地听感）（实际 ${bargeIn.stopMs ?? "没停"} 毫秒）`);
      } else {
        // R3 让结果完整播完（连续 1.5 秒静音），再核对整段播报。
        const done = await until(async () => { const g = await read(); const i = g.meter.findIndex(([t], k) => t > playing[0] && g.meter.slice(k, k + 75).length === 75 && g.meter.slice(k, k + 75).every(([, r]) => r <= LOUD)); return i < 0 ? undefined : g.meter[i]![0]; }, 60_000, "结果播完");
        const g = await read();
        const spoken = g.in.filter((e) => e.type === "output_transcript.added" && e.at > appended.at && e.at <= done + 500).map((e) => e.item?.text ?? "").join("");
        const check = spokenCheck(spoken, answer);
        Object.assign(evidence, { userWords: (delegation as unknown as { item?: unknown }).item, sent, answer, spoken, check });
        assert.ok(spoken.length > 10, "结果确实播报了");
        if (longResult) {
          assert.match(spoken, /全双工|full[ -]?duplex/i, "真实播报必须介绍查到的技术，不能只确认收到请求");
          assert.match(spoken, /同时|同一时间/, "真实播报包含全双工同时通信的核心结论");
          assert.match(spoken, /(?:完整|详细|全文)[\s\S]*(?:侧栏|侧边栏)|(?:侧栏|侧边栏)[\s\S]*(?:完整|详细|全文)/, "真实播报告知完整内容在侧栏");
        }
        if (handoff) assert.match(spoken, /逆向工程|reverse[ -]+engineering/i, "真实播报介绍约定的技术，而非仅确认请求");
        assert.deepEqual(check.missing, [], `播报里有回答中没有的数字：${check.missing.join("、")}`);
      }
      const answerAfterPlayback = await answerText();
      evidence.answerAfterPlayback = answerAfterPlayback;
      assert.equal(answerAfterPlayback, answer, "播报后侧栏仍保留完整任务回答");
      await rp.click(panel, ".voice-start").catch(() => {});
      await sleep(2000);
      const exported = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(out, "downloads"));
      const lines = String((exported as { traces?: string }).traces ?? "").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) as { time: string; type: string; data?: { text?: string } }; } catch { return null; } });
      const runs = lines.filter((l) => l?.type === "run_start");
      evidence.tasks = runs.map((l) => l!.data?.text ?? "");
      assert.equal(runs.length, 1, `只开 1 个任务（实际 ${runs.length}）`);
      if (handoff) {
        evidence.handoffTaskStarts = runs;
        assert.ok(runs.every((run) => Date.parse(run!.time) >= askAt), "网页任务只在第二轮明确查询请求之后启动");
      }
    }
  }
  await rp.screenshot(panel, join(out, "panel.png"));
} catch (e) {
  error = e instanceof Error ? e.stack ?? e.message : String(e);
  if (panel) await exportDiagnosticsViaSettings(rp, rp.extensionId, join(out, "failure-downloads")).catch(() => {});
  if (panel) { evidence.view = await rp.evaluate(panel, '({ status: document.querySelector(".voice-state")?.innerText, text: document.body.innerText.slice(0, 2000) })').catch(() => null); await rp.screenshot(panel, join(out, "failure.png")).catch(() => {}); }
} finally {
  const g = panel ? await readRaw().catch(() => null) : null;
  if (handoff && g) evidence.handoffTurnRelations = { note: "原始转写、turn.done与delegation（含user_bidi_turn_id）仅供诊断，不以内部对象关系判产品通过。", events: g.in.filter((e) => ["input_transcript.added", "output_transcript.added", "turn.done", "delegation.created"].includes(e.type)) };
  await writeFile(join(out, "summary.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", case: caseName, model, voiceModel: VOICE_MODEL, extraFact: !!extraFact, evidence, hostDiagnostics, calls, sockets, events: g && { in: g.in, out: g.out.map((e) => ({ ...e })), said: g.said }, error }, null, 2));
  if (g) await writeFile(join(out, "meter.json"), JSON.stringify(g.meter));
  await rp.close(); await rp.remove(); site.close();
}
console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", out, evidence: { ...evidence, view: undefined }, error: error?.split("\n")[0] ?? null }, null, 1));
if (error) process.exitCode = 1;
