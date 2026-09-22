import { isReadingTranscript, READING_ANSWER_LIMIT, READING_TURN_LIMIT, type ReadingEvent, type ReadingSource } from '../../../shared/reading.js';
import type { ClientMessage, ServerMessage } from '../../../shared/protocol.js';
import { readingBusy, type ReadingRecord } from '../shared/reading-state.js';

const STORE = 'readingRecords';

type Dependencies = {
  send: (message: ClientMessage) => boolean;
  selected: () => string;
  import: (conversationId: string, record: ReadingRecord) => Promise<void>;
  select: (conversationId: string) => void;
};

/** One document owns each record. No per-conversation listeners or shared output tab. */
export function installReading(deps: Dependencies) {
  const records = new Map<string, ReadingRecord>();
  let opening = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

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
    const options = record.documentKey.startsWith('document:') ? {documentId: record.documentKey.slice(9)} : undefined;
    void chrome.tabs.sendMessage(record.source.tabId, {type: 'reading_update', record}, options).catch(() => {});
  };

  const stop = (record: ReadingRecord) => {
    if (!record.requestId || !readingBusy(record)) return;
    deps.send({type: 'reading_cancel', threadId: record.threadId, requestId: record.requestId});
    record.turns.at(-1)!.state = 'stopped';
    publish(record);
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

        if (!isReadingTranscript({threadId: 'validate', source, turns: []})) throw new Error('选区内容无效或过长。');
        record = [...records.values()].find(r => owned(r) && r.source.text === source.text);

        for (const r of records.values()) if (owned(r) && r.threadId !== record?.threadId) stop(r);

        if (!record) {
          if (records.size >= 16) {
            const oldest = [...records.values()].filter(r => !readingBusy(r)).sort((a,b) => a.updatedAt - b.updatedAt)[0];

            if (!oldest) throw new Error('阅读窗口过多，请先停止一个。');
            records.delete(oldest.threadId);
          }

          record = {threadId: crypto.randomUUID(), source, turns: [], documentKey: documentKey(sender), modelConversationId: deps.selected(), updatedAt: Date.now()};
          records.set(record.threadId, record);
          persist();
        }

        record.updatedAt = Date.now(); persist();

        return {ok: true, record};
      }

      if (!record) throw new Error('这段阅读已过期，请重新选择文字。');

      if (raw.type === 'reading_stop') { stop(record);

 return {ok: true, record}; }

      if (raw.type === 'reading_send') {
        if (readingBusy(record)) throw new Error('请先停止当前回答。');
        const question = typeof raw.question === 'string' ? raw.question.trim() : '';

        if (!question || question.length > 2000) throw new Error('请输入 1–2000 字的问题。');
        const last = record.turns.at(-1);
        const retry = last && (raw.retry === true || last.state === 'error') && ['stopped', 'error'].includes(last.state) && last.question === question;
        const previousTurns = retry ? record.turns.slice(0, -1) : record.turns;

        if (previousTurns.length >= READING_TURN_LIMIT) throw new Error('这段阅读已较长，请在侧栏继续。');
        const turn = {question, answer: '', state: 'pending' as const};
        const candidate = {...record, turns: [...previousTurns, turn]};

        if (!isReadingTranscript(candidate) || JSON.stringify(candidate).length + READING_ANSWER_LIMIT > 64000) throw new Error('阅读记录已较长，请在侧栏继续。');
        record.turns = candidate.turns;
        record.requestId = crypto.randomUUID();
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

        if (readingBusy(record)) throw new Error('请先停止或等回答完成，再在侧栏继续。');

        if (record.transferredConversationId) { opening = false; deps.select(record.transferredConversationId);

 return {ok: true, record}; }

        record.handoffError = undefined;
        record.handoffRequestId ??= crypto.randomUUID();
        persist();

        if (!deps.send({type: 'conversation_create', requestId: record.handoffRequestId, title: `阅读 · ${record.source.text.slice(0, 28)}`, reading: record})) throw new Error('未连接到助手，暂时无法转到侧栏。');

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
    resumeOnOpen: (id: string) => opening || [...records.values()].some(r => r.transferredConversationId === id),
    receive(event: ReadingEvent) {
      void ready.then(() => {
        const record = records.get(event.threadId);

        if (record && record.handoffRequestId === event.requestId && event.state === 'error') {
          opening = false; record.handoffError = event.error ?? '无法转到侧栏，请重试。'; record.handoffRequestId = undefined; publish(record);

 return;
        }

        if (!record || record.requestId !== event.requestId || !readingBusy(record)) return;
        Object.assign(record.turns.at(-1)!, {state: event.state, answer: event.text, error: event.error});
        publish(record);
      });
    },
    disconnected() {
      void ready.then(() => { for (const r of records.values()) if (readingBusy(r)) { Object.assign(r.turns.at(-1)!, {state: 'error', error: '连接中断，已保留回答。恢复连接后可以重试。'}); publish(r); } });
    },
    created(message: Extract<ServerMessage, {type: 'conversation_created'}>) {
      void ready.then(async () => {
        const record = [...records.values()].find(r => r.handoffRequestId === message.requestId);

        if (!record || record.transferredConversationId === message.conversation.id) return;
        await deps.import(message.conversation.id, record);
        record.transferredConversationId = message.conversation.id;
        record.handoffError = undefined;
        opening = false;
        publish(record);
      });
    },
  };
}
