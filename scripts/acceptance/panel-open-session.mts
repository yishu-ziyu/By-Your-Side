#!/usr/bin/env node
/**
 * 面板"每次打开进入 = 新会话页面"验收：真构建 sidepanel.js + 隔离 headless Chrome。
 * 覆盖三种进入情形：上一段有内容（另开新会话、不回放旧记录）、上一段还是空白（复用）、
 * 后台迟迟不给会话清单（兜底另开）。依据 docs/evals/20260911-open-panel-new-session.md。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { launchIsolatedExtension, sleep } from "./isolated-extension.mts";

const OUT = process.argv.find((a) => a.startsWith("--out="))?.slice(6) ?? "/tmp/sideagent-open-session";
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string): void => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

/** 面板页 mock：记录面板发出的 client 消息，测试直接喂 background 信封。 */
const MOCK = `
globalThis.uiListeners=[];globalThis.uiMessages=[];
const storage={get:async()=>({}),set:async()=>{},remove:async()=>{}};
globalThis.chrome={runtime:{getURL:p=>new URL(p,location.href).href,connect:()=>({onMessage:{addListener:f=>uiListeners.push(f)},onDisconnect:{addListener:()=>{}},disconnect:()=>{},postMessage:m=>{uiMessages.push(m);}})},storage:{local:storage,session:storage},tabs:{query:async()=>[],onActivated:{addListener:()=>{}},onUpdated:{addListener:()=>{}},create:async()=>({id:2})}};
navigator.permissions.query=async()=>({state:'granted'});
globalThis.uiEmit=e=>uiListeners.forEach(fn=>fn(e));
globalThis.emit=envelope=>uiEmit(envelope);
globalThis.clientMsgs=()=>uiMessages.filter(m=>m&&m.kind==='client').map(m=>m.msg);
globalThis.allMsgs=()=>uiMessages.slice();
`;

