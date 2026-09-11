#!/usr/bin/env node
/**
 * 运行态面板验收（用户面 C 组）：真构建面板 + 隔离 headless Chrome，注入合成的 server 事件。
 * 断言：运行中只有一条状态行（光球 + 正在做什么 + 耗时），像素格等待态不存在；截图留证。
 * 依据 docs/evals/20260911-fast-and-lean.md。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { launchIsolatedExtension, sleep } from "./isolated-extension.mts";

const OUT = process.argv.find((a) => a.startsWith("--out="))?.slice(6) ?? "/tmp/sideagent-run-status";
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string): void => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

/** 面板页的 mock：把 server 消息从测试直接喂给面板，不经过真实 background。 */
const MOCK = `
globalThis.uiListeners=[];globalThis.uiMessages=[];
const storage={get:async()=>({}),set:async()=>{},remove:async()=>{}};
globalThis.chrome={runtime:{getURL:p=>new URL(p,location.href).href,connect:()=>({onMessage:{addListener:f=>uiListeners.push(f)},onDisconnect:{addListener:()=>{}},disconnect:()=>{},postMessage:m=>{uiMessages.push(m);}})},storage:{local:storage,session:storage},tabs:{query:async()=>[],onActivated:{addListener:()=>{}},onUpdated:{addListener:()=>{}},create:async()=>({id:2})}};
navigator.permissions.query=async()=>({state:'granted'});
globalThis.uiEmit=e=>uiListeners.forEach(fn=>fn(e));
globalThis.emit=envelope=>uiEmit(envelope);
`;

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const iso = await launchIsolatedExtension();
  const report: Record<string, unknown> = { ok: false, checks, outDir: iso.outDir };
  // 面板页由本地服务提供：真 sidepanel.html + 真 dist 资源 + 注入的 mock chrome.runtime（不碰真 background）。
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? "/", "http://local").pathname;
    if (pathname === "/sidepanel.html") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end((await readFile("extension/sidepanel.html", "utf8")).replace("<script type=\"module\"", '<script src="mock.js"></script><script type="module"'));
      return;
    }
    if (pathname === "/mock.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(MOCK);
      return;
    }
    if (/\.(js|css|woff2|svg|png)$/.test(pathname)) {
      try {
        const file = resolve("extension/dist", `.${pathname}`);
        if (!file.startsWith(`${resolve("extension/dist")}/`)) throw new Error("path");
        res.setHeader("Content-Type", ({ ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png" } as Record<string, string>)[extname(file)] ?? "application/octet-stream");
        res.end(await readFile(file));
      } catch {
        res.statusCode = 404;
        res.end();
      }
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const panelUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/sidepanel.html`;
  try {
    const targetId = await iso.newTarget(panelUrl);
    for (let n = 0; n < 40; n += 1) {
      const ready = await iso.evalIn(targetId, `Boolean(document.querySelector('#conversation-new') && globalThis.uiEmit)`).catch(() => false);
      if (ready) break;
      await sleep(200);
    }
    await iso.evalIn(targetId, `globalThis.uiEmit ? true : (()=>{throw new Error('panel not ready')})()`);
    await iso.evalIn(targetId, `emit({kind:'conversations',selectedConversationId:'default',conversations:[{id:'default',title:'新会话',createdAt:1,updatedAt:1,state:'running',mode:'act'}]});
      emit({kind:'conn',state:'connected'});
      emit({kind:'server',msg:{type:'hello_ok',version:1,model:'minimax-cn/MiniMax-M3',models:[]}});`);
    await sleep(200);

    // 思考中：这一行是"活的"（A：竖线呼吸 + 光球呼吸 + 名字强调色）
    await iso.evalIn(targetId, `(()=>{const ev=e=>emit({kind:'server',msg:{type:'agent_event',conversationId:'default',event:e}});
      ev({kind:'thinking_delta',delta:'先看一眼这个页面，再决定点哪里。'});})()`);
    await sleep(150);
    const thinkingLive = await iso.evalIn(targetId, `(()=>{
      const d=document.querySelector('details.thinking');
      const orb=d?d.querySelector('canvas'):null;
      const span=d?d.querySelector('summary span'):null;
      return {
        streaming:d?d.classList.contains('streaming'):null,
        spine:d?getComputedStyle(d,'::before').animationName:null,
        orbClass:orb?orb.className:null,
        orbAnim:orb?getComputedStyle(orb).animationName:null,
        color:span?getComputedStyle(span).color:null,
      };})()`);
    report.thinkingLive = thinkingLive;
    check("思考中那一行的竖线在呼吸", typeof thinkingLive.spine === "string" && thinkingLive.spine.includes("spineBreathe"), `spine ${thinkingLive.spine}`);
    check("思考中那一行的光球在呼吸", String(thinkingLive.orbClass).includes("orb-live") && String(thinkingLive.orbAnim).includes("orbBreathe"), `orb ${thinkingLive.orbClass} / ${thinkingLive.orbAnim}`);
    check("思考中那一行的名字是强调色", thinkingLive.streaming === true && typeof thinkingLive.color === "string", `color ${thinkingLive.color}`);

    // 用户消息 + 一个工具在跑：运行态
    await iso.evalIn(targetId, `(()=>{const ev=e=>emit({kind:'server',msg:{type:'agent_event',conversationId:'default',event:e}});
      ev({kind:'tool_start',toolCallId:'t1',name:'snapshot',params:{}});
      ev({kind:'tool_end',toolCallId:'t1',name:'snapshot',isError:false,resultText:'ok'});
      ev({kind:'tool_start',toolCallId:'t2',name:'click',params:{label:'暂停'}});})()`);
    await sleep(700);
    const running = await iso.evalIn(targetId, `(()=>{
      const run=document.querySelector('details.run-steps');
      return {
        px:document.querySelectorAll('.px-wrap,.px-grid').length,
        runCount:document.querySelectorAll('details.run-steps').length,
        summary:run?run.querySelector('summary').innerText.trim():null,
        open:run?run.open:null,
        orbs:document.querySelectorAll('canvas').length,
        title:run?run.querySelector('.run-title').textContent:null,
        time:run?run.querySelector('.run-time').textContent:null,
      };})()`);
    report.running = running;
    check("像素格等待态已移除", running.px === 0, `px nodes ${running.px}`);
    check("运行中只有一个执行块", running.runCount === 1, `runs ${running.runCount}`);
    check("状态行写的是正在做什么", typeof running.title === "string" && running.title.startsWith("正在"), `title ${running.title}`);
    check("状态行带实时耗时", /\d/.test(running.time ?? ""), `time ${running.time}`);
    check("细节默认收起，点开才看", running.open === false, `open ${running.open}`);
    check("运行指示是光球", running.orbs >= 1, `canvas ${running.orbs}`);
    // B：思考行落定（收束一次、回到常态），跑着的 chip 有蓝边 + 光球在呼吸
    const settle = await iso.evalIn(targetId, `(()=>{
      const d=document.querySelector('details.thinking');
      const span=d?d.querySelector('summary span'):null;
      const chip=[...document.querySelectorAll('.chip')].find(c=>c.textContent.includes('暂停'));
      const chipOrb=chip?chip.querySelector('canvas'):null;
      return {
        thinkingStreaming:d?d.classList.contains('streaming'):null,
        spineIdle:d?getComputedStyle(d,'::before').animationName:null,
        chipRunning:chip?chip.classList.contains('running'):null,
        chipBorder:chip?getComputedStyle(chip).borderColor:null,
        chipOrbClass:chipOrb?chipOrb.className:null,
      };})()`);
    report.settle = settle;
    check("思考行落定后不再是运行态", settle.thinkingStreaming === false && settle.spineIdle === "none", `streaming ${settle.thinkingStreaming} spine ${settle.spineIdle}`);
    check("跑着的 chip 带运行态样式", settle.chipRunning === true && typeof settle.chipBorder === "string", `running ${settle.chipRunning} border ${settle.chipBorder}`);
    check("跑着的 chip 光球在呼吸", String(settle.chipOrbClass).includes("orb-live"), `orb ${settle.chipOrbClass}`);
    // 光球是不是真的在动：同一批 canvas 隔 400ms 取两次像素指纹，比较变化。
    const orbMotion = await iso.evalIn(targetId, `(async()=>{
      const canvases=[...document.querySelectorAll('canvas')].filter(c=>c.width>0&&c.height>0);
      const sample=()=>canvases.map(c=>{const ctx=c.getContext('2d');const d=ctx.getImageData(0,0,c.width,c.height).data;let h=0;for(let i=0;i<d.length;i+=7)h=(h*31+d[i])>>>0;return h;});
      const a=sample();
      await new Promise(r=>setTimeout(r,400));
      const b=sample();
      return {count:canvases.length,changed:a.filter((v,i)=>v!==b[i]).length,reduce:matchMedia('(prefers-reduced-motion: reduce)').matches};
    })()`);
    report.orbMotion = orbMotion;
    check("运行中的光球真的在动", orbMotion.changed >= 1, `canvas ${orbMotion.count} changed ${orbMotion.changed} reduce ${orbMotion.reduce}`);
    await iso.screenshot(targetId, join(iso.outDir, "running.png"));
    // 展开执行过程：A+B 的运行态在这里能看见（蓝色竖线 + 蓝色名字 + 蓝边 chip + 呼吸光球）
    await iso.evalIn(targetId, `(()=>{const run=document.querySelector('details.run-steps');run.open=true;return true;})()`);
    await sleep(300);
    await iso.screenshot(targetId, join(iso.outDir, "running-expanded.png"));
    await iso.evalIn(targetId, `(()=>{const run=document.querySelector('details.run-steps');run.open=false;return true;})()`);
    await sleep(200);

    // B：工具结束的那一刻是收束——chip 退出运行态、光球缩回、点收束
    await iso.evalIn(targetId, `(()=>{const ev=e=>emit({kind:'server',msg:{type:'agent_event',conversationId:'default',event:e}});
      ev({kind:'tool_end',toolCallId:'t2',name:'click',isError:false,resultText:'Clicked 暂停. Page reacted: paused false → true.'});})()`);
    await sleep(80);
    const closing = await iso.evalIn(targetId, `(()=>{
      const chip=[...document.querySelectorAll('.chip')].find(c=>c.textContent.includes('暂停'));
      const orb=chip?chip.querySelector('canvas'):null;
      return {running:chip?chip.classList.contains('running'):null, orbClass:orb?orb.className:null, dot:chip?chip.querySelector('.chip-dot').className:null};})()`);
    report.closing = closing;
    check("结束后 chip 退出运行态", closing.running === false, `running ${closing.running}`);
    check("结束后光球收束一次", String(closing.orbClass).includes("orb-settle"), `orb ${closing.orbClass}`);
    check("结束后点做收束", String(closing.dot).includes("settling"), `dot ${closing.dot}`);

    // 收尾：交付 + agent_end
    await iso.evalIn(targetId, `(()=>{const ev=e=>emit({kind:'server',msg:{type:'agent_event',conversationId:'default',event:e}});
      ev({kind:'user_delivery',delivery:{id:'d1',kind:'finding',text:'视频已经暂停了。',runId:'r1',state:'delivered'}});
      emit({kind:'server',msg:{type:'status',state:'idle'}});
      ev({kind:'agent_end'});})()`);
    await sleep(900);
    const done = await iso.evalIn(targetId, `(()=>{
      const run=document.querySelector('details.run-steps');
      return { title:run?run.querySelector('.run-title').textContent:null, time:run?run.querySelector('.run-time').textContent:null, open:run?run.open:null, px:document.querySelectorAll('.px-wrap,.px-grid').length };
    })()`);
    report.done = done;
    check("结束后状态行落定为查看执行过程", done.title === "查看执行过程", `title ${done.title}`);
    check("结束后带总耗时", /耗时/.test(done.time ?? ""), `time ${done.time}`);
    check("结束后仍收着", done.open === false, `open ${done.open}`);
    const lingering = await iso.evalIn(targetId, `(()=>({live:document.querySelectorAll('canvas.orb-live').length,settle:document.querySelectorAll('canvas.orb-settle').length,running:document.querySelectorAll('.chip.running').length}))()`);
    report.lingering = lingering;
    check("动画状态不残留", lingering.live === 0 && lingering.settle === 0 && lingering.running === 0, JSON.stringify(lingering));
    await iso.screenshot(targetId, join(iso.outDir, "done.png"));

    // 展开明细：思考块与工具 chip 都在里面
    await iso.evalIn(targetId, `(()=>{const run=document.querySelector('details.run-steps');run.open=true;return true;})()`);
    await sleep(400);
    const expanded = await iso.evalIn(targetId, `(()=>{const run=document.querySelector('details.run-steps');return {chips:run.querySelectorAll('.chip').length, bodyChildren:run.querySelector('.run-body').children.length};})()`);
    report.expanded = expanded;
    check("点开后能看到工具明细", expanded.chips >= 2, `chips ${expanded.chips}`);
    await iso.screenshot(targetId, join(iso.outDir, "expanded.png"));

    await iso.closeTarget(targetId);
    report.ok = checks.every((c) => c.ok);
  } catch (error) {
    report.error = String(error);
    console.log(`ERROR ${String(error)}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await iso.close();
    await writeFile(join(OUT, "result.json"), JSON.stringify(report, null, 2));
    await writeFile(join(iso.outDir, "result.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, out: iso.outDir }));
  }
}

await main();
