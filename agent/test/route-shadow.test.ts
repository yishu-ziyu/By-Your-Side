import {describe, expect, it, vi} from 'vitest';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RouteShadow} from '../src/route-shadow.js';

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), 'route-shadow-test-'));
}

function dayFor(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function readLines(root: string, day: string): Array<Record<string, unknown>> {
  const path = join(root, `${day}.jsonl`);

  if (!existsSync(path)) return [];

  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

const NOW = 1_700_000_000_000; // fixed instant so day-file assertions are deterministic

const okResponse = (answers: Record<string, unknown>, usage?: Record<string, number>) =>
  ({ok: true, status: 200, json: async () => ({answers, usage})}) as Response;

describe('RouteShadow: disabled means zero calls and zero writes', () => {
  it('never calls fetch and never creates the log directory when disabled', () => {
    const base = freshRoot();
    const root = join(base, 'never-created');
    const fetchMock = vi.fn();
    const shadow = new RouteShadow({enabled: () => false, dailyLimit: () => 400, root, key: () => 'k', fetch: fetchMock as unknown as typeof fetch, now: () => NOW});
    shadow.observe({channel: 'voice', conversationId: 'c1', text: '你好', previous: [], taskRunning: 'unknown'});
    shadow.actual({channel: 'voice', conversationId: 'c1', kind: 'tool', name: 'read_page'});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(root)).toBe(false);
  });
});

describe('RouteShadow: observe() request shape matches route-compare.py', () => {
  it('calls fetch exactly once with the model, 8-lane criteria, noul pagechange question and route-compare.py state shape', () => {
    const root = freshRoot();
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => okResponse({lane_0: {choice: 'chat', confidence: 0.9, probabilities: {chat: 0.9}}, pagechange_0: {noul: 0.1}}));
    const shadow = new RouteShadow({enabled: () => true, dailyLimit: () => 400, root, key: () => 'test-key', fetch: fetchMock as unknown as typeof fetch, now: () => NOW});
    shadow.observe({channel: 'voice', conversationId: 'c1', voiceId: 'v1', turn: 2, itemId: 'i1', text: '你好', previous: ['之前那句'], taskRunning: false, taskState: 'none', page: {title: 'T', url: 'https://example.test'}});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('jev-1.13.0');
    expect(body.questions.lane_0.type).toBe('choice');
    expect(Object.keys(body.questions.lane_0.criteria).sort()).toEqual(['answer', 'chat', 'control', 'incomplete', 'page_question', 'status', 'steer', 'task']);
    expect(body.questions.lane_0.instructions.question).toContain('utterances[0]');
    expect(body.questions.pagechange_0.type).toBe('noul');
    expect(body.questions.pagechange_0.criteria).toEqual({true: expect.any(String), false: expect.any(String)});
    // A1 (V2.2): the ONE request already carries all three questions — no second fetch for a speech judgment.
    expect(Object.keys(body.questions).sort()).toEqual(['lane_0', 'pagechange_0', 'spoken_result_0']);
    expect(body.questions.spoken_result_0.type).toBe('noul');
    expect(body.questions.spoken_result_0.instructions).toContain('utterances[0]');
    expect(body.questions.spoken_result_0.criteria).toEqual({true: expect.any(String), false: expect.any(String)});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(body.state.channel).toBe('voice');
    expect(body.state.utterances).toHaveLength(1);
    expect(body.state.utterances[0]).toMatchObject({text: '你好', previous: ['之前那句'], taskRunning: false});
  });

  it('does not block or throw synchronously while the Jev request is still in flight', () => {
    const root = freshRoot();
    let resolveFetch!: (value: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>(resolve => { resolveFetch = resolve; }));
    const shadow = new RouteShadow({enabled: () => true, dailyLimit: () => 400, root, key: () => 'k', fetch: fetchMock as unknown as typeof fetch, now: () => NOW});
    expect(() => shadow.observe({channel: 'text', conversationId: 'c1', text: 'x', previous: [], taskRunning: 'unknown'})).not.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveFetch(okResponse({lane_0: {choice: 'chat'}, pagechange_0: {noul: 0}}));
  });
});

