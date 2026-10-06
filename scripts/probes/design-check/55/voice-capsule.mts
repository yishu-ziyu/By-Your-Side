/**
 * 设计复查 #55 语音状态胶囊（静态视觉检查；无真麦克风、不调用任何付费语音接口）。
 *
 * 真实路径部分：真侧栏 + 假麦克风文件，点「语音」按钮真实走 VoiceClient.start（出站 start 命令被记录），点「结束」真实收尾。
 * 注入部分：StepFun 实时语音不可用，所以状态/字幕/来源由「后台会转发给面板的同一信封」{kind:"server",...} 喂入：
 *   页面脚本之前包装 chrome.runtime.connect，捕获面板给端口注册的 onMessage 监听器，直接调用它 —— 等于从真实 handleBgMessage 入口进，
 *   之后全是产品自己的 handleServerMessage -> voiceUI.receive/deliver -> VoiceClient.receive 路径。
 * 不能用 ?acceptance=t06 钩子：后台只接受 URL 严格等于 sidepanel.html 的端口。
 *
 *   npx tsx scripts/probes/design-check/55/voice-capsule.mts --headless
 */
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, sleep, until } from "../../../acceptance/real-path/harness.mts";

requireHeadless();

const OUT = join(REPO, "out/design-check/55");

/** 注入给面板的语音事件（只含本探针用到的字段）。 */
type VoiceEventPayload = { kind: string; turn?: number; role?: string; text?: string; state?: string; inputMode?: string; detail?: string; data?: string; itemId?: string; responseId?: string };

/** 注入给面板的后台信封（本探针只发 user_delivery 事件）。 */
type ServerEnvelopeMsg = { type: string; conversationId: string; event: { kind: string; delivery: { conversationId: string; id: string; runId: string; kind: string; text: string; composedAt: number; status: string; facts: { outcome: string; delivered: string[]; remaining: string[]; sources: { url: string; title: string }[] } } } };

await mkdir(OUT, { recursive: true });

const wav = join(OUT, "fake-mic.wav");

execFileSync("say", ["-v", "Tingting", "-o", wav, "--data-format=LEI16@24000", "你好，请帮我看一下这个页面。[[slnc 25000]]"]);

type Status = "pass" | "fail" | "not-run";

type Item = { id: string; title: string; status: Status; evidence: string; reached: string };

const items: Item[] = [];

/** 各步骤的原始观测，只写入 result.json。 */
type Notes = {
  startCommand?: unknown;
  connecting?: unknown;
  listening?: unknown;
  thinking?: unknown;
  thinkingDetail?: unknown;
  afterAudio1?: unknown;
  speaking?: unknown;
  afterDelivery1?: unknown;
  withSources?: unknown;
  zero?: unknown;
  stopSpeechLayout?: unknown;
  mqReduce?: unknown;
  reduced?: unknown;
  dark?: unknown;
  ended?: unknown;
  reopened?: unknown;
  error?: unknown;
  bugs?: unknown;
  visualNotes?: unknown;
  wordLevel?: unknown;
};

const notes: Notes = {};

const add = (id: string, title: string, status: Status, evidence: string, reached: string) => {
  items.push({ id, title, status, evidence, reached });
  console.log(`${status.toUpperCase()}  ${id}  ${evidence}`);
};

const REAL = "真实路径：点「语音」按钮 -> VoiceClient.start（假麦克风）；状态由注入的后台信封驱动";

const INJ = "注入信封（handleBgMessage 入口，同后台转发的 {kind:server} 格式）";

const rp = await launchRealPath({ microphoneWav: wav });

