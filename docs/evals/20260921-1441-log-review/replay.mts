// Read local evidence and exercise production boundaries offline. No browser or provider connection.
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import assert from 'node:assert/strict';
import {TaskEvidence} from '../../../agent/src/task-evidence.js';
import {TaskGoalBook} from '../../../agent/src/task-goals.js';
import {RealtimeVoiceConnection, MODEL, STEP_VOICE} from '../../../agent/src/realtime-voice-connection.js';
import {createSendUserMessageTool} from '../../../agent/src/user-delivery.js';

const path = join(homedir(), '.sideagent/traces/1789972957328-301bc278-8936-41c4-8912-7b11f4a32da8.jsonl');
const rows = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
const observation = rows.find(r => r.type === 'tool_execution_end' && r.data.result?.details?.fragments)?.data.result.details;
assert(observation, 'Expected the actual recorded source observation');
const evidence = new TaskEvidence();
const captures = rows.filter(r => r.type === 'tool_execution_start' && r.data.toolName === 'capture_page_material');
const materialReplay = captures.filter(r => r.data.args.observationId === observation.id).map(r => {
  const args = r.data.args;
  const fragments = observation.fragments.fragments;
  const first = fragments.findIndex((f: any) => f.id === args.selection.first);
  const last = fragments.findIndex((f: any) => f.id === args.selection.last);
  const chars = fragments.slice(first, last + 1).map((f: any) => f.text).join('').length;
  try {
    evidence.prepareFragments(args.materialId, args.purpose, observation, args.selection.first, args.selection.last);
    return {time: r.time, chars, prepare: 'accepted'};
  } catch (error) {
    return {time: r.time, chars, prepare: String((error as Error).message)};
  }
});
assert(materialReplay.some(r => r.chars > 8000 && r.prepare.includes('预算')));
const plans = rows.filter(r => r.type === 'tool_execution_start' && r.data.toolName === 'task_goals' && r.data.args.action === 'plan');
const goalBook = new TaskGoalBook();
const request = rows.find(r => r.type === 'run_start').data.text;
goalBook.require([request]);
const revision = goalBook.snapshot()!.revision;
goalBook.install(revision, plans[0].data.args.goals, 1);
let replanError = '';
try { goalBook.install(revision, plans[1].data.args.goals, 1); }
catch (error) { replanError = (error as Error).message; }
assert(replanError.includes('固定'));

class Socket extends EventEmitter {
  readyState = 1;
  sent: any[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; }
  server(event: unknown) { this.emit('message', Buffer.from(JSON.stringify(event))); }
}
const socket = new Socket(), client: any[] = [], voiceLog: any[] = [];
let finishRead!: (value: unknown) => void;
const connection = new RealtimeVoiceConnection({
  key: 'offline-placeholder', connect: () => socket as any,
  send: event => client.push(event), log: event => voiceLog.push(event),
  tools: {browser_request: async () => ({}), task_status: async () => ({}), read_page: () => new Promise(resolve => { finishRead = resolve; })},
});
connection.start();
socket.server({type: 'session.created', session: {model: MODEL}});
socket.server({type: 'session.updated', session: {model: MODEL, voice: STEP_VOICE, input_audio_format: 'pcm16', output_audio_format: 'pcm16', turn_detection: {type: 'server_vad'}}});
socket.server({type: 'input_audio_buffer.speech_started', item_id: 'old'});
socket.server({type: 'input_audio_buffer.speech_stopped', item_id: 'old'});
socket.server({type: 'response.created', response: {id: 'old-response'}});
socket.server({type: 'response.function_call_arguments.done', response_id: 'old-response', call_id: 'read', name: 'read_page', arguments: '{}'});
socket.server({type: 'response.done', response: {id: 'old-response', status: 'completed'}});
socket.server({type: 'input_audio_buffer.speech_started', item_id: 'new'});
finishRead({ok: true, text: 'offline page'});
await new Promise(resolve => setImmediate(resolve));
const toolOutputsWhileSpeaking = socket.sent.filter(e => e.item?.type === 'function_call_output').length;
socket.server({type: 'conversation.item.input_audio_transcription.completed', item_id: 'old', transcript: '此前那一句'});
socket.server({type: 'input_audio_buffer.speech_stopped', item_id: 'new'});
const createsBeforeNextResponseCreated = socket.sent.filter(e => e.type === 'response.create').length;
const voiceReplay = {
  toolOutputsWhileSpeaking,
  toolOutputsAfterSpeechStopped: socket.sent.filter(e => e.item?.type === 'function_call_output').length,
  createsBeforeNextResponseCreated,
  retainedAsrLogged: voiceLog.some(e => e.type === 'late_asr_retained'),
  retainedAsrSentToClient: client.some(e => e.type === 'transcript' && e.itemId === 'old'),
};
connection.close();
assert.equal(toolOutputsWhileSpeaking, 0);
assert.equal(createsBeforeNextResponseCreated, 1);
assert.equal(voiceReplay.retainedAsrSentToClient, false);

let attachCalls = 0, mockAttached = false;
(globalThis as any).chrome = {debugger: {
  attach: async () => {
    attachCalls++;
    if (mockAttached) throw new Error('Another debugger is already attached');
    mockAttached = true;
    await new Promise(resolve => setImmediate(resolve));
  },
  detach: async () => { mockAttached = false; },
  sendCommand: async () => ({}),
  onEvent: {addListener() {}}, onDetach: {addListener() {}},
}};
const realSetTimeout = globalThis.setTimeout;
const timers: ReturnType<typeof setTimeout>[] = [];
(globalThis as any).setTimeout = (...args: Parameters<typeof setTimeout>) => {
  const timer = realSetTimeout(...args); timers.push(timer); return timer;
};
let debuggerReplay;
try {
  const debuggerModule = await import('../../../extension/src/background/debugger.js');
  const results = await Promise.allSettled([debuggerModule.ensureAttached(7), debuggerModule.ensureAttached(7)]);
  debuggerReplay = {attachCalls, results: results.map(r => r.status === 'fulfilled' ? 'fulfilled' : r.reason.message)};
  await debuggerModule.detachAll();
} finally {
  globalThis.setTimeout = realSetTimeout;
  timers.forEach(clearTimeout);
}
assert.equal(attachCalls, 2);

let answerChecks = 0;
const deliveries: any[] = [];
const deliver = createSendUserMessageTool({
  conversationId: 'offline-review', getRunId: () => 'offline-run', emit: event => deliveries.push(event),
  getNextStep: () => ({action: 'ask_user', reason: 'open_task', allowWrites: false, delivery: 'report', resultIds: []}) as any,
  verifyAnswer: async () => { answerChecks++; throw new Error('unverified claims'); },
});
await deliver.execute('offline-delivery', {kind: 'finding', outcome: 'partial', content: '页面已圈好'}, new AbortController().signal, undefined, {} as never);
const deliveryReplay = {answerChecks, text: deliveries[0]?.delivery.text};
assert.equal(answerChecks, 0);
assert(deliveryReplay.text?.startsWith('页面已圈好'));
console.log(JSON.stringify({materialReplay, replanError, voiceReplay, debuggerReplay, deliveryReplay}, null, 2));