const summary = (id: string, title: string, state = "idle", updatedAt = 9): string =>
  `{id:${JSON.stringify(id)},title:${JSON.stringify(title)},createdAt:1,updatedAt:${updatedAt},state:"${state}",mode:"act"}`;

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const iso = await launchIsolatedExtension();
  const report: Record<string, unknown> = { ok: false, checks, outDir: iso.outDir };
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? "/", "http://local").pathname;
    if (pathname === "/sidepanel.html") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end((await readFile("extension/sidepanel.html", "utf8")).replace('<script type="module"', '<script src="mock.js"></script><script type="module"'));
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

  const waitReady = async (targetId: string): Promise<void> => {
    for (let n = 0; n < 60; n += 1) {
      const ready = await iso.evalIn(targetId, `Boolean(document.querySelector('#conversation-new') && globalThis.uiEmit)`).catch(() => false);
      if (ready) return;
      await sleep(200);
    }
    throw new Error("面板没有就绪");
  };
  const snapshot = (targetId: string): Promise<Record<string, unknown>> => iso.evalIn(targetId, `(()=>{
    const bg=document.getElementById('conversation-background');
    return {
      title:document.querySelector('.conversation-title')?.textContent??null,
      bubbles:document.querySelectorAll('#messages > *').length,
      menu:[...document.querySelectorAll('#conversation-menu button')].map(b=>b.textContent),
      background:bg&&!bg.hidden?bg.textContent:null,
      creates:globalThis.clientMsgs().filter(m=>m.type==='conversation_create').length,
      selects:globalThis.allMsgs().filter(m=>m&&m.kind==='select_conversation').map(m=>m.conversationId),
      syncs:globalThis.allMsgs().filter(m=>m&&m.kind==='sync').map(m=>m.conversationId),
    };})()`);

  try {
    const targetId = await iso.newTarget(panelUrl);
    await waitReady(targetId);

    // ① 上一段有内容（复现用户截图的情形）：打开即新会话，不回放旧记录。
    await iso.evalIn(targetId, `emit({kind:'conn',state:'connected'});
      emit({kind:'conversations',selectedConversationId:'A',conversations:[${summary("A", "打开知乎，找一篇有评论的文章，把评论区…", "running")}]});true`);
    await sleep(600);
    const booting = await snapshot(targetId);
    report.booting = booting;
    check("上一段有内容时请求新会话", booting.creates === 1, `creates ${booting.creates}`);
    check("打开时不自动切到上一段", (booting.selects as string[]).length === 0, `selects ${JSON.stringify(booting.selects)}`);
    check("打开时消息区是空的", booting.bubbles === 0, `bubbles ${booting.bubbles}`);
    check("打开时标题是「新会话」", booting.title === "新会话", `title ${booting.title}`);
    check("正在跑的上一段有入口", typeof booting.background === "string" && booting.background.includes("后台运行中"), `background ${booting.background}`);

    // 旧会话的历史即使被推过来也不回放。
    await iso.evalIn(targetId, `emit({kind:'history',conversationId:'A',entries:[{seq:1,item:{kind:'user',text:'打开知乎，找一篇有评论的文章'}}]});true`);
    await sleep(300);
    const afterHistory = await snapshot(targetId);
    check("上一段的历史不会被回放", afterHistory.bubbles === 0, `bubbles ${afterHistory.bubbles}`);

    // 后台回执新会话：落在一段空白的新会话页上。
    const requestId = await iso.evalIn(targetId, `(()=>{const m=globalThis.clientMsgs().find(m=>m.type==='conversation_create');return m?m.requestId:null;})()`);
    await iso.evalIn(targetId, `emit({kind:'server',msg:{type:'conversation_created',requestId:${JSON.stringify(requestId)},conversation:${summary("C1", "新会话", "idle", 20)}}});true`);
    await sleep(400);
    const opened = await snapshot(targetId);
    report.opened = opened;
    check("新会话落定后标题是「新会话」", opened.title === "新会话", `title ${opened.title}`);
    check("新会话页消息区是空的", opened.bubbles === 0, `bubbles ${opened.bubbles}`);
    check("上一段仍在会话列表里", (opened.menu as string[]).some((t) => t.includes("打开知乎")), `menu ${JSON.stringify(opened.menu)}`);
    await iso.screenshot(targetId, join(iso.outDir, "opened-new-session.png"));

    // ② 上一段还是空白（没说过话）：复用，不新增空会话。
    await iso.evalIn(targetId, `location.reload();true`);
    await waitReady(targetId);
    await iso.evalIn(targetId, `emit({kind:'conn',state:'connected'});
      emit({kind:'conversations',selectedConversationId:'E',conversations:[${summary("E", "新会话", "idle", 30)}]});true`);
    await sleep(600);
    const reused = await snapshot(targetId);
    report.reused = reused;
    check("上一段是空白时不再新建", reused.creates === 0, `creates ${reused.creates}`);
    check("空白上一段被直接复用", (reused.syncs as string[]).includes("E"), `syncs ${JSON.stringify(reused.syncs)}`);
    await iso.evalIn(targetId, `emit({kind:'history',conversationId:'E',entries:[{seq:1,item:{kind:'user',text:'复用的那一页'}}]});true`);
    await sleep(300);
    const reusedHistory = await snapshot(targetId);
    check("复用的会话照常回放自己的记录", reusedHistory.bubbles === 1, `bubbles ${reusedHistory.bubbles}`);

    // ③ 后台迟迟不给会话清单：兜底另开一段，别把面板卡在空白。
    await iso.evalIn(targetId, `location.reload();true`);
    await waitReady(targetId);
    await iso.evalIn(targetId, `emit({kind:'conn',state:'connected'});true`);
    await sleep(7_500);
    const fallback = await snapshot(targetId);
    report.fallback = fallback;
    check("拿不到清单时兜底新建会话", fallback.creates === 1, `creates ${fallback.creates}`);

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