try {
  const panel = await rp.attach(await rp.openSidePanel());
  const HOOK = `(() => { window.__out = []; window.__listeners = []; const orig = chrome.runtime.connect; chrome.runtime.connect = function(...a){ const p = orig.apply(this,a); const pm = p.postMessage.bind(p); p.postMessage = m => { try { const s = m?.msg ?? m; if (s?.type==='voice') window.__out.push(s); } catch {} return pm(m); }; const add = p.onMessage.addListener.bind(p.onMessage); p.onMessage.addListener = f => { window.__listeners.push(f); return add(f); }; return p; }; })()`;
  await rp.cdp.send("Page.enable", {}, panel);
  await rp.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: HOOK }, panel);
  await rp.cdp.send("Page.reload", {}, panel);
  await sleep(1000);
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#conversation-new")?.disabled===false&&window.__listeners?.length>0&&document.querySelector('#status-text')?.textContent==='已连接'`).catch(() => false)) || undefined, 60_000, "panel reload");
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 420, height: 820, deviceScaleFactor: 2, mobile: false }, panel);

  const ev = (e: VoiceEventPayload) => rp.evaluate(panel, `(() => { const m = window.__out.find(x => x.command?.kind === 'start'); const L = window.__listeners; for (const f of L) f({ kind: 'server', conversationId: m.conversationId, msg: { type: 'voice', voiceId: m.voiceId, conversationId: m.conversationId, event: ${JSON.stringify(e)} } }); return true; })()`);
  const envelope = (msg: ServerEnvelopeMsg) => rp.evaluate(panel, `(() => { const m = window.__out.find(x => x.command?.kind === 'start'); for (const f of window.__listeners) f({ kind: 'server', conversationId: m.conversationId, msg: ${JSON.stringify(msg)} }); return true; })()`);
  const silence = Buffer.alloc(48_000).toString("base64"); // 1 s 静音 PCM16 24 kHz，单块 64000 字符以内
  const audio = async (turn: number, n = 25) => { for (let i = 0; i < n; i++) await ev({ kind: "audio", turn, data: silence, itemId: `item-${turn}`, responseId: `resp-${turn}` }); };

  // 状态探针：胶囊文字、颜色（画布取 RGBA 以解析 color-mix）、尺寸、对比度、动画、字幕强调、来源行。
  const PROBE = `(() => {
    const rgba = c => { const k = document.createElement('canvas'); k.width = k.height = 1; const x = k.getContext('2d'); x.clearRect(0,0,1,1); x.fillStyle = c; x.fillRect(0,0,1,1); const d = x.getImageData(0,0,1,1).data; return [d[0],d[1],d[2],d[3]/255]; };
    const over = (f, b) => [0,1,2].map(i => f[i]*f[3] + b[i]*(1-f[3]));
    const lum = c => { const s = c.map(v => { v/=255; return v<=0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055,2.4); }); return 0.2126*s[0]+0.7152*s[1]+0.0722*s[2]; };
    const ratio = (a,b) => { const [x,y] = [lum(a),lum(b)].sort((p,q)=>q-p); return +((x+0.05)/(y+0.05)).toFixed(2); };
    const region = document.querySelector('.voice-progress'); const st = region.querySelector('.voice-state');
    const cs = getComputedStyle(st); const b = st.getBoundingClientRect(); const rr = region.getBoundingClientRect();
    const pageBg = rgba(getComputedStyle(document.body).backgroundColor);
    const regionBg = (() => { let e = region; while (e) { const c = rgba(getComputedStyle(e).backgroundColor); if (c[3] > 0.5) return c; e = e.parentElement; } return pageBg; })();
    const fg = rgba(cs.color); const capBg = over(rgba(cs.backgroundColor), regionBg.slice(0,3));
    const before = getComputedStyle(st, '::before');
    const cur = region.querySelector('.voice-current-sentence');
    const src = region.querySelector('.voice-sources');
    const ans = region.querySelector('.voice-answer');
    const det = region.querySelector('.voice-state-detail');
    return {
      dataState: region.dataset.state, hidden: region.hidden,
      capsuleText: st.textContent, capsuleDetail: det.textContent,
      color: cs.color, background: cs.backgroundColor, border: cs.borderTopColor, fontWeight: cs.fontWeight, fontSize: cs.fontSize,
      capsuleBox: { w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.x - rr.x), y: Math.round(b.y - rr.y) },
      contrastTextOnCapsule: ratio(fg, capBg),
      dotAnimation: before.animationName, dotContent: before.content, dotBg: before.backgroundColor, transitionDuration: cs.transitionDuration,
      answerText: ans.textContent, answerHTML: ans.innerHTML.slice(0, 500),
      currentSentence: cur ? { text: cur.textContent, weight: getComputedStyle(cur).fontWeight, color: getComputedStyle(cur).color, bg: getComputedStyle(cur).backgroundColor, contrastOnPage: ratio(rgba(getComputedStyle(cur).color), over(rgba(getComputedStyle(cur).backgroundColor), regionBg.slice(0,3))) } : null,
      hasStrongTag: !!ans.querySelector('strong,b'),
      sources: { text: src.textContent, hidden: src.hidden, display: getComputedStyle(src).display },
      stopSpeechVisible: !region.querySelector('.voice-stop-speech').hidden, endText: region.querySelector('.voice-end').textContent,
      regionBox: { w: Math.round(rr.width), h: Math.round(rr.height) },
    };
  })()`;

  type Snap = {
    dataState: string; hidden: boolean; capsuleText: string; capsuleDetail: string;
    color: string; background: string; border: string; fontWeight: string; fontSize: string;
    capsuleBox: { w: number; h: number; x: number; y: number };
    contrastTextOnCapsule: number;
    dotAnimation: string; dotContent: string; dotBg: string; transitionDuration: string;
    answerText: string; answerHTML: string;
    currentSentence: { text: string; weight: string; color: string; bg: string; contrastOnPage: number } | null;
    hasStrongTag: boolean;
    sources: { text: string; hidden: boolean; display: string };
    stopSpeechVisible: boolean; endText: string;
    regionBox: { w: number; h: number };
  };

  const snap = async (name: string): Promise<Snap> => {
    await sleep(500);
    // SAFETY: PROBE 返回值字段与 Snap 一一对应。
    const data = await rp.evaluate(panel, PROBE) as Snap;
    await rp.screenshot(panel, join(OUT, `${name}.png`));
    // SAFETY: 该脚本只返回 null 或四个数字字段的矩形。
    const r = await rp.evaluate(panel, `(() => { const r = document.querySelector('.voice-progress'); if (r.hidden) return null; const b = r.getBoundingClientRect(); return { x: Math.max(0, b.x - 8), y: Math.max(0, b.y - 8), width: b.width + 16, height: b.height + 16 }; })()`) as { x: number; y: number; width: number; height: number } | null;

    if (r) {
      const { data: png } = await rp.cdp.send("Page.captureScreenshot", { format: "png", clip: { ...r, scale: 1 } }, panel);
      await writeFile(join(OUT, `${name}-closeup.png`), Buffer.from(png, "base64"));
    }

    return data;
  };

  // 0. 真实路径：点「语音」
  await rp.evaluate(panel, `document.querySelector('.voice-progress').hidden`);
  await rp.click(panel, ".voice-start");
  await until(async () => (await rp.evaluate(panel, `window.__out.some(x => x.command?.kind === 'start')`)) || undefined, 10_000, "start 命令");
  await sleep(3000); // 等假麦克风真正开起来（播放器在此之后才创建）
  const connecting = await snap("00-connecting");
  notes.startCommand = await rp.evaluate(panel, `JSON.stringify(window.__out.filter(x=>x.command?.kind==='start').map(x=>x.command))`);
  notes.connecting = connecting;

  // 1. listening
  await ev({ kind: "state", state: "ready", inputMode: "server_vad" });
  const listening = await snap("01-listening");
  notes.listening = listening;
  add("A1-listening", "听：琥珀胶囊 + 文案「正在听」", listening.dataState === "listening" && listening.capsuleText === "正在听" ? "pass" : "fail",
    `state=${listening.dataState} text=${listening.capsuleText} color=${listening.color} bg=${listening.background} contrast=${listening.contrastTextOnCapsule} box=${JSON.stringify(listening.capsuleBox)}`, `${REAL}；ready 事件为${INJ}`);

  // 2. thinking（用户一句话 -> 助手处理中）
  await ev({ kind: "input_turn", turn: 1 });
  await ev({ kind: "text", turn: 1, role: "user", text: "帮我看看这个页面讲了什么，再告诉我价格是否合理" });
  await ev({ kind: "state", state: "answering" });
  const thinking = await snap("02-thinking");
  notes.thinking = thinking;
  add("A1-thinking", "想：中性胶囊 + 文案「正在想」，无重复说明行", thinking.dataState === "thinking" && thinking.capsuleText === "正在想" && thinking.capsuleDetail === "" ? "pass" : "fail",
    `state=${thinking.dataState} text=${thinking.capsuleText} detail="${thinking.capsuleDetail}" color=${thinking.color} bg=${thinking.background} dotAnim=${thinking.dotAnimation}`, INJ);
  await ev({ kind: "state", state: "answering", detail: "正在读取当前页面" });
  const thinkingDetail = await snap("02b-thinking-with-detail");
  notes.thinkingDetail = thinkingDetail;

  // 3. speaking：音频 + 助手转写（累积文本，多句）
  await audio(1);
  notes.afterAudio1 = [await rp.evaluate(panel, `document.querySelector('.voice-progress').dataset.state`), await (async()=>{await sleep(300);

return rp.evaluate(panel, `document.querySelector('.voice-progress').dataset.state`)})()];
  console.log('afterAudio1', notes.afterAudio1);
  const speechText = "这个页面是一款无线耳机的商品页。标价是二百九十九元，比同类产品略低。从参数看续航和降噪都不错，不过没有看到售后条款。你想让我再核对一下评价吗？";
  await ev({ kind: "text", turn: 1, role: "assistant", text: speechText.slice(0, 45) });
  await ev({ kind: "text", turn: 1, role: "assistant", text: speechText });
  const speaking = await snap("03-speaking");
  notes.speaking = speaking;
  add("A1-speaking", "说：青绿胶囊 + 文案「正在说」，三态可区分", speaking.dataState === "speaking" && speaking.capsuleText === "正在说" && speaking.color !== listening.color && speaking.color !== thinking.color ? "pass" : "fail",
    `state=${speaking.dataState} text=${speaking.capsuleText} color=${speaking.color} (listening ${listening.color}, thinking ${thinking.color}) contrast=${speaking.contrastTextOnCapsule}`, INJ);
  add("A2-subtitle", "回答时可见字幕；当前句高亮（词级降级为整句）", speaking.answerText === speechText && speaking.currentSentence?.text === "你想让我再核对一下评价吗？" ? "pass" : "fail",
    `answer visible=${!!speaking.answerText} currentSentence=${JSON.stringify(speaking.currentSentence)} strongTag=${speaking.hasStrongTag}`, INJ);

  // 4. speaking + 来源（交付事实链：本轮真实 sources）
  const delivery = (n: number, id: string, text = speechText) => ({ type: "agent_event", conversationId: "default", event: { kind: "user_delivery", delivery: { conversationId: "default", id, runId: "run-1", kind: "finding", text, composedAt: Date.now(), status: "composed",
    facts: { outcome: "complete", delivered: ["已读取商品页"], remaining: [], sources: Array.from({ length: n }, (_, i) => ({ url: `https://example.com/p/${i}`, title: `来源 ${i}` })) } } } });

  await envelope(delivery(3, "d-1"));
  notes.afterDelivery1 = await rp.evaluate(panel, `({msgs: [...document.querySelectorAll('.msg.assistant')].map(m=>m.textContent.slice(0,40)), src: document.querySelector('.voice-sources').textContent, st: document.querySelector('.voice-progress').dataset.state})`);
  console.log(JSON.stringify(notes.afterDelivery1));
  const withSources = await snap("04-speaking-with-sources");
  notes.withSources = withSources;
  add("A3-sources", "有来源的一轮显示「N 个来源」", withSources.sources.text === "3 个来源" && !withSources.sources.hidden && withSources.dataState === "speaking" ? "pass" : "fail",
    `sources=${JSON.stringify(withSources.sources)} state=${withSources.dataState}`, `${INJ}：user_delivery facts.sources=3`);

  // 5. 新一轮，0 来源
  await ev({ kind: "input_turn", turn: 2 });
  await ev({ kind: "text", turn: 2, role: "user", text: "谢谢，那就这样" });
  await ev({ kind: "state", state: "answering" });
  await audio(2);
  await ev({ kind: "text", turn: 2, role: "assistant", text: "好的，需要时再叫我。" });
  await envelope(delivery(0, "d-2", "好的，需要时再叫我。"));
  const zero = await snap("05-speaking-zero-sources");
  notes.zero = zero;
  add("A3-zero-sources", "0 来源不显示「0 个来源」", zero.sources.text === "" && zero.sources.display === "none" && !zero.answerText.includes("0 个来源") && zero.dataState === "speaking" ? "pass" : "fail",
    `sources=${JSON.stringify(zero.sources)} state=${zero.dataState} answer="${zero.answerText}"`, `${INJ}：turn 2 user_delivery facts.sources=[]`);
  // 上一轮来源数不应带到新一轮（turn 切换时清零）
  add("A3-no-carry-over", "新一轮开始时上一轮来源数清零", zero.sources.text === "" ? "pass" : "fail", `after turn 2, sources text="${zero.sources.text}"`, INJ);

  // 6. 停声按钮与胶囊共存（#55 验收：不与插话/停声按钮冲突）
  notes.stopSpeechLayout = await rp.evaluate(panel, `(() => { const q = s => { const r = document.querySelector(s).getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), hidden: document.querySelector(s).hidden }; }; return { state: q('.voice-state'), stop: q('.voice-stop-speech'), end: q('.voice-end') }; })()`);
  // SAFETY: stopSpeechLayout 由上一行脚本生成，键为 state/stop/end，值为矩形。
  const L = notes.stopSpeechLayout as Record<string, { x: number; y: number; w: number; h: number; hidden: boolean }>;
  const overlap = (a: typeof L.state, b: typeof L.state) => !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
  add("A4-no-overlap", "胶囊与「停声」「结束」按钮不重叠", !L.stop.hidden && !overlap(L.state, L.stop) && !overlap(L.state, L.end) && !overlap(L.stop, L.end) ? "pass" : "fail",
    `boxes=${JSON.stringify(L)}`, INJ);

  // 7. reduced motion（仍在 speaking）
  // SAFETY: 该脚本返回 { anim, trans } 两个字符串。
  const normalMotion = await rp.evaluate(panel, `({ anim: getComputedStyle(document.querySelector('.voice-state'), '::before').animationName, trans: getComputedStyle(document.querySelector('.voice-state')).transitionDuration })`) as { anim: string; trans: string };
  await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, panel);
  notes.mqReduce = await rp.evaluate(panel, `matchMedia('(prefers-reduced-motion: reduce)').matches`);
  console.log('mqReduce', notes.mqReduce);
  const reduced = await snap("06-reduced-motion-speaking");
  notes.reduced = { normalMotion, reduced };
  await ev({ kind: "state", state: "answering" });
  const reducedThinking = await snap("06b-reduced-motion-thinking");
  add("A5-reduced-motion", "reduced-motion：胶囊变色保留，脉冲动画取消",
    reduced.dotAnimation === "none" && reduced.transitionDuration.split(",").every((s: string) => parseFloat(s) === 0) && normalMotion.anim !== "none" && reduced.color === speaking.color ? "pass" : "fail",
    `normal anim=${normalMotion.anim} trans=${normalMotion.trans}; reduced anim=${reduced.dotAnimation} trans=${reduced.transitionDuration} color=${reduced.color}(same as normal speaking=${reduced.color === speaking.color}); thinking-under-reduce text=${reducedThinking.capsuleText}`,
    `${INJ}；Emulation.setEmulatedMedia prefers-reduced-motion=reduce`);
  await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] }, panel);

  // 8. 暗色（附加）
  await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }, panel);
  await audio(2);
  await ev({ kind: "text", turn: 2, role: "assistant", text: "好的，需要时再叫我。" });
  const dark = await snap("07-dark-speaking");
  notes.dark = dark;
  await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] }, panel);

  // 9. 结束语音（真实点击「结束」）-> 胶囊复位
  await rp.click(panel, ".voice-end");
  await sleep(800);
  const ended = await snap("08-after-end");
  notes.ended = ended;
  const endedAfterSources = ended.sources;
  add("A4-reset", "结束语音后胶囊复位（隐藏、文字清空、来源清零）",
    ended.hidden === true && ended.dataState === "idle" && ended.capsuleText === "" && endedAfterSources.text === "" ? "pass" : "fail",
    `hidden=${ended.hidden} state=${ended.dataState} capsuleText="${ended.capsuleText}" sources="${endedAfterSources.text}"`, "真实点击「结束」按钮（VoiceClient.stop）");
  // 重新打开：胶囊应是中性默认样式，不残留上轮的青绿
  await rp.click(panel, ".voice-start");
  await sleep(800);
  const reopened = await snap("09-reopened-connecting");
  notes.reopened = reopened;
  add("A4-reopen-neutral", "再次开启：胶囊从中性/连接中开始，不残留上轮青绿或字幕",
    reopened.color !== speaking.color && reopened.answerText === "" && reopened.sources.text === "" ? "pass" : "fail",
    `state=${reopened.dataState} text=${reopened.capsuleText} color=${reopened.color} answer="${reopened.answerText}" sources="${reopened.sources.text}"`, "真实点击「语音」按钮（无信封注入）");
} catch (e) {
  notes.error = e instanceof Error ? e.stack : String(e);
  console.error(notes.error);
  add("ERROR", "probe aborted", "fail", String(notes.error).slice(0, 400), "—");
} finally {
  const ran = new Set(items.map(i => i.id));

  for (const [id, title] of [["A1-listening", "听"], ["A1-thinking", "想"], ["A1-speaking", "说"], ["A2-subtitle", "字幕"], ["A3-sources", "来源数"], ["A3-zero-sources", "0 来源"], ["A5-reduced-motion", "reduced-motion"], ["A4-reset", "复位"]] as const) {
    if (!ran.has(id)) add(id, title, "not-run", "probe aborted before this step", "—");
  }

  notes.bugs = [{
    id: "B1-reduced-motion-specificity",
    repro: "开语音进入听/说态，开启 prefers-reduced-motion: reduce（或探针 06 步），读 getComputedStyle(.voice-state,'::before').animationName 与 .voice-state 的 transitionDuration",
    observed: "reduce 下仍是 voice-capsule-pulse，transition 仍 0.12s；正常下同值",
    cause: "styles.css 的 reduced-motion 规则 `.voice-progress .voice-state::before`(0,2,1)/`.voice-progress .voice-state`(0,2,0) 特异性低于先写的 `.voice-progress:is([data-state=...]) .voice-state::before`(0,3,1)/`.voice-state:not(:empty)`(0,3,0)，被盖掉",
  }];
  notes.visualNotes = [
    "胶囊 70x27 CSS px，13px 字，在 420px 宽侧栏里偏小；Comet 的胶囊占满整条栏并整体换色，这里只是一颗小药丸，状态感弱。",
    "琥珀/青绿对比度只有约 4.05–4.07:1（<4.5:1 的 AA 文字线），12% 底色上 600 字重 13px 偏淡；暗色下青绿更清楚。",
    "粒子球永远是薰衣草/粉/蓝，与琥珀、青绿胶囊不是一套颜色，同屏三个色系各说各话；Comet 里整条栏与声波同色。",
    "「想」态是灰色胶囊，与琥珀/青绿相比几乎看不出变化，也没有 Comet 的「Tinkering」暗下去的呼吸，只能靠字区分。",
    "字幕只高亮最后一句：浅青底 + 加粗，换行时底色成两段碎块，像荧光笔；没有词级加粗（issue 允许降级），但界面没有任何降级说明。",
    "字幕仍是普通正文列（上方有「你：」转写、下方来源灰丸），没有 Comet 那种边说边出字、淡入淡出的字幕卡；来源只是文字小丸，没有站点图标。",
    "胶囊与「随时插话」提示、转写行各自小字挤在一起，垂直节奏紧；「停声」「结束」是无框灰字，离胶囊很远。",
  ];
  notes.wordLevel = "实现只按句高亮（.voice-current-sentence），不加粗单词：VoiceEvent text 没有词级时间戳。issue 允许此降级；需另核对「说明降级」是否出现在界面（见 result.json A2-degrade-note）。";
  const degradeNoteInUI = false;
  items.push({ id: "A2-degrade-note", title: "降级到整句高亮时有说明", status: degradeNoteInUI ? "pass" : "fail", evidence: "界面上无任何降级说明文字（仅 voice-ui.ts 注释里有）；issue 验收写「否则整句高亮且说明降级」，说明只存在于代码注释", reached: "静态：读 voice-ui.ts + 快照中字幕区无说明文字" });
  await writeFile(join(OUT, "result.json"), JSON.stringify({ issue: 55, ranAt: new Date().toISOString(), items, notes }, null, 2));
  await rp.close();
  await rp.remove();
}
