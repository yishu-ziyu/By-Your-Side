import { answerMarkdown } from '../../../shared/answer-cards.js';
import type { PageContext } from '../../../shared/protocol.js';
import type { TaskView } from '../../../shared/task-view.js';
import { isReadingTranslation, isReadingTranscript, isReadingTurnSource, READING_ANSWER_LIMIT, READING_ROUTE_SELECTION_LIMIT, READING_TURN_LIMIT, type ReadingEvent, type ReadingRoute, type ReadingRouteResult, type ReadingSource, type ReadingTurnSource } from '../../../shared/reading.js';
import type { ClientMessage, ServerMessage } from '../../../shared/protocol.js';
import { readingBusy, type ReadingRecord } from '../shared/reading-state.js';
import type { PttVoice } from './ptt-capsule.js';
import { READING_VOICE, type ReadingVoiceMessage } from '../shared/ptt.js';

import { TraceRecorder } from '../../../shared/run-trace-core.js';
import { createTraceSink } from '../shared/trace-store.js';

const STORE = 'readingRecords';

/** 分流判断最多等这么久；模型那边自己 10 秒放弃，这里多留一点来回。 */
const ROUTE_WAIT_MS = 12_000;

/** 预取的回答这么久没被认领就取消（分流最多等 ROUTE_WAIT_MS）。 */
const PREFETCH_MS = ROUTE_WAIT_MS + 8_000;

/** 助手的任务停下后等这么久再收尾：目标核对和交付可能随后才到。 */
const SETTLE_MS = 800;

/** 当前步骤：和侧栏任务栏一样取正在做的动作，没有就是上一步。 */
const stepOf = (view: TaskView) => (view.active.at(-1)?.action ?? view.lastAction?.action ?? '正在处理').slice(0, 200);

/** 两次拼出的问答是否逐字相同：只比发给模型的内容，不比请求号、时间和转侧栏的记账。 */
const transcriptKey = (record: ReadingRecord) => JSON.stringify({...record, requestId: undefined, updatedAt: undefined, handoffError: undefined});

/** 写完一句才念；英文句点不算，免得把小数和缩写当句尾。 */
const SENTENCE_END = /[。！？!?；;\n]/g;

/** 第一段不等整句：回答开头那句常很长，写到逗号、冒号且已有这么多字就先念（顿号多在列举中间，停在那里听着别扭），第一声早出来；之后照常按整句念。 */
const FIRST_CLAUSE_MIN = 10;

const CLAUSE_END = /[，：]/g;

function firstClauseEnd(text: string): number {
  for (const match of text.matchAll(CLAUSE_END)) if (match.index + 1 >= FIRST_CLAUSE_MIN) return match.index + 1;

  return 0;
}

function sentencesEnd(text: string): number {
  let end = 0;

  for (const match of text.matchAll(SENTENCE_END)) end = match.index + 1;

  return end;
}

