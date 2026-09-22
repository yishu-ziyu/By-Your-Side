// Re-run the 14:41 replay scenarios against the repaired modules and report, per scenario, what the
// original "defect still present" checks would now see. Reads the real trace; no browser, provider or Jev.
// The historical script docs/evals/20260921-1441-log-review/replay.mts is left untouched on purpose.
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {TaskEvidence, MATERIAL_VALUE_MAX} from '../../../agent/src/task-evidence.js';
import {TaskGoalBook} from '../../../agent/src/task-goals.js';
import {RealtimeVoiceConnection, MODEL, STEP_VOICE} from '../../../agent/src/realtime-voice-connection.js';
import {createSendUserMessageTool} from '../../../agent/src/user-delivery.js';

const path = join(homedir(), '.sideagent/traces/1789972957328-301bc278-8936-41c4-8912-7b11f4a32da8.jsonl');

const rows = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));

const report: Record<string, unknown> = {};

// 1. Material over budget: the error must now state the actual length, the limit and a way forward.
const observation = rows.find(r => r.type === 'tool_execution_end' && r.data.result?.details?.fragments)?.data.result.details;

const capture = rows.find(r => r.type === 'tool_execution_start' && r.data.toolName === 'capture_page_material' && r.data.args.observationId === observation.id);

let materialError = '';

try { new TaskEvidence().prepareFragments(capture.data.args.materialId, capture.data.args.purpose, observation, capture.data.args.selection.first, capture.data.args.selection.last); }
catch (error) { materialError = (error as Error).message; }

const actualChars = materialError.match(/共 (\d+) 字符/)?.[1];

report.material = {limit: MATERIAL_VALUE_MAX, error: materialError, statesActualLength: actualChars === '9830', statesLimit: materialError.includes(String(MATERIAL_VALUE_MAX)), offersAmendPath: materialError.includes('reason')};

// 2. Fixed plan: plain re-install is still rejected; an amend with reason drops the internal material goal and keeps both condition goals verbatim.
const plans = rows.filter(r => r.type === 'tool_execution_start' && r.data.toolName === 'task_goals' && r.data.args.action === 'plan');

const book = new TaskGoalBook();

book.require([rows.find(r => r.type === 'run_start').data.text]);

const revision = book.snapshot()!.revision;

book.install(revision, plans[0].data.args.goals, 1);

let installError = '', amendError = '';

try { book.install(revision, plans[1].data.args.goals, 1); } catch (error) { installError = (error as Error).message; }

try { book.amend(revision, plans[1].data.args.goals, 1, '整篇原文超过单份材料上限；保存原文只是内部方法，用户要求是页面圈词，移除该来源目标'); } catch (error) { amendError = (error as Error).message; }

const after = book.snapshot()!;

report.plan = {
  installStillRejected: installError.includes('固定'), amendError,
  goals: after.goals.map(g => ({id: g.id, kind: g.kind, status: g.status})), amendments: after.amendments,
  conditionCriteriaPreserved: after.goals.filter(g => g.kind === 'condition').every(g => plans[0].data.args.goals.some((o: {id: string; criterion: string}) => o.id === g.id && o.criterion === g.criterion)),
};

// 3. Voice: same event order as the incident. Nothing may be sent between speech_stopped and the server's own response.created.
class Socket extends EventEmitter {
  readyState = 1; sent: any[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; }
  server(event: unknown) { this.emit('message', Buffer.from(JSON.stringify(event))); }
}

const socket = new Socket(), client: any[] = [], voiceLog: any[] = [];

let finishRead!: (value: unknown) => void;

