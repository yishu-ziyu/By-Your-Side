/** Process durability probe, not browser execution or microphone acceptance. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {loadConfig} from '../../agent/src/config.js';
import {ConversationStore} from '../../agent/src/conversation-store.js';
import {projectTaskView} from '../../shared/task-view.js';
import {startHost, stopHost} from './product-journeys/runner.mjs';

const file = resolve(process.argv[1]!);
const [mode, directory, sourceArg] = process.argv.slice(2);
const source = sourceArg === 'voice' ? 'voice' : 'text';
const request = {
  requestId: `sigkill-${source}`, conversationId: 'default', source,
  action: 'start' as const, expectedRunId: null,
  text: '核对附件内容；不要操作网页。',
  context: {tabId: 7, title: '恢复材料', url: 'https://fixture.test/form'},
  attachments: [{id: 'fixture', type: 'image' as const, name: 'fixture.png', mimeType: 'image/png' as const,
    dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII='}],
};

if (mode === 'accept' || mode === 'restore') {
  assert(directory);
  const host = await startHost(loadConfig().model!, directory, []);
  if (mode === 'accept') {
    const receipt = await host.manager.dispatchTaskAction(request);
    assert.equal(receipt.status, 'accepted');
    writeFileSync(join(directory, 'accepted.json'), JSON.stringify({receipt, snapshot: host.manager.getTaskProgress('default')}));
    // No disconnect/dispose hook: the kernel ends this exact child process.
    process.kill(process.pid, 'SIGKILL');
  } else {
    const snapshot = host.manager.getTaskProgress('default');
    const receipt = await host.manager.dispatchTaskAction(request);
    writeFileSync(join(directory, 'restored.json'), JSON.stringify({receipt, snapshot}));
    await stopHost(host);
  }
} else {
  assert.equal(mode, '--report', 'usage: tsx accepted-task-sigkill.mts --report <new directory>');
  assert(directory);
  const out = resolve(directory);
  mkdirSync(out, {recursive: true});
  const run = (phase: string, dir: string, input: string) => new Promise<{code:number|null;signal:string|null}>((done, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', file, phase, dir, input], {stdio: ['ignore', 'pipe', 'pipe']});
    let log = '';
    child.stdout.on('data', chunk => {log += chunk;});
    child.stderr.on('data', chunk => {log += chunk;});
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      writeFileSync(join(dir, `${phase}.log`), log);
      done({code, signal});
    });
  });
  const checks = [];
  for (const input of ['text', 'voice']) {
    const dir = join(out, input);
    mkdirSync(dir); // refuse to overwrite an earlier run
    const killed = await run('accept', dir, input);
    assert.equal(killed.signal, 'SIGKILL');
    const accepted = JSON.parse(readFileSync(join(dir, 'accepted.json'), 'utf8'));
    const session = new ConversationStore(join(dir, 'conversations')).sessionManager('default');
    const entries = readFileSync(session.getSessionFile()!, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert(!entries.some(entry => entry.message?.role === 'assistant'), 'must kill before first assistant output');
    const envelope = entries.find(entry => entry.customType === 'sideagent-task-acceptance-v1');
    assert.deepEqual(envelope.data.attachments, request.attachments);
    assert.equal((await run('restore', dir, input)).code, 0);
    const restored = JSON.parse(readFileSync(join(dir, 'restored.json'), 'utf8'));
    assert.equal(restored.snapshot.state, 'interrupted');
    assert.equal(restored.snapshot.runId, accepted.snapshot.runId);
    assert.equal(restored.snapshot.goal, request.text);
    assert.deepEqual(restored.snapshot.recoveryInput, accepted.snapshot.recoveryInput);
    assert.deepEqual(projectTaskView(restored.snapshot).materials, projectTaskView(accepted.snapshot).materials);
    assert.deepEqual(restored.receipt, accepted.receipt);
    checks.push({source: input, passed: true, signal: killed.signal, runId: restored.snapshot.runId});
  }
  writeFileSync(join(out, 'result.json'), JSON.stringify({scope: 'accepted task action / SIGKILL / new process restore', checks}, null, 2));
  console.log(JSON.stringify(checks));
}