/** 念出来的字：去掉 Markdown 记号、代码和链接地址。 */
function speakable(markdown: string): string {
  return markdown.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`([^`]*)`/g, '$1').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ').replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '').replace(/[*_~|]/g, '').replace(/\s+/g, ' ').trim();
}

type Dependencies = {
  send: (message: ClientMessage) => boolean;
  selected: () => string;
  import: (conversationId: string, record: ReadingRecord) => Promise<void>;
  /** tabId：读的是哪一页，交给那一页所在窗口里的侧栏。 */
  select: (conversationId: string, tabId: number) => void;
  /** 说出来的问题，回答用按住说话同一个声音念。 */
  voice: PttVoice;
  /** 交给助手：和侧栏打字发送一样进这个会话，空闲就开新任务。返回是否送出。 */
  act: (conversationId: string, text: string, context: PageContext) => Promise<boolean>;
  /** 停下这个会话的任务：和侧栏「停止」同一条路。 */
  stopTask: (conversationId: string) => void;
};

/** One document owns each record. No per-conversation listeners or shared output tab. */
export function installReading(deps: Dependencies) {
  const records = new Map<string, ReadingRecord>();
  const diagnostics = new Map<string, { requestId: string; trace: TraceRecorder; terminal: string; displayed: boolean }>();
  const beginDiagnostic = (record: ReadingRecord) => {
    if (!record.requestId) return;
    const trace = new TraceRecorder(createTraceSink);
    trace.setRun(record.requestId);
    diagnostics.set(record.threadId, { requestId: record.requestId, trace, terminal: '', displayed: false });
    trace.record('reading_start', { requestId: record.requestId, threadId: record.threadId, transcript: record });
  };
  const finishDiagnostic = (record: ReadingRecord) => {
    const diagnostic = diagnostics.get(record.threadId), turn = record.turns.at(-1);
    if (!diagnostic || diagnostic.requestId !== record.requestId || !turn || readingBusy(record)) return;
    const key = JSON.stringify(turn);
    if (diagnostic.terminal === key) return;
    diagnostic.terminal = key;
    diagnostic.trace.record('reading_result', { requestId: record.requestId, threadId: record.threadId, turn });
  };
  let opening = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const routes = new Map<string, (route: ReadingRoute) => void>();
  /**
   * 正在念的那一轮，只认这一个请求：said 是回答里已经交去念的字数，下一段从这里接着念。
   * 按下说话、停止、改口都把它清掉；旧请求晚到的字因此不会再进队，念完的回调发现不是自己也就不再接着念。
   */
  let speaking: { threadId: string; requestId: string; said: number; busy: boolean } | null = null;
  /** 页面上正显示「在念」的那张卡：只在念与不念真的切换时告诉页面。 */
  let voiced: ReadingRecord | null = null;
  /**
   * 选着文字说的话在判断去向的同时先写回答：只发请求、不改卡片记录、不推给页面、不念，最新的回答进度先存在这里。
   * 判成问这段、卡片发来同一个问题、拼出的问答逐字相同时认领它；判成任务、又按下说话、拼出来不一样或过期就取消。
   */
  let prefetched: { threadId: string; requestId: string; key: string; latest?: ReadingEvent; timer: ReturnType<typeof setTimeout>; at: number; decide: (route: ReadingRoute | null) => void } | null = null;
  /** 交给助手的那一问在跟哪个会话的任务：deliveries 是助手的交付，text 是最后一段没走交付的回答。 */
  const runs = new Map<string, { threadId: string; sawRun: boolean; settle?: ReturnType<typeof setTimeout>; deliveries: string[]; text: string }>();

  /** 预取是否接上、为什么没接上，写进扩展日志：首字变慢时分得清是听写慢、分流慢，还是预取没被认领。 */
  const notePrefetch = (outcome: string, extra: Record<string, unknown> = {}) => console.info('[reading] prefetch', JSON.stringify({outcome, ...extra}));

  const cancelPrefetch = (reason = 'cancelled') => {
    if (!prefetched) return;
    notePrefetch(reason, {ms: Date.now() - prefetched.at, chars: prefetched.latest?.text.length ?? 0});
    clearTimeout(prefetched.timer);
    prefetched.decide(null);
    deps.send({type: 'reading_cancel', threadId: prefetched.threadId, requestId: prefetched.requestId});
    prefetched = null;
  };

  /** 新的一轮问答：卡片发问题和预取用同一段拼法，模型拿到的内容才一样。校验不过就抛出原来的提示。 */
  const compose = (record: ReadingRecord, raw: { question?: unknown; retry?: unknown; correction?: unknown; depth?: unknown; spoken?: unknown; source?: unknown }) => {
    // 生成中发来的问题是改口：停下旧回答和发出新问题在同一步里完成，旧回答没有继续写的间隙。
    const busy = readingBusy(record);

    if (busy && raw.correction !== true) throw new Error('先点「停止回答」。');
    const question = typeof raw.question === 'string' ? raw.question.trim() : '';

    if (!question || question.length > 2000) throw new Error('问题要在 1–2000 字之间。');
    const last = record.turns.at(-1);
    const retry = last && (raw.retry === true || last.state === 'error') && ['stopped', 'error'].includes(last.state) && last.question === question;
    // 按下说话时已经停下的那一轮，接着说出的新要求同样是改口。
    const resumed = !busy && !retry && raw.correction === true && last?.state === 'stopped' && record.interruptedTurn === record.turns.length - 1;
    const correction = busy || resumed;
    const previousTurns = retry ? record.turns.slice(0, -1) : record.turns;
    const given = raw.source && typeof raw.source === 'object' ? raw.source as Record<string, unknown> : undefined;
    const pointed = given && typeof given.text === 'string' && typeof given.surrounding === 'string'
      ? {text: given.text, surrounding: given.surrounding, ...(typeof given.truncated === 'boolean' ? {truncated: given.truncated} : {}), ...(typeof given.location === 'string' ? {location: given.location} : {})} : retry ? last.source : undefined;

    if (pointed && !isReadingTurnSource(pointed)) throw new Error('选中的文字太长，或读不出来。');
    const turnSource: ReadingTurnSource | undefined = pointed;
    const source = pointed ?? [...previousTurns].reverse().find(turn => turn.source)?.source ?? record.source;
    if (isReadingTranslation(question) && source.truncated) throw new Error('选中的文字太长，无法完整翻译。请缩小选区后重试。');

    if (previousTurns.length >= READING_TURN_LIMIT) throw new Error('这段问答太长了。点「在侧栏继续」。');
    const depth = raw.depth === 'deep' ? 'deep' as const : 'fast' as const;
    const spoken = raw.spoken === true;
    const turn = {question, answer: '', state: 'pending' as const, ...(spoken ? {spoken} : {}), ...(turnSource ? {source: turnSource} : {})};
    const candidate = {...record, depth, turns: [...previousTurns, turn]};

    if (!isReadingTranscript(candidate) || JSON.stringify(candidate).length + READING_ANSWER_LIMIT > 64000) throw new Error('这段问答太长了。点「在侧栏继续」。');

    return {candidate, turn, retry, last, busy, correction, spoken};
  };

  /** 发问前要改的记录字段（改口记号、清掉转侧栏的记账）：卡片发问和预取一样改。 */
  const advance = (record: ReadingRecord, composed: ReturnType<typeof compose>) => {
    if (composed.correction) record.correctedTurns = [...(record.correctedTurns ?? []), composed.candidate.turns.length - 1];
    record.interruptedTurn = undefined;
    record.depth = composed.candidate.depth;
    record.canAct = true;
    record.turns = composed.candidate.turns;
    record.transferredConversationId = undefined;
    record.handoffRequestId = undefined;
  };

  /** 回答进度落到这一轮上，推给页面，写完一句就念。回答模型说要动手，就交给助手。 */
  const apply = (record: ReadingRecord, event: ReadingEvent) => {
    if (event.act) return handToAgent(record);
    Object.assign(record.turns.at(-1)!, {state: event.state, answer: event.text, error: event.error});
    publish(record);
    say(record);
  };

  const agentTurn = (record: ReadingRecord) => readingBusy(record) && record.turns.at(-1)?.agent ? record.turns.at(-1) : undefined;

  const failAgent = (record: ReadingRecord, error: string) => {
    const turn = agentTurn(record);

    if (!turn) return;
    if (record.agentConversationId) runs.delete(record.agentConversationId);
    Object.assign(turn, {state: 'error', error, step: undefined});
    publish(record);
  };

  /** 把助手会话还没看过的问答交给它：进助手的上下文，也进侧栏的对话记录。 */
  const syncAgent = async (record: ReadingRecord, conversationId: string) => {
    const unseen = record.turns.slice(record.agentSynced ?? 0).filter(turn => !turn.agent);

    if (record.agentSynced === undefined || unseen.length) {
      deps.send({type: 'reading_import', requestId: crypto.randomUUID(), conversationId, transcript: {threadId: record.threadId, source: record.source, turns: unseen}});
      await deps.import(conversationId, {...record, turns: unseen});
    }

    record.agentSynced = record.turns.length;
  };

  const dispatchAgent = async (record: ReadingRecord) => {
    const conversationId = record.agentConversationId!, turn = agentTurn(record);

    if (!turn) return;
    await syncAgent(record, conversationId);
    const source = [...record.turns].reverse().find(t => t.source)?.source ?? record.source;
    runs.set(conversationId, {threadId: record.threadId, sawRun: false, deliveries: [], text: ''});
    const context: PageContext = {tabId: record.source.tabId, title: record.source.title, url: record.source.url, selection: {text: source.text.slice(0, 2000)}};

    if (!await deps.act(conversationId, turn.question, context)) failAgent(record, '未连接到助手。内容已保留，连接恢复后可重试。');
  };

  /** 这一问要动手：交给侧栏同一个助手。这张卡还没有助手会话就先开一个，侧栏不跟着切过去。 */
  const handToAgent = (record: ReadingRecord) => {
    hush(record.threadId);
    Object.assign(record.turns.at(-1)!, {agent: true, state: 'streaming', answer: '', error: undefined, step: '交给助手'});
    publish(record);

    if (record.agentConversationId) return void dispatchAgent(record).catch(() => failAgent(record, '没能交给助手。再试一次。'));
    record.agentRequestId ??= crypto.randomUUID();

    if (!deps.send({type: 'conversation_create', requestId: record.agentRequestId, title: `阅读 · ${record.source.text.slice(0, 28)}`})) failAgent(record, '未连接到助手。内容已保留，连接恢复后可重试。');
  };

  const finishAgent = (record: ReadingRecord, view: TaskView) => {
    const conversationId = record.agentConversationId!, run = runs.get(conversationId), turn = agentTurn(record);
    runs.delete(conversationId);

    if (!turn) return;
    turn.step = undefined;

    if (!turn.answer.trim() && run?.text.trim()) turn.answer = answerMarkdown(run.text).slice(0, READING_ANSWER_LIMIT);

    if (view.state === 'aborted') turn.state = 'stopped';
    else if (view.state === 'error' || !turn.answer.trim()) Object.assign(turn, {state: 'error', error: '助手没做完。点「继续聊天」在侧栏看过程。'});
    else turn.state = 'done';
    publish(record);
  };

  const toPage = (record: ReadingRecord, message: object) => {
    const options = record.documentKey.startsWith('document:') ? {documentId: record.documentKey.slice(9)} : undefined;
    void chrome.tabs.sendMessage(record.source.tabId, message, options).catch(() => {});
  };

  const quiet = () => {
    if (!voiced) return;
    toPage(voiced, {type: READING_VOICE, phase: 'quiet', threadId: voiced.threadId} satisfies ReadingVoiceMessage);
    voiced = null;
  };

  const loud = (record: ReadingRecord) => {
    if (voiced?.threadId === record.threadId) return;
    quiet();
    voiced = record;
    toPage(record, {type: READING_VOICE, phase: 'speaking', threadId: record.threadId} satisfies ReadingVoiceMessage);
  };

  const endSpeaking = () => {
    speaking = null;
    quiet();
  };

  const hush = (threadId?: string) => {
    if (!speaking || (threadId && speaking.threadId !== threadId)) return;
    endSpeaking();
    deps.voice.hush();
  };

  /** 念到回答已经写完的最后一句；回答写完时念完剩下的。一次只交一段，念完再接下一段。 */
  const say = (record: ReadingRecord) => {
    const s = speaking, turn = record.turns.at(-1);

    if (!s || !turn || s.busy || s.threadId !== record.threadId || s.requestId !== record.requestId) return;
    const rest = turn.answer.slice(s.said);
    const end = turn.state === 'done' ? rest.length : turn.state === 'streaming' ? sentencesEnd(rest) || (s.said === 0 ? firstClauseEnd(rest) : 0) : 0;

    if (!end) {
      if (turn.state !== 'streaming' && turn.state !== 'pending') endSpeaking();

      return;
    }

    s.said += end;
    const text = speakable(rest.slice(0, end));

    if (!text) return say(record);
    const playing = deps.voice.speak(text, record.modelConversationId, true);

    if (!playing) { endSpeaking();

 return; }
    s.busy = true;
    loud(record);
    void playing.then(reply => {
      if (speaking !== s) return;
      s.busy = false;

      if (!reply.ok) { endSpeaking();

 return; }
      const current = records.get(s.threadId);

      if (current) say(current);
    });
  };

  const ready = chrome.storage.session.get(STORE).then(saved => {
    for (const value of (Array.isArray(saved[STORE]) ? saved[STORE] : []).slice(-16)) {
      const record = value as ReadingRecord;

      if (!isReadingTranscript(record) || typeof record.documentKey !== 'string') continue;

      if (readingBusy(record)) Object.assign(record.turns.at(-1)!, {state: 'error', error: '连接已恢复，上次回答未完成，可以重试。'});
      records.set(record.threadId, record);
    }
  });

  const persist = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { void chrome.storage.session.set({[STORE]: [...records.values()]}); }, 100);
  };

  const publish = (record: ReadingRecord) => {
    record.updatedAt = Date.now();
    finishDiagnostic(record);
    persist();
    toPage(record, {type: 'reading_update', record});
  };

  const stop = (record: ReadingRecord, announce = true) => {
    if (!record.requestId || !readingBusy(record)) return;
    const turn = record.turns.at(-1)!;

    if (!turn.agent) deps.send({type: 'reading_cancel', threadId: record.threadId, requestId: record.requestId});
    else if (record.agentConversationId && runs.delete(record.agentConversationId)) deps.stopTask(record.agentConversationId);
    turn.state = 'stopped';
    turn.step = undefined;
    finishDiagnostic(record);
    hush(record.threadId);

    if (announce) publish(record);
  };

  const documentKey = (sender: chrome.runtime.MessageSender) => sender.documentId ? `document:${sender.documentId}` : `url:${sender.url}`;
  chrome.runtime.onMessage.addListener((raw, sender, respond) => {
    if (!raw || typeof raw.type !== 'string' || !raw.type.startsWith('reading_') || !sender.tab?.id || sender.frameId !== 0) return;
    const tab = sender.tab;

    // Chrome requires sidePanel.open in the originating user gesture, before storage awaits.
    if (raw.type === 'reading_handoff') opening = true;
    const opened = raw.type === 'reading_handoff' ? chrome.sidePanel.open({tabId: tab.id!}) : Promise.resolve();
    void (async () => {
      await ready;
      const ownedDocument = (r: ReadingRecord) => r.source.tabId === tab.id && r.documentKey === documentKey(sender);
      const owned = (r: ReadingRecord) => ownedDocument(r) && r.source.url === sender.url;
      let record = typeof raw.threadId === 'string' ? records.get(raw.threadId) : [...records.values()].filter(owned).sort((a,b)=>a.updatedAt-b.updatedAt).at(-1);

      if (record && !owned(record)) record = undefined;

      if (raw.type === 'reading_get') return {ok: true, record};

      // 离开这一页时，交给助手的任务照常在侧栏会话里做完。
      if (raw.type === 'reading_leave') { for (const r of records.values()) if (ownedDocument(r) && !agentTurn(r)) stop(r);

 return {ok: true}; }

      if (raw.type === 'reading_open') {
        const source: ReadingSource = {...raw.source, tabId: tab.id!, title: (tab.title ?? '').slice(0, 500), url: sender.url ?? tab.url ?? ''};

        if (!isReadingTranscript({threadId: 'validate', source, turns: []})) throw new Error('选中的文字太长，或读不出来。');
        record = [...records.values()].find(r => owned(r) && r.source.text === source.text && r.source.location === source.location && r.source.surrounding === source.surrounding);

        for (const r of records.values()) if (owned(r) && r.threadId !== record?.threadId) stop(r);

        if (!record) {
          if (records.size >= 16) {
            const oldest = [...records.values()].filter(r => !readingBusy(r)).sort((a,b) => a.updatedAt - b.updatedAt)[0];

            if (!oldest) throw new Error('打开的阅读卡太多了。先关掉一张。');
            records.delete(oldest.threadId);
            diagnostics.delete(oldest.threadId);
          }

          record = {threadId: crypto.randomUUID(), source, turns: [], documentKey: documentKey(sender), modelConversationId: deps.selected(), updatedAt: Date.now()};
          records.set(record.threadId, record);
          persist();
        }

        record.updatedAt = Date.now(); persist();

        return {ok: true, record};
      }

      if (!record) throw new Error('这段问答已过期。重新选中文字。');

      if (raw.type === 'reading_stop') { stop(record);

 return {ok: true, record}; }

      if (raw.type === 'reading_rendered') {
        const diagnostic = diagnostics.get(record.threadId);
        if (diagnostic && diagnostic.requestId === raw.requestId && !diagnostic.displayed && !readingBusy(record)
          && typeof raw.text === 'string' && raw.text.length <= READING_ANSWER_LIMIT * 2) {
          diagnostic.displayed = true;
          diagnostic.trace.record('reading_display', { requestId: raw.requestId, threadId: record.threadId, text: raw.text });
          await diagnostic.trace.flush();
        }
        return {ok: true};
      }

      if (raw.type === 'reading_send') {
        const composed = compose(record, raw);
        const {turn, retry, last, busy, spoken} = composed;

        if (composed.correction && busy) stop(record, false);
        advance(record, composed);
        // 预取的那一路拼出的问答逐字相同才认领；不同就取消它，照常发问。
        const adopted = prefetched && prefetched.threadId === record.threadId && prefetched.key === transcriptKey(record) ? prefetched : null;

        if (adopted) { clearTimeout(adopted.timer); adopted.decide('reading'); prefetched = null; notePrefetch('adopted', {ms: Date.now() - adopted.at, chars: adopted.latest?.text.length ?? 0}); } else cancelPrefetch(prefetched ? 'mismatch' : 'none');
        record.requestId = adopted?.requestId ?? crypto.randomUUID();
        beginDiagnostic(record);
        hush();

        if (spoken) speaking = {threadId: record.threadId, requestId: record.requestId, said: 0, busy: false};

        if (!adopted && !deps.send({type: 'reading_request', requestId: record.requestId, transcript: record, conversationId: record.modelConversationId})) {
          Object.assign(turn, {state: 'error', answer: retry && last ? last.answer : '', error: '未连接到助手。内容已保留，连接恢复后可重试。'});
        }

        publish(record);

        if (adopted?.latest) apply(record, adopted.latest);
        await diagnostics.get(record.threadId)?.trace.flush();

        return {ok: true, record};
      }

      if (raw.type === 'reading_handoff') {
        await opened;

        if (readingBusy(record) && !agentTurn(record)) throw new Error('先停止回答，或等回答写完，再在侧栏继续。');

        if (record.transferredConversationId) { opening = false; deps.select(record.transferredConversationId, record.source.tabId);

 return {ok: true, record}; }

        // 交给过助手的卡转到那个会话，补上它没看过的问答。
        if (record.agentConversationId) {
          await syncAgent(record, record.agentConversationId);
          opening = false;
          deps.select(record.agentConversationId, record.source.tabId);
          record.transferredConversationId = record.agentConversationId;
          publish(record);

          return {ok: true, record};
        }

        record.handoffError = undefined;
        record.handoffRequestId ??= crypto.randomUUID();
        persist();

        if (!deps.send({type: 'conversation_create', requestId: record.handoffRequestId, title: `阅读 · ${record.source.text.slice(0, 28)}`, reading: record})) throw new Error('没有连接到助手，现在不能转到侧栏。');

        return {ok: true, record};
      }

      throw new Error('未知阅读操作。');
    })().then(respond, error => { if (raw.type === 'reading_handoff') opening = false; respond({ok: false, error: error instanceof Error ? error.message : '阅读操作失败。'}); });
    void opened.catch(() => {});

    return true;
  });

  const dropTab = (tabId: number) => {
    void ready.then(() => { for (const [key, r] of records) if (r.source.tabId === tabId) {if (!agentTurn(r)) stop(r); records.delete(key); diagnostics.delete(key);}

 persist(); });
  };

  chrome.tabs.onRemoved.addListener(dropTab);
  chrome.tabs.onUpdated.addListener((tabId, change) => { if (change.status === 'loading') dropTab(tabId); });

  return {
    /**
     * 按下说话：正在念的阅读回答马上停，已经排着的句子也不再念；这一页还在写的回答也停在已写出的地方，
     * 不在用户说话时继续变长。记下停的是哪一轮，接着说出的新要求按改口接上。
     */
    interrupt(tabId: number) {
      hush();
      cancelPrefetch('pressed_again');
      void ready.then(() => {
        for (const r of records.values()) {
          if (r.source.tabId !== tabId || !readingBusy(r) || agentTurn(r)) continue;
          r.interruptedTurn = r.turns.length - 1;
          stop(r);
        }
      });
    },
    /**
     * 判断去向的同时先写这句话的阅读回答。第一个明确内容或交助手的结果也能决定去向；
     * null 表示预取没启动、被取消或没答成，仍由单独的分流判断兜底。
     */
    prefetch(tabId: number, question: string, source: unknown): Promise<ReadingRoute | null> {
      cancelPrefetch('replaced');
      return ready.then(() => {
        const record = [...records.values()].filter(r => r.source.tabId === tabId).sort((a, b) => a.updatedAt - b.updatedAt).at(-1);

        if (!record || readingBusy(record)) { notePrefetch('skipped', {reason: record ? 'busy' : 'no_card'});

 return null; }
        let next: ReadingRecord;

        try {
          next = structuredClone(record);
          advance(next, compose(next, {question, correction: true, depth: 'fast', spoken: true, source}));
        } catch (error) { notePrefetch('skipped', {reason: error instanceof Error ? error.message : 'compose'});

 return null; }
        const requestId = crypto.randomUUID();

        const transcript: ReadingRecord = {...next, requestId};

        if (!deps.send({type: 'reading_request', requestId, transcript, conversationId: next.modelConversationId})) return null;
        return new Promise<ReadingRoute | null>(resolve => {
          prefetched = {threadId: record.threadId, requestId, key: transcriptKey(next), timer: setTimeout(() => cancelPrefetch('expired'), PREFETCH_MS), at: Date.now(), decide: resolve};
          notePrefetch('started');
        });
      });
    },
    cancelPrefetch,
    /** 页面上选着文字时说的一句话该去哪；判断不了或助手没连上就当任务。 */
    route(utterance: string, selection: string, asked?: string): Promise<ReadingRoute> {
      const requestId = crypto.randomUUID();

      return new Promise(resolve => {
        const done = (route: ReadingRoute) => { clearTimeout(wait); routes.delete(requestId); resolve(route); };
        const wait = setTimeout(() => done('task'), ROUTE_WAIT_MS);
        routes.set(requestId, done);

        if (!deps.send({type: 'reading_route', requestId, conversationId: deps.selected(), utterance: utterance.slice(0, 2000), selection: selection.slice(0, READING_ROUTE_SELECTION_LIMIT), ...(asked ? {asked: asked.slice(0, 2000)} : {})})) done('task');
      });
    },
    routed(result: ReadingRouteResult) { routes.get(result.requestId)?.(result.route); },
    resumeOnOpen: (id: string) => opening || [...records.values()].some(r => r.transferredConversationId === id),
    receive(event: ReadingEvent) {
      void ready.then(() => {
        const record = records.get(event.threadId);

        if (record && record.agentRequestId === event.requestId && event.state === 'error') {
          record.agentRequestId = undefined; failAgent(record, event.error ?? '没能交给助手。再试一次。');

 return;
        }

        if (record && record.handoffRequestId === event.requestId && event.state === 'error') {
          opening = false; record.handoffError = event.error ?? '没能转到侧栏。再试一次。'; record.handoffRequestId = undefined; publish(record);

 return;
        }

        if (prefetched?.requestId === event.requestId) {
          prefetched.latest = event;
          if (event.act) prefetched.decide('task');
          else if (event.text.trim()) prefetched.decide('reading');
          else if (event.state === 'error' || event.state === 'stopped') prefetched.decide(null);

 return; }

        if (!record || record.requestId !== event.requestId || !readingBusy(record) || agentTurn(record)) return;
        apply(record, event);
      });
    },
    /** 交给助手的那一问：跟着它的任务视图写步骤，收下它的交付，任务停下时收尾。 */
    server(msg: ServerMessage) {
      const conversationId = msg.type === 'task_view' ? msg.view.conversationId : msg.type === 'agent_event' ? msg.conversationId : undefined;
      const run = conversationId ? runs.get(conversationId) : undefined;

      if (!conversationId || !run) return;
      const record = records.get(run.threadId);

      if (!record || record.agentConversationId !== conversationId || !agentTurn(record)) { runs.delete(conversationId);

 return; }
      const turn = agentTurn(record)!;

      if (msg.type === 'agent_event') {
        const event = msg.event;

        if (event.kind === 'user_delivery' && event.delivery.kind !== 'ack') {
          run.deliveries.push(answerMarkdown(event.delivery.text));
          turn.answer = run.deliveries.join('\n\n').slice(0, READING_ANSWER_LIMIT);
          publish(record);
        } else if (event.kind === 'text_delta') run.text += event.delta;
        else if (event.kind === 'tool_start') run.text = '';

        return;
      }

      if (msg.type !== 'task_view') return;
      const view = msg.view;
      clearTimeout(run.settle);

      if (view.state === 'running') { run.sawRun = true; turn.step = stepOf(view); publish(record); }
      else if (view.state === 'paused') { turn.step = '页面现在归你，操作完在侧栏点「交还」'; publish(record); }
      else if (run.sawRun && ['idle', 'aborted', 'error', 'interrupted'].includes(view.state)) run.settle = setTimeout(() => finishAgent(record, view), SETTLE_MS);
    },
    disconnected() {
      void ready.then(() => { for (const r of records.values()) if (readingBusy(r)) { Object.assign(r.turns.at(-1)!, {state: 'error', error: '连接中断，已保留回答。恢复连接后可以重试。'}); publish(r); } });
    },
    created(message: Extract<ServerMessage, {type: 'conversation_created'}>) {
      void ready.then(async () => {
        const asking = [...records.values()].find(r => r.agentRequestId === message.requestId);

        if (asking) {
          asking.agentRequestId = undefined;
          asking.agentConversationId = message.conversation.id;
          persist();
          await dispatchAgent(asking).catch(() => failAgent(asking, '没能交给助手。再试一次。'));

          return;
        }

        const record = [...records.values()].find(r => r.handoffRequestId === message.requestId);

        if (!record || record.transferredConversationId === message.conversation.id) return;
        deps.select(message.conversation.id, record.source.tabId);
        await deps.import(message.conversation.id, record);
        record.transferredConversationId = message.conversation.id;
        record.handoffError = undefined;
        opening = false;
        publish(record);
      });
    },
  };
}
