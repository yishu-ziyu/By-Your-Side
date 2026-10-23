import { isReadingTranscript, isReadingTurnSource, READING_ANSWER_LIMIT, READING_ROUTE_SELECTION_LIMIT, READING_TURN_LIMIT, type ReadingEvent, type ReadingRoute, type ReadingRouteResult, type ReadingSource, type ReadingTurnSource } from '../../../shared/reading.js';
import type { ClientMessage, ServerMessage } from '../../../shared/protocol.js';
import { readingBusy, type ReadingRecord } from '../shared/reading-state.js';
import type { PttVoice } from './ptt-capsule.js';
import { READING_VOICE, type ReadingVoiceMessage } from '../shared/ptt.js';

const STORE = 'readingRecords';

/** 分流判断最多等这么久；模型那边自己 10 秒放弃，这里多留一点来回。 */
const ROUTE_WAIT_MS = 12_000;

/** 写完一句才念；英文句点不算，免得把小数和缩写当句尾。 */
const SENTENCE_END = /[。！？!?；;\n]/g;

/** 换段时每轮带的相邻段落短一些：一张卡换几段也放得进问答总长。 */
const TURN_SURROUNDING_LIMIT = 1000;

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
};

/** One document owns each record. No per-conversation listeners or shared output tab. */
export function installReading(deps: Dependencies) {
  const records = new Map<string, ReadingRecord>();
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
    const end = turn.state === 'done' ? rest.length : turn.state === 'streaming' ? sentencesEnd(rest) : 0;

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
    persist();
    toPage(record, {type: 'reading_update', record});
  };

  const stop = (record: ReadingRecord, announce = true) => {
    if (!record.requestId || !readingBusy(record)) return;
    deps.send({type: 'reading_cancel', threadId: record.threadId, requestId: record.requestId});
    record.turns.at(-1)!.state = 'stopped';
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

      if (raw.type === 'reading_leave') { for (const r of records.values()) if (ownedDocument(r)) stop(r);

 return {ok: true}; }

      if (raw.type === 'reading_open') {
        const source: ReadingSource = {...raw.source, tabId: tab.id!, title: (tab.title ?? '').slice(0, 500), url: sender.url ?? tab.url ?? ''};

        if (!isReadingTranscript({threadId: 'validate', source, turns: []})) throw new Error('选中的文字太长，或读不出来。');
        record = [...records.values()].find(r => owned(r) && r.source.text === source.text);

        for (const r of records.values()) if (owned(r) && r.threadId !== record?.threadId) stop(r);

        if (!record) {
          if (records.size >= 16) {
            const oldest = [...records.values()].filter(r => !readingBusy(r)).sort((a,b) => a.updatedAt - b.updatedAt)[0];

            if (!oldest) throw new Error('打开的阅读卡太多了。先关掉一张。');
            records.delete(oldest.threadId);
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

      if (raw.type === 'reading_send') {
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
        const pointed = raw.source && typeof raw.source === 'object' && typeof raw.source.text === 'string' && typeof raw.source.surrounding === 'string'
          ? {text: raw.source.text, surrounding: raw.source.surrounding.slice(0, TURN_SURROUNDING_LIMIT)} : retry ? last.source : undefined;

        if (pointed && !isReadingTurnSource(pointed)) throw new Error('选中的文字太长，或读不出来。');
        const current = [...previousTurns].reverse().find(t => t.source)?.source?.text ?? record.source.text;
        const turnSource: ReadingTurnSource | undefined = pointed && pointed.text !== current ? pointed : undefined;

        if (previousTurns.length >= READING_TURN_LIMIT) throw new Error('这段问答太长了。点「在侧栏继续」。');
        const depth = raw.depth === 'deep' ? 'deep' as const : 'fast' as const;
        const spoken = raw.spoken === true;
        const turn = {question, answer: '', state: 'pending' as const, ...(spoken ? {spoken} : {}), ...(turnSource ? {source: turnSource} : {})};
        const candidate = {...record, depth, turns: [...previousTurns, turn]};

        if (!isReadingTranscript(candidate) || JSON.stringify(candidate).length + READING_ANSWER_LIMIT > 64000) throw new Error('这段问答太长了。点「在侧栏继续」。');
        if (correction) {
          if (busy) stop(record, false);
          record.correctedTurns = [...(record.correctedTurns ?? []), candidate.turns.length - 1];
        }

        record.interruptedTurn = undefined;

        record.depth = depth;
        record.turns = candidate.turns;
        record.requestId = crypto.randomUUID();
        hush();

        if (spoken) speaking = {threadId: record.threadId, requestId: record.requestId, said: 0, busy: false};
        record.transferredConversationId = undefined;
        record.handoffRequestId = undefined;

        if (!deps.send({type: 'reading_request', requestId: record.requestId, transcript: record, conversationId: record.modelConversationId})) {
          Object.assign(turn, {state: 'error', answer: retry ? last.answer : '', error: '未连接到助手。内容已保留，连接恢复后可重试。'});
        }

        publish(record);

        return {ok: true, record};
      }

      if (raw.type === 'reading_handoff') {
        await opened;

        if (readingBusy(record)) throw new Error('先停止回答，或等回答写完，再在侧栏继续。');

        if (record.transferredConversationId) { opening = false; deps.select(record.transferredConversationId, record.source.tabId);

 return {ok: true, record}; }

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
    void ready.then(() => { for (const [key, r] of records) if (r.source.tabId === tabId) {stop(r); records.delete(key);}

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
      void ready.then(() => {
        for (const r of records.values()) {
          if (r.source.tabId !== tabId || !readingBusy(r)) continue;
          r.interruptedTurn = r.turns.length - 1;
          stop(r);
        }
      });
    },
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

        if (record && record.handoffRequestId === event.requestId && event.state === 'error') {
          opening = false; record.handoffError = event.error ?? '没能转到侧栏。再试一次。'; record.handoffRequestId = undefined; publish(record);

 return;
        }

        if (!record || record.requestId !== event.requestId || !readingBusy(record)) return;
        Object.assign(record.turns.at(-1)!, {state: event.state, answer: event.text, error: event.error});
        publish(record);
        say(record);
      });
    },
    disconnected() {
      void ready.then(() => { for (const r of records.values()) if (readingBusy(r)) { Object.assign(r.turns.at(-1)!, {state: 'error', error: '连接中断，已保留回答。恢复连接后可以重试。'}); publish(r); } });
    },
    created(message: Extract<ServerMessage, {type: 'conversation_created'}>) {
      void ready.then(async () => {
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
