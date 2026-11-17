import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchRealPath, REPO, requireHeadless, siteAddress, until } from './harness.mts';
import { startScriptedModel } from './scripted-model.mts';

requireHeadless();
const held = process.argv.includes('--held'), busy = process.argv.includes('--busy');
const out = join(REPO, 'out/acceptance/real-path', `${new Date().toISOString().replace(/[:.]/g, '-')}-typed-chat-image${held?'-held':busy?'-busy':''}`);
await mkdir(out, { recursive: true });
const FIRST = '先读一下这个页面';
const QUESTION = '你根本没有看我发给你的图片';
const ANSWER = '图里是一页扫描件，我看到了。';
const AMBIGUOUS = '把它改一下';
const CLARIFICATION = '请说明是哪一件。';
const checks: Record<string, boolean> = {};
type Part = { type?: string; text?: string };
type Message = { role: string; content?: string | Part[] | null };
const textOf = (content: Message['content']) => Array.isArray(content) ? content.map(part => part.text ?? '').join('') : content ?? '';
const seen: Array<{ tools: boolean; images: number; parts?: string[]; note?: string }> = [];
const model = await startScriptedModel([
  { match: '"lastReply"', steps: [{ text: '{"status":"open","remaining":"还可以继续补充"}' }] },
  { match: QUESTION, steps: [{ text: ANSWER }] },
  { match: FIRST, steps: held ? [{tool:{name:'hand_to_user',args:{ask:'请在页面上完成验证'}}},{text:'不应继续原任务。'}]
    : [{ tool: { name: 'tabs', args: { action: 'list' } } }, { text: '页面读完了。', ...(busy?{delayMs:30_000}:{}) }] },
], undefined, payload => {
  const user = (payload.messages as Message[] | undefined)?.find(m => m.role === 'user' && textOf(m.content).includes(QUESTION) && !textOf(m.content).startsWith('本次运行的上下文'));
  if (user) seen.push({ tools: !!payload.tools?.length, images: Array.isArray(user.content) ? user.content.filter(part => part.type === 'image_url' || part.type === 'image').length : 0, parts: Array.isArray(user.content) ? user.content.map(part => part.type ?? '?') : ['string'], note: textOf(user.content).slice(0, 600) });
});
const routes: unknown[] = [];
const proxy = createServer(async (req, res) => {
  let body = ''; req.setEncoding('utf8'); for await (const chunk of req) body += chunk;
  if (req.method === 'GET' && (req.url ?? '').endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [{ id: 'fixture', object: 'model', modalities: { input: ['text', 'image'] } }] })); return; }
  const payload = body ? JSON.parse(body) : {};
  const system = payload.messages?.find((m: { role: string }) => m.role === 'system')?.content ?? '';
  if (String(system).includes('Route a user\'s message for a browser assistant managing independent tasks')) {
    const last = payload.messages.at(-1).content;
    const data = JSON.parse(typeof last === 'string' ? last : last.map((p: { text?: string }) => p.text ?? '').join(''));
    const steps = data.message === QUESTION ? [{ action: 'chat', taskId: null }]
      : [{ action: 'clarify', taskId: null, question: CLARIFICATION }];
    routes.push({ message: data.message, steps });
    const content = JSON.stringify({ steps });
    if (payload.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end(`data: ${JSON.stringify({ id: 'route', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'route', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    } else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'route', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
    return;
  }
  const cancel = new AbortController(); res.on('close', () => { if (!res.writableFinished) cancel.abort(); });
  try { const upstream = await fetch(`${model.baseUrl.replace(/\/$/, '')}${(req.url ?? '').replace(/^\/v1/, '')}`, { method: req.method, headers: { 'content-type': 'application/json' }, body: req.method === 'POST' ? body : undefined, signal: cancel.signal }); res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' }).end(Buffer.from(await upstream.arrayBuffer())); } catch { if (!res.headersSent) res.writeHead(502).end(); }
});
await new Promise<void>(r => proxy.listen(0, '127.0.0.1', r));
const rp = await launchRealPath(); let error: string | null = null, panel = '';
try {
  panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: 'custom', modelId: 'fixture', baseUrl: `http://127.0.0.1:${siteAddress(proxy).port}/v1` }, 'inproc_cred:custom': { type: 'api_key', key: 'local-fixture' }, inproc_custom_catalog: { baseUrl: `http://127.0.0.1:${siteAddress(proxy).port}/v1`, models: [{ id: 'fixture', images: true }] } })}).then(()=>true)`);
  const ready = () => until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.getAttribute("aria-busy")==="false" && document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, '侧栏与连接就绪');
  const say = async (text: string) => { await rp.click(panel, '#input'); await rp.typeText(panel, text); await rp.pressEnter(panel); };
  const visible = () => rp.evaluate(panel, 'document.querySelector("#messages").innerText') as Promise<string>;
  const sending = () => rp.evaluate(panel, '!!document.querySelector("#materials-tray-root .mt-delivery[data-state=sending], #materials-tray-root .mt-delivery[data-state=queued]")') as Promise<boolean>;
  await ready(); await say(FIRST);
  if (held) await until(async () => await rp.evaluate(panel,'!!document.querySelector(".handoff-card .btn-primary:not(:disabled)")') || undefined,30_000,'原任务交给用户');
  else if (busy) await until(async () => model.requests.some(r=>r.rule===FIRST&&r.step===1) || undefined,30_000,'原任务仍在执行');
  else await until(async () => (await visible()).includes('页面读完了') || undefined, 40_000, '第一件答完');
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 30_000, '可以继续发送');
  const root = await rp.cdp.send('DOM.getDocument', {}, panel) as { root: { nodeId: number } };
  const { nodeId } = await rp.cdp.send('DOM.querySelector', { nodeId: root.root.nodeId, selector: '#file-input' }, panel) as { nodeId: number };
  await rp.cdp.send('DOM.setFileInputFiles', { nodeId, files: [join(REPO, 'scripts/acceptance/fixtures/files/scan-page.png')] }, panel);
  await until(async () => await rp.evaluate(panel, '!!document.querySelector("#attachments-strip:not([hidden]) .tile-56, #attachments-strip:not([hidden]) img")') || undefined, 20_000, '图片挂上');
  await say(QUESTION);
  if (held || busy) {
    const refusal = await until(async () => {const text=await visible();return ['页面现在归你','这个新请求要另开会话吗'].find(copy=>text.includes(copy));},20_000,'新问题没有变成修改或续做');
    checks.originalTaskPreserved = held ? await rp.evaluate(panel,'!!document.querySelector(".handoff-card .btn-primary:not(:disabled)")') as boolean : !(await visible()).includes('页面读完了');
    checks.onlyOneNotice = await rp.evaluate(panel,'document.querySelectorAll(".receipt-decision, .receipt.notice").length===1') as boolean;
    checks.sendingCleared = !await sending();
    await rp.screenshot(panel,join(out,'preserved.png'));
    await rp.cdp.send('Page.reload',{},panel); await ready();
    await until(async () => (await visible()).includes(refusal) || undefined,20_000,'重开后保留新问题结果');
    checks.replayedOnce = await rp.evaluate(panel,'document.querySelectorAll(".receipt-decision, .receipt.notice").length===1') as boolean;
    await rp.screenshot(panel,join(out,'reopened.png'));
    assert.ok(Object.values(checks).every(Boolean),JSON.stringify(checks));
  } else {
  await until(async () => (await visible()).includes(ANSWER) || undefined, 40_000, '对贴图的回答出现');
  await rp.screenshot(panel, join(out, 'answer.png'));
  checks.chatRouted = routes.some((r: any) => r.message === QUESTION && r.steps[0].action === 'chat');
  checks.imageDelivered = seen.some(s => s.tools && s.images >= 1);
  checks.chatSendingCleared = !await sending();
  await ready(); await say(AMBIGUOUS);
  await until(async () => (await visible()).includes(CLARIFICATION) || undefined, 20_000, '澄清问题出现');
  checks.clarifySendingCleared = !await sending();
  await rp.screenshot(panel, join(out, 'clarification.png'));
  assert.deepEqual(checks, { chatRouted: true, imageDelivered: true, chatSendingCleared: true, clarifySendingCleared: true });
  }
} catch (e) { error = e instanceof Error ? e.stack ?? e.message : String(e); if(panel)await rp.screenshot(panel,join(out,'failure.png')).catch(()=>{}); } finally {
  await writeFile(join(out, 'result.json'), JSON.stringify({ status: error ? 'FAIL' : 'PASS', error, checks, routes, seen, requests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); proxy.closeAllConnections(); proxy.close();
}
console.log(JSON.stringify({ status: error ? 'FAIL' : 'PASS', out, error }));
if (error) process.exitCode = 1;