const connection = new RealtimeVoiceConnection({
  key: 'offline-placeholder', connect: () => socket as any, send: event => client.push(event), log: event => voiceLog.push(event),
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

socket.server({type: 'conversation.item.input_audio_transcription.completed', item_id: 'old', transcript: '此前那一句'});

socket.server({type: 'input_audio_buffer.speech_stopped', item_id: 'new'});

const count = (pred: (e: any) => boolean) => socket.sent.filter(pred).length;

const createsInWindow = count(e => e.type === 'response.create'), outputsInWindow = count(e => e.item?.type === 'function_call_output');

socket.server({type: 'response.created', response: {id: 'new-response'}});

const outputsWhileGenerating = count(e => e.item?.type === 'function_call_output');

socket.server({type: 'response.done', response: {id: 'new-response', status: 'completed'}});

report.voice = {
  createsBeforeNextResponseCreated: createsInWindow, toolOutputsBeforeNextResponseCreated: outputsInWindow,
  toolOutputsWhileAutoResponseGenerating: outputsWhileGenerating,
  toolOutputsAfterAutoResponseDone: count(e => e.item?.type === 'function_call_output'), createsAfterAutoResponseDone: count(e => e.type === 'response.create'),
  retainedAsrSentToClient: client.some(e => e.type === 'transcript' && e.itemId === 'old'),
  responseCreatedLogged: voiceLog.filter(e => e.type === 'response_created').map(e => ({responseId: e.responseId, requested: e.requested, autoPending: e.autoPending})),
};

connection.close();

// 4. Debugger: two concurrent ensureAttached on one tab must attach once.
let attachCalls = 0, mockAttached = false;

(globalThis as any).chrome = {debugger: {
  attach: async () => { attachCalls++;

 if (mockAttached) throw new Error('Another debugger is already attached'); mockAttached = true; await new Promise(resolve => setImmediate(resolve)); },
  detach: async () => { mockAttached = false; }, sendCommand: async () => ({}), onEvent: {addListener() {}}, onDetach: {addListener() {}},
}};

const realSetTimeout = globalThis.setTimeout, timers: ReturnType<typeof setTimeout>[] = [];

(globalThis as any).setTimeout = (...args: Parameters<typeof setTimeout>) => { const timer = realSetTimeout(...args); timers.push(timer);

 return timer; };

try {
  const debuggerModule = await import('../../../extension/src/background/debugger.js');
  const results = await Promise.allSettled([debuggerModule.ensureAttached(7), debuggerModule.ensureAttached(7)]);
  report.debugger = {attachCalls, results: results.map(r => r.status === 'fulfilled' ? 'fulfilled' : (r as PromiseRejectedResult).reason.message)};
  await debuggerModule.detachAll();
} finally { globalThis.setTimeout = realSetTimeout; timers.forEach(clearTimeout); }

// 5. Partial delivery: the incident text, through the production tool. Without the host hook (legacy default) it still sends;
// with the hook session.ts now wires (here a stub standing in for the Jev-backed check) it is rejected before any emit.
const incidentText = rows.find(r => r.type === 'tool_execution_start' && r.data.toolName === 'send_user_message').data.args.content as string;

async function attempt(verifyPartial?: (text: string) => Promise<void>) {
  const deliveries: unknown[] = []; let error = '';

  const tool = createSendUserMessageTool({
    conversationId: 'offline-review', getRunId: () => 'offline-run', emit: event => deliveries.push(event),
    getNextStep: () => ({action: 'ask_user', reason: 'open_task', allowWrites: false, delivery: 'report', resultIds: []}) as any,
    verifyAnswer: async () => { throw new Error('unverified claims'); }, ...(verifyPartial ? {verifyPartial} : {}),
  });

  try { await tool.execute('offline-delivery', {kind: 'finding', outcome: 'partial', content: incidentText}, new AbortController().signal, undefined, {} as never); }
  catch (e) { error = (e as Error).message; }

  return {delivered: deliveries.length, error};
}

report.delivery = {
  textHead: incidentText.slice(0, 12),
  legacyWithoutHook: await attempt(),
  withHostHookRejecting: await attempt(async () => { throw new Error('部分交付正文把未核验目标说成已完成：在页面上圈出文章的关键词、统计全文词频并圈出词频最高的词。'); }),
};

console.log(JSON.stringify(report, null, 2));
