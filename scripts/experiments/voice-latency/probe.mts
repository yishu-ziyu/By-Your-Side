/** 定点实验：语音意图分类的 2.7 秒到底是模型固有往返，还是输入/输出规模造成的。
 *
 * 只调用真实生产模型，不启动扩展、不碰浏览器、不写产品状态。
 * 输出一次 JSON，供 docs/evals 引用。用完即弃，不作为产品入口。
 *
 * 运行：npx tsx scripts/experiments/voice-latency/probe.mts
 */
import {createConversationRuntime} from '../../../agent/src/conversation-runtime.js';
import {VOICE_INTENT_PROMPT, voiceDecisionClauses} from '../../../agent/src/voice-intent.js';

const MODEL = 'opencode-go/deepseek-flash';

const inputs = ['嗨，晚上好。', '把姓名改成李明', '暂停', '十加七等于多少？'];

const reports: any[] = [];

const runtime = await createConversationRuntime('probe', () => {}, MODEL);

const session: any = runtime.session;

const inner = session.session;

if (!session.available || !inner?.model) throw new Error('生产模型不可用，实验终止');

const headers = { 'x-opencode-session': inner.sessionId, 'x-opencode-client': 'pi' };

/** 与生产 classifyVoiceInput 完全同形的输入。 */
function payload(text: string) {
  return JSON.stringify({ state: 'idle', text, clauses: voiceDecisionClauses(text) });
}

async function timed<T>(label: string, run: () => Promise<T>) {
  const started = Date.now();

  try {
    const value = await run();

    return { label, ms: Date.now() - started, value };
  } catch (error) {
    return { label, ms: Date.now() - started, error: String(error) };
  }
}

// A. 供应商往返下限：极小提示、极小输出。用来区分“模型慢”和“我们的输入慢”。
for (let i = 0; i < 3; i++) {
  const r = await timed(`floor-${i + 1}`, () => session['modelRuntime'].completeSimple(inner.model, {
    systemPrompt: '只回复两个字。',
    messages: [{ role: 'user', content: '说你好', timestamp: Date.now() }],
  }, { maxTokens: 20, reasoning: 'minimal', sessionId: inner.sessionId, headers, signal: AbortSignal.timeout(30_000) }));

  reports.push({ kind: 'floor', ...r, value: undefined, text: (r.value as any)?.content?.map((p: any) => p.text).join('') });
}

// B/C. 生产分类调用：原样 vs 只加 reasoning:minimal。
for (const text of inputs) {
  for (const variant of ['production', 'minimal'] as const) {
    const r = await timed(`${variant}:${text}`, () => session['modelRuntime'].completeSimple(inner.model, {
      systemPrompt: VOICE_INTENT_PROMPT,
      messages: [{ role: 'user', content: payload(text), timestamp: Date.now() }],
    }, {
      maxTokens: 1400,
      temperature: 0,
      ...(variant === 'minimal' ? { reasoning: 'minimal' as const } : {}),
      sessionId: inner.sessionId,
      headers,
      signal: AbortSignal.timeout(30_000),
    }));

    reports.push({
      kind: 'classify', variant, text, ms: r.ms, error: r.error,
      reply: (r.value as any)?.content?.map((p: any) => p.text).join('').slice(0, 400),
    });
  }
}

// D. 生产入口端到端：含 JSON 解析与计划校验。
for (const text of inputs.slice(0, 2)) {
  const r = await timed(`plan:${text}`, () => session.classifyVoiceInput(text, 'idle', [], { goal: null }));
  reports.push({ kind: 'plan', text, ms: r.ms, error: r.error, steps: (r.value as any)?.steps });
}

runtime.dispose();

console.log(JSON.stringify({ model: MODEL, at: new Date().toISOString(), reports }, null, 1));
