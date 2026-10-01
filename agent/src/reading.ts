import type { ReadingEvent, ReadingTranscript } from '../../shared/reading.js';
import { SideCallError } from './side-judgment.js';

export type ReadingGenerate = (transcript: ReadingTranscript, signal: AbortSignal, onText: (text: string) => void) => Promise<string>;

/** Owns cancellation before asynchronous model setup; never touches execution state. */
export class ReadingRequests {
  private readonly active = new Map<string, { requestId: string; abort: AbortController }>();
  async run(requestId: string, transcript: ReadingTranscript, generate: ReadingGenerate, emit: (event: ReadingEvent) => void): Promise<void> {
    const threadId = transcript.threadId;

    if (this.active.get(threadId)?.requestId === requestId) return;
    this.active.get(threadId)?.abort.abort();
    const abort = new AbortController();
    const run = { requestId, abort };

    if (this.active.size >= 16 && !this.active.has(threadId)) {
      emit({type: 'reading_event', threadId, requestId, state: 'error', text: '', error: '同时进行的阅读请求过多，请先停止一个。'});

      return;
    }

    this.active.set(threadId, run);
    let text = '';
    const current = () => this.active.get(threadId) === run;

    const publish = (state: ReadingEvent['state'], error?: string) => {
      if (!current()) return;
      emit(error ? {type: 'reading_event', threadId, requestId, state, text, error} : {type: 'reading_event', threadId, requestId, state, text});
    };

    publish('pending');

    try {
      text = await generate(transcript, AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]), value => {
        if (!current() || abort.signal.aborted) return;
        text = value;
        publish('streaming');
      });
      publish(abort.signal.aborted ? 'stopped' : 'done');
    } catch (error) {
      // 带上原因类别（模型拒绝了请求参数、超时……），不带服务商原文。
      const reason = error instanceof SideCallError ? error.message : undefined;
      publish(abort.signal.aborted ? 'stopped' : 'error', abort.signal.aborted ? undefined : `这次回答没有完成${reason ? `（${reason}）` : ''}。已保留内容，可以重试。`);
    } finally {
      if (current()) this.active.delete(threadId);
    }
  }
  cancel(threadId: string, requestId: string): void {
    const run = this.active.get(threadId);

    if (run?.requestId === requestId) run.abort.abort();
  }
}
