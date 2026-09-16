/** Controlled session boundaries, with real BrowserAgentSession and fake transport/Pi timing.
 * No model or browser claim; complements continuous-steering.mts.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { BrowserAgentSession } from '../../agent/src/session.js';

const out = resolve('out/acceptance', `steering-races-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(out, { recursive: true });
const hashes = { session: createHash('sha256').update(await readFile('agent/src/session.ts')).digest('hex') };
function harness() {
  let listener: (event: any) => void = () => {};
  let release!: (value: any) => void;
  const observation = new Promise(resolve => { release = resolve; });
  const queued: string[] = [];
  const emitted: any[] = [];
  const raw = {
    isStreaming: true,
    steer: async (text: string) => { queued.push(text); },
    subscribe: (fn: (event: any) => void) => { listener = fn; },
    clearQueue: () => ({ steering: queued.splice(0), followUp: [] }),
    abort: async () => { raw.isStreaming = false; },
    agent: { waitForIdle: async () => {}, state: { messages: [] } },
  };
  const rpc = { call: async () => observation, onLateResult: undefined };
  const session = new (BrowserAgentSession as any)(raw, null, { emit: (event: any) => emitted.push(event), setStatus: () => {} }, null, null, undefined, null, rpc);
  session.subscribeEvents();
  return { session, raw, queued, emitted, release, event: (event: any) => listener(event) };
}
const cases: any[] = [];
const context = { tabId: 10, title: 'fixture', url: 'http://127.0.0.1/fixture' };
{
  const h = harness();
  const pending = h.session.steerCurrentTask('不是这个页面，改当前页面', context);
  const blockedDuringObservation = !h.session.canWriteCurrentInput();
  h.release({ text: 'fresh fixture' }); await pending;
  cases.push({ name: 'old writes blocked while fresh-page observation waits', passed: blockedDuringObservation });
}
{
  const h = harness();
  await h.session.steerCurrentTask('重复要求'); await h.session.steerCurrentTask('重复要求');
  h.event({ type: 'message_start', message: { role: 'user', content: h.queued[0] } });
  const blockedAfterFirst = !h.session.canWriteCurrentInput();
  h.event({ type: 'message_start', message: { role: 'user', content: h.queued[1] } });
  cases.push({ name: 'identical inputs remain distinct until both are consumed', passed: blockedAfterFirst && h.session.canWriteCurrentInput(), blockedAfterFirst });
}
{
  const h = harness();
  const pending = h.session.steerCurrentTask('不是这个页面，改当前页面', context);
  h.session.abort();
  h.release({ text: 'late observation' });
  let rejected = false;
  try { await pending; } catch { rejected = true; }
  cases.push({ name: 'stop during observation prevents later steer enqueue', passed: rejected && h.queued.length === 0, rejected, queuedAfterStop: h.queued.length });
}
const report = { passed: cases.every(c => c.passed), scope: 'real session wrapper with controlled observation and Pi events; no live model/browser', cases, hashes };
await writeFile(join(out, 'result.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ out, ...report }));
if (!report.passed) process.exitCode = 1;
