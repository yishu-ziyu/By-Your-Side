#!/usr/bin/env node
/**
 * Run: node --import tsx scripts/acceptance/recovery-run.mjs [--scenario=hover|selector|stale|noop]
 * Real model + production BrowserAgentSession/ToolRpc + existing SW acceptance hook.
 * Faults are evaluator-seeded real tool calls, not model-generated failures.
 * Only local fixtures are operated. No model mocks, DOM mutations or submit actions.
 */
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BrowserAgentSession } from '../../agent/src/session.ts';
import { ToolRpc } from '../../agent/src/rpc.ts';
import { loadConfig } from '../../agent/src/config.ts';
import { Agent, ProxyAgent, setGlobalDispatcher } from 'undici';
import { discoverChromeMain } from './discover.mjs';
import { connectBrowser, evaluateInWorker, findServiceWorker } from './cdp.mjs';
import { sideagentExtensionId } from './constants.mjs';
import { installExecuteToolCallHook, normalizeServiceWorkerInspector } from './sw-hook.mjs';

const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const scenarios = arg('scenario') ? [arg('scenario')] : ['hover', 'selector', 'stale', 'noop'];
if (scenarios.some((name) => !['hover', 'selector', 'stale', 'noop'].includes(name))) throw new Error('Unknown scenario');
const root = process.env.ACCEPT_EVIDENCE_DIR || join(process.cwd(), 'out/acceptance', `recovery-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const config = loadConfig();
if (config.proxy) {
  const proxyAgent = new ProxyAgent(config.proxy);
  const directAgent = new Agent();
  setGlobalDispatcher(new Agent({ factory(origin) {
    const hostname = typeof origin === 'string' ? new URL(origin).hostname : origin.hostname;
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname) ? directAgent : proxyAgent;
  } }));
}
await mkdir(root, { recursive: true });
const fixtureHtml = await readFile(new URL('../../extension/test/fixtures/recovery.html', import.meta.url));
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(fixtureHtml);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let cdp;
const results = [];
function compact(value) {
  return JSON.parse(JSON.stringify(value, (key, item) => key === 'imageBase64' ? `[image omitted, base64 chars=${String(item).length}]` : item));
}
try {
  const connection = discoverChromeMain();
  ({ cdp } = await connectBrowser(connection.port));
  const extId = sideagentExtensionId();
  const { targetInfos } = await cdp.send('Target.getTargets');
  const sw = findServiceWorker(targetInfos, extId);
  if (!sw) throw new Error('Production extension service worker unavailable');
  const swSession = await cdp.attachSession(sw.targetId);
  await normalizeServiceWorkerInspector(cdp, swSession);
  await installExecuteToolCallHook(cdp, swSession, extId, origin);
  const control = await evaluateInWorker(cdp, swSession, '({ gate: globalThis.__saGate?.(), team: globalThis.__saTeamView?.() })');
  await writeFile(join(root, 'initial-control.json'), JSON.stringify(control, null, 2));
  if (control.gate?.user || control.gate?.draining || control.team?.members?.some((member) => member.activity === 'running')) {
    throw new Error('Existing user takeover or running team detected; fixture run not started');
  }
  for (const scenario of scenarios) {
    const startedAt = Date.now();
    const dir = join(root, scenario);
    await mkdir(dir, { recursive: true });
    const sid = `recovery-${scenario}-${startedAt}`;
    const records = [];
    const events = [];
    let agent;
    let tabId;
    let model;
    let finalError;
    let runEnded = false;
    let runStarted = false;
    let sequence = 0;
    let source = 'evaluator';
    const writeRecord = async (record) => {
      records.push(record);
      await appendFile(join(dir, 'tools.jsonl'), JSON.stringify(compact(record)) + '\n');
    };
    const raw = async (name, params = {}, id = `${sid}-${++sequence}`, callSource = source) => {
      const begin = Date.now();
      const frame = await evaluateInWorker(cdp, swSession,
        `globalThis.__saCall(${JSON.stringify(id)},${JSON.stringify(name)},${JSON.stringify(params)},${JSON.stringify(sid)})`, 65000);
      await writeRecord({ taskId: sid, id, source: callSource, name, params, startedAt: begin, endedAt: Date.now(), elapsedMs: Date.now() - begin, ...frame });
      return frame;
    };
    const call = async (name, params = {}) => {
      const frame = await raw(name, params);
      if (!frame?.ok) throw new Error(frame?.error || `${name} failed`);
      return frame.data;
    };
    const shot = async (name) => {
      const data = await call('screenshot');
      if (data.imageBase64) await writeFile(join(dir, `${name}.png`), Buffer.from(data.imageBase64, 'base64'));
    };
    try {
      ({ tabId } = await call('open_tab', { url: `${origin}/?scenario=${scenario}` }));
      await call('hover', { target: 'h1' });
      const context = { tabId, title: '浏览器恢复验收 · 本地项目草稿', url: `${origin}/?scenario=${scenario}` };
      const before = await call('snapshot');
      await writeFile(join(dir, 'before.txt'), before.text);
      await shot('before');
      const seeded = [];
      if (scenario === 'selector') {
        seeded.push(await raw('click', { target: 'loc=h3:has-text("项目经历")' }));
        if (seeded[0].ok) throw new Error('Invalid selector unexpectedly passed');
      }
      if (scenario === 'stale') {
        await call('hover', { target: '#project' });
        const current = await call('snapshot');
        const line = current.text.split('\n').find((line) => line.includes('编辑项目') && /ref=\d+/.test(line));
        const ref = line?.match(/ref=(\d+)/)?.[1];
        if (!ref) throw new Error('No editable project ref in actual hovered snapshot');
        await call('click', { target: '#replace-project' });
        seeded.push(await raw('click', { target: `@${ref}` }));
        if (seeded[0].ok) throw new Error('Replaced node stale reference unexpectedly passed');
      }
      if (scenario === 'noop') {
        seeded.push(await raw('click', { target: '#noop' }));
        const state = await call('js', { code: '(() => window.readRecoveryEvidence())()' });
        if (state.value.editorVisible) throw new Error('No-op fixture unexpectedly opened editor');
        await writeFile(join(dir, 'after-noop-state.json'), JSON.stringify(state, null, 2));
      }
      const rpc = new ToolRpc((frame) => {
        void raw(frame.name, frame.params, frame.id, 'model').then(
          (result) => rpc.handleResult(frame.id, result.ok, result.data, result.error),
          (error) => rpc.handleResult(frame.id, false, undefined, String(error)),
        );
      });
      agent = await BrowserAgentSession.create(rpc, {
        emit(event) {
          events.push({ time: Date.now(), ...event });
          if (event.kind === 'agent_start') runStarted = true;
          if (event.kind === 'agent_end') runEnded = true;
          if (event.kind === 'error') finalError = event.message;
          if (event.kind === 'tool_start') console.log(`${scenario}: ${event.name}`);
        },
        setStatus() {},
      });
      if (!agent.available) throw new Error('Real model session unavailable');
      const models = await agent.availableModels();
      model = arg('model') || (/minimax-m3/i.test(config.model || '') ? config.model : undefined) || models.find((candidate) => /minimax-m3/i.test(candidate.modelId))?.id;
      if (!model) throw new Error('MiniMax-M3 unavailable; no fallback model permitted');
      await agent.setModel(model);
      const draft = `RECOVERY_DRAFT_${scenario}_20260907`;
      const task = `请在当前本地页面编辑“红鲱鱼与枪”项目，把项目描述填写为：${draft}。填写后检查实际内容，停在草稿状态，禁止点击提交或保存。请使用真实浏览器交互完成，JS仅可读取页面，不能修改DOM、调用页面动作函数或直接赋值。`;
      const setup = seeded.length ? `\n验收设置说明：以下是校验者在你开始前通过同一真实浏览器工具执行的尝试及原始返回，不是你产生的调用。请保留上述目标，根据页面和工具反馈继续完成：\n${JSON.stringify(compact(seeded))}` : '';
      source = 'model';
      agent.sendUserMessage(task + setup, context);
      const deadline = Date.now() + 360000;
      while ((!runStarted || !runEnded || agent.isStreaming()) && !finalError && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!runStarted || !runEnded || agent.isStreaming()) {
        agent.abort();
        throw new Error('Evaluator observation deadline reached; not a product failure cutoff');
      }
      if (finalError) throw new Error(finalError);
      source = 'evaluator';
      const after = await call('snapshot');
      const state = (await call('js', { code: '(() => window.readRecoveryEvidence())()' })).value;
      await writeFile(join(dir, 'after.txt'), after.text);
      await shot('after');
      const modelCalls = records.filter((record) => record.source === 'model');
      const forbiddenJs = modelCalls.filter((record) => record.name === 'js' && /\.click\s*\(|dispatchEvent|\.value\s*=|\.hidden\s*=|\.style\s*[.=]|readRecoveryEvidence\s*\([^)]*,/.test(record.params.code));
      const passed = state.editorVisible && state.draft === draft && state.submitted === 0 && state.hoverCount > 0 && modelCalls.some((record) => record.name === 'fill' && record.ok) && forbiddenJs.length === 0 && (scenario !== 'hover' || modelCalls.some((record) => record.name === 'hover' && record.ok));
      results.push({ scenario, taskId: sid, passed, state, model, startedAt, elapsedMs: Date.now() - startedAt,
        modelToolCount: modelCalls.length, evaluatorToolCount: records.length - modelCalls.length, humanInterventions: 0,
        faultSeeding: seeded.length ? 'Evaluator executed real tools; raw result included in model task' : 'none',
        forbiddenJs, evidenceDir: dir, screenshots: ['before.png', 'after.png'] });
      console.log(`${scenario}: ${passed ? 'PASS' : 'FAIL'} ${Date.now() - startedAt}ms ${modelCalls.length} model tools`);
    } catch (error) {
      results.push({ scenario, taskId: sid, passed: false, error: String(error), model, elapsedMs: Date.now() - startedAt, humanInterventions: 0, evidenceDir: dir });
      console.error(`${scenario}: ${error}`);
    } finally {
      source = 'evaluator';
      await writeFile(join(dir, 'events.json'), JSON.stringify(events, null, 2));
      await writeFile(join(dir, 'result.json'), JSON.stringify(results.at(-1), null, 2));
      agent?.dispose();
      if (tabId) await raw('close_tab', { tabId }).catch(() => {});
    }
  }
  await writeFile(join(root, 'result.json'), JSON.stringify({ connection: { bundle: connection.wrapperBundleId, port: connection.port }, results,
    handback: { verified: false, reason: 'This runner does not operate the production takeover/handback UI. Separate UI acceptance required.' } }, null, 2));
  process.exitCode = results.every((record) => record.passed) ? 0 : 1;
} catch (error) {
  await writeFile(join(root, 'fatal.json'), JSON.stringify({ error: String(error), results }, null, 2));
  console.error(error);
  process.exitCode = 1;
} finally {
  if (cdp) await cdp.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  console.log(`Evidence: ${root}`);
}
process.exit(process.exitCode || 0);