describe('RouteShadow: successful utterance record', () => {
  it('writes one complete utterance record with all fields on a successful Jev call', async () => {
    const root = freshRoot();

    const fetchMock = vi.fn(async () => okResponse(
      {lane_0: {choice: 'task', confidence: 0.87, probabilities: {task: 0.87, chat: 0.05}}, pagechange_0: {noul: 0.7}},
      {promptTokens: 120, completionTokens: 40},
    ));

    const shadow = new RouteShadow({enabled: () => true, dailyLimit: () => 400, root, key: () => 'k', fetch: fetchMock as unknown as typeof fetch, now: () => NOW});
    shadow.observe({channel: 'voice', conversationId: 'c1', voiceId: 'v1', turn: 3, itemId: 'i9', text: '把这个页面翻译一下', previous: ['你好'], taskRunning: true, taskState: 'running', page: {title: '页面标题', url: 'https://example.test/a'}});
    await vi.waitFor(() => { expect(readLines(root, dayFor(NOW)).some(l => l.type === 'utterance')).toBe(true); });
    const record = readLines(root, dayFor(NOW)).find(l => l.type === 'utterance')!;
    expect(record).toMatchObject({
      type: 'utterance', channel: 'voice', conversationId: 'c1', voiceId: 'v1', turn: 3, itemId: 'i9',
      text: '把这个页面翻译一下', previous: ['你好'], taskRunning: true, taskState: 'running',
      page: {title: '页面标题', url: 'https://example.test/a'},
      jev: {lane: 'task', confidence: 0.87, probabilities: {task: 0.87, chat: 0.05}, pageChange: 0.7, usage: {promptTokens: 120, completionTokens: 40}},
    });
    expect(typeof record.at).toBe('number');
    expect(typeof (record.jev as Record<string, unknown>).ms).toBe('number');
  });
});

describe('RouteShadow: failures always degrade to a skipped record, never a throw', () => {
  it('records no_credential without ever calling fetch', () => {
    const root = freshRoot();
    const fetchMock = vi.fn();
    const shadow = new RouteShadow({enabled: () => true, dailyLimit: () => 400, root, key: () => '', fetch: fetchMock as unknown as typeof fetch, now: () => NOW});
    shadow.observe({channel: 'text', conversationId: 'c1', text: '你好', previous: [], taskRunning: 'unknown'});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readLines(root, dayFor(NOW))).toEqual([expect.objectContaining({type: 'skipped', reason: 'no_credential', conversationId: 'c1', text: '你好'})]);
  });

  it('records a skipped entry when fetch rejects with a network error', async () => {
    const root = freshRoot();
    const shadow = new RouteShadow({enabled: () => true, dailyLimit: () => 400, root, key: () => 'k', fetch: (async () => { throw new Error('network down'); }) as unknown as typeof fetch, now: () => NOW});
    expect(() => shadow.observe({channel: 'text', conversationId: 'c1', text: 'x', previous: [], taskRunning: 'unknown'})).not.toThrow();
    await vi.waitFor(() => { expect(readLines(root, dayFor(NOW))).toEqual([expect.objectContaining({type: 'skipped', reason: 'fetch_error'})]); });
  });

  it('records a skipped entry with an http_ reason on a non-ok response', async () => {
    const root = freshRoot();
    const shadow = new RouteShadow({enabled: () => true, dailyLimit: () => 400, root, key: () => 'k', fetch: (async () => ({ok: false, status: 500, json: async () => ({})})) as unknown as typeof fetch, now: () => NOW});
    shadow.observe({channel: 'text', conversationId: 'c1', text: 'x', previous: [], taskRunning: 'unknown'});
    await vi.waitFor(() => { expect(readLines(root, dayFor(NOW))).toEqual([expect.objectContaining({type: 'skipped', reason: 'http_500'})]); });
  });

  it('records a timeout reason when the abort signal fires', async () => {
    const root = freshRoot();
    const shadow = new RouteShadow({enabled: () => true, dailyLimit: () => 400, root, key: () => 'k', fetch: (async () => { throw new DOMException('aborted', 'TimeoutError'); }) as unknown as typeof fetch, now: () => NOW});
    shadow.observe({channel: 'text', conversationId: 'c1', text: 'x', previous: [], taskRunning: 'unknown'});
    await vi.waitFor(() => { expect(readLines(root, dayFor(NOW))).toEqual([expect.objectContaining({type: 'skipped', reason: 'timeout'})]); });
  });

  it('records invalid_response when the answer shape is unusable', async () => {
    const root = freshRoot();
    const shadow = new RouteShadow({enabled: () => true, dailyLimit: () => 400, root, key: () => 'k', fetch: (async () => okResponse({})) as unknown as typeof fetch, now: () => NOW});
    shadow.observe({channel: 'text', conversationId: 'c1', text: 'x', previous: [], taskRunning: 'unknown'});
    await vi.waitFor(() => { expect(readLines(root, dayFor(NOW))).toEqual([expect.objectContaining({type: 'skipped', reason: 'invalid_response'})]); });
  });
});

describe('RouteShadow: daily call budget', () => {
  it('stops calling Jev once the daily limit is reached, recording daily_limit without a fetch', () => {
    const root = freshRoot();
    const fetchMock = vi.fn(async () => okResponse({lane_0: {choice: 'chat'}, pagechange_0: {noul: 0.1}}));
    const shadow = new RouteShadow({enabled: () => true, dailyLimit: () => 1, root, key: () => 'k', fetch: fetchMock as unknown as typeof fetch, now: () => NOW});
    shadow.observe({channel: 'text', conversationId: 'c1', text: '第一句', previous: [], taskRunning: 'unknown'});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    shadow.observe({channel: 'text', conversationId: 'c1', text: '第二句', previous: [], taskRunning: 'unknown'});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readLines(root, dayFor(NOW))).toEqual(expect.arrayContaining([expect.objectContaining({type: 'skipped', reason: 'daily_limit', text: '第二句'})]));
  });

  it('recovers the spent budget from existing file lines on a fresh instance, excluding no_credential/daily_limit skips', () => {
    const root = freshRoot();
    const day = dayFor(NOW);
    mkdirSync(root, {recursive: true});
    writeFileSync(join(root, `${day}.jsonl`), [
      {type: 'utterance', at: NOW, text: 'a'},
      {type: 'skipped', at: NOW, text: 'b', reason: 'fetch_error'},
      {type: 'skipped', at: NOW, text: 'c', reason: 'no_credential'},
      {type: 'skipped', at: NOW, text: 'd', reason: 'daily_limit'},
    ].map(line => `${JSON.stringify(line)}\n`).join(''));
    const fetchMock = vi.fn(async () => okResponse({lane_0: {choice: 'chat'}, pagechange_0: {noul: 0.1}}));
    const shadow = new RouteShadow({enabled: () => true, dailyLimit: () => 2, root, key: () => 'k', fetch: fetchMock as unknown as typeof fetch, now: () => NOW});
    shadow.observe({channel: 'text', conversationId: 'c1', text: 'third call', previous: [], taskRunning: 'unknown'});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readLines(root, day)).toEqual(expect.arrayContaining([expect.objectContaining({type: 'skipped', reason: 'daily_limit', text: 'third call'})]));
  });

  it('resets the call budget when the local date rolls over', () => {
    const root = freshRoot();
    let current = new Date('2026-09-21T23:59:00').getTime();
    const fetchMock = vi.fn(async () => okResponse({lane_0: {choice: 'chat'}, pagechange_0: {noul: 0.1}}));
    const shadow = new RouteShadow({enabled: () => true, dailyLimit: () => 1, root, key: () => 'k', fetch: fetchMock as unknown as typeof fetch, now: () => current});
    shadow.observe({channel: 'text', conversationId: 'c1', text: 'day1-a', previous: [], taskRunning: 'unknown'});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    shadow.observe({channel: 'text', conversationId: 'c1', text: 'day1-b', previous: [], taskRunning: 'unknown'});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    current = new Date('2026-09-22T00:05:00').getTime();
    shadow.observe({channel: 'text', conversationId: 'c1', text: 'day2-a', previous: [], taskRunning: 'unknown'});
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('RouteShadow V2.2: spoken_result_0 recorded without regressing lane/pageChange', () => {
  it('A3: writes the raw spoken_result_0 noul and the same total request time as requestMs/ms, in one fetch', async () => {
    const root = freshRoot();

    const fetchMock = vi.fn(async () => okResponse(
      {lane_0: {choice: 'task', confidence: 0.8}, pagechange_0: {noul: 0.7}, spoken_result_0: {noul: 0.42}},
    ));

    let clock = NOW;
    const shadow = new RouteShadow({enabled: () => true, dailyLimit: () => 400, root, key: () => 'k', fetch: fetchMock as unknown as typeof fetch, now: () => (clock += 7)});
    shadow.observe({channel: 'voice', conversationId: 'c1', text: '切到测试标签页', previous: [], taskRunning: 'unknown'});
    await vi.waitFor(() => { expect(readLines(root, dayFor(NOW)).some(l => l.type === 'utterance')).toBe(true); });
    const record = readLines(root, dayFor(NOW)).find(l => l.type === 'utterance')!;
    const jev = record.jev as Record<string, unknown>;
    expect(jev.spokenResult).toBe(0.42); // raw noul, not rounded or classified
    expect(jev.lane).toBe('task');       // pre-existing fields keep their values and shape
    expect(jev.pageChange).toBe(0.7);
    expect(jev.requestMs).toBe(jev.ms);  // same single request's total time, not a second timing
    expect(jev.requestMs).toBe(7);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('A3: missing or invalid spoken_result_0 is recorded as no valid conclusion — never fabricated to 0 or 1', async () => {
    const invalid: Array<Record<string, unknown> | undefined> = [undefined, {noul: '1'}, {noul: null}, {noul: Number.POSITIVE_INFINITY}, {}];

    for (const spoken of invalid) {
      const root = freshRoot();

      const fetchMock = vi.fn(async () => okResponse({
        lane_0: {choice: 'task'}, pagechange_0: {noul: 0.5},
        ...(spoken !== undefined ? {spoken_result_0: spoken} : {}),
      }));

      const shadow = new RouteShadow({enabled: () => true, dailyLimit: () => 400, root, key: () => 'k', fetch: fetchMock as unknown as typeof fetch, now: () => NOW});
      shadow.observe({channel: 'text', conversationId: 'c1', text: 'x', previous: [], taskRunning: 'unknown'});
      await vi.waitFor(() => { expect(readLines(root, dayFor(NOW)).some(l => l.type === 'utterance')).toBe(true); });
      const record = readLines(root, dayFor(NOW)).find(l => l.type === 'utterance')!;
      const jev = record.jev as Record<string, unknown>;
      expect(jev).not.toHaveProperty('spokenResult'); // absent field, not 0/1
      expect(jev.lane).toBe('task');
      expect(jev.pageChange).toBe(0.5);
      expect(typeof jev.requestMs).toBe('number');
    }
  });
});

describe('RouteShadow: actual()', () => {
  it('writes actual records synchronously into the same day file as observe', () => {
    const root = freshRoot();
    const shadow = new RouteShadow({enabled: () => true, dailyLimit: () => 400, root, key: () => '', fetch: vi.fn() as unknown as typeof fetch, now: () => NOW});
    shadow.actual({channel: 'voice', conversationId: 'c1', voiceId: 'v1', turn: 1, itemId: 'i1', kind: 'tool', name: 'read_page'});
    shadow.actual({channel: 'voice', conversationId: 'c1', voiceId: 'v1', turn: 1, itemId: 'i1', kind: 'dispatch', action: 'start', status: 'accepted'});
    shadow.observe({channel: 'voice', conversationId: 'c1', voiceId: 'v1', text: 'x', previous: [], taskRunning: false}); // no_credential -> also lands in today's file
    const lines = readLines(root, dayFor(NOW));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({type: 'actual', kind: 'tool', name: 'read_page'});
    expect(lines[1]).toMatchObject({type: 'actual', kind: 'dispatch', action: 'start', status: 'accepted'});
    expect(lines[2]).toMatchObject({type: 'skipped', reason: 'no_credential'});
  });

  it('writes nothing when disabled', () => {
    const base = freshRoot();
    const root = join(base, 'never-created');
    const shadow = new RouteShadow({enabled: () => false, dailyLimit: () => 400, root, key: () => 'k', fetch: vi.fn() as unknown as typeof fetch, now: () => NOW});
    shadow.actual({channel: 'text', conversationId: 'c1', kind: 'entry', action: 'start'});
    expect(existsSync(root)).toBe(false);
  });
});

describe('RouteShadow: default log root', () => {
  it('honors SIDEAGENT_ROUTE_SHADOW_DIR when no explicit root is given, so test runs never write the user log', () => {
    const base = freshRoot();
    const previous = process.env.SIDEAGENT_ROUTE_SHADOW_DIR;
    process.env.SIDEAGENT_ROUTE_SHADOW_DIR = base;

    try {
      const shadow = new RouteShadow({enabled: () => true, dailyLimit: () => 400, key: () => '', fetch: vi.fn() as unknown as typeof fetch, now: () => NOW});
      shadow.actual({channel: 'voice', conversationId: 'c1', kind: 'tool', name: 'read_page'});
    } finally {
      if (previous === undefined) delete process.env.SIDEAGENT_ROUTE_SHADOW_DIR;
      else process.env.SIDEAGENT_ROUTE_SHADOW_DIR = previous;
    }

    expect(readLines(base, dayFor(NOW))).toEqual([expect.objectContaining({type: 'actual', kind: 'tool', name: 'read_page'})]);
  });
});

describe('RouteShadow: sharedRouteShadow()', () => {
  it('returns the same instance on repeated calls (one process-wide daily budget)', async () => {
    const {sharedRouteShadow} = await import('../src/route-shadow.js');
    expect(sharedRouteShadow()).toBe(sharedRouteShadow());
  });
});


it('production judgment shares the daily cap and returns only audited validated data',async()=>{
  const root=freshRoot();
  const fetchMock=vi.fn(async()=>okResponse({lane_0:{choice:'task'},pagechange_0:{noul:0.9},spoken_result_0:{noul:0.1}}));
  const shadow=new RouteShadow({enabled:()=>true,dailyLimit:()=>1,root,key:()=> 'k',fetch:fetchMock,now:()=>NOW});
  const input={channel:'voice' as const,conversationId:'c',voiceId:'v',turn:2,itemId:'i',inputId:'i',text:'切页',previous:[],taskRunning:false};
  expect(await shadow.judge(input,true)).toMatchObject({lane:'task',pageChange:0.9,spokenResult:0.1,inputId:'i',completedAt:NOW});
  shadow.observe({...input,itemId:'second',inputId:'second'});
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(readLines(root,dayFor(NOW)).at(-1)).toMatchObject({reason:'daily_limit'});
});

it('audit write failure cannot yield production data',async()=>{
  const root=join(freshRoot(),'not-a-directory');writeFileSync(root,'occupied');
  const shadow=new RouteShadow({enabled:()=>false,dailyLimit:()=>1,root,key:()=> 'k',fetch:async()=>okResponse({lane_0:{choice:'task'},pagechange_0:{noul:0.9},spoken_result_0:{noul:0.1}})});
  expect(await shadow.judge({channel:'voice',conversationId:'c',voiceId:'v',turn:2,itemId:'i',inputId:'i',text:'切页',previous:[],taskRunning:false},true)).toBeNull();
});
