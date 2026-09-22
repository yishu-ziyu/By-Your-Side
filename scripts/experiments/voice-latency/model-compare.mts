/** 定点实验：同一套分类提示，换更快的模型能不能既缩短往返、又不改判断。
 *
 * 对照生产模型 opencode-go/deepseek-flash 的判断结果，逐句比较。
 * 只读调用，不改产品配置。运行：npx tsx scripts/experiments/voice-latency/model-compare.mts
 */
import {createConversationRuntime} from '../../../agent/src/conversation-runtime.js';
import {VOICE_INTENT_PROMPT, voiceDecisionClauses} from '../../../agent/src/voice-intent.js';

const REFERENCE = {provider: 'opencode-go', id: 'deepseek-flash'};

const CANDIDATES = [
  {provider: 'cliproxy', id: 'gemini-3.1-flash-lite'},
  {provider: 'cliproxy', id: 'gemini-3-flash'},
  {provider: 'cliproxy', id: 'kimi-k2.5'},
  {provider: 'cliproxy', id: 'gpt-5.4-mini'},
];

const INPUTS = [
  '嗨，晚上好。',
  '十加七等于多少？',
  '把姓名改成李明',
  '暂停',
  '当前招聘页面要求几年经验？',
  '现在进展怎么样了',
  '帮我在这个页面找到邮箱并复制下来',
  '先别动，我再说一遍要求',
];

const STATE = 'idle';

const runtime = await createConversationRuntime('probe', () => {}, `${REFERENCE.provider}/${REFERENCE.id}`);

const session: any = runtime.session;

if (!session.available) throw new Error('会话不可用，实验终止');

const inner = session.session;

const modelRuntime = session['modelRuntime'];

async function ask(model: any, text: string) {
  const started = Date.now();

  const reply = await modelRuntime.completeSimple(model, {
    systemPrompt: VOICE_INTENT_PROMPT,
    messages: [{role: 'user', content: JSON.stringify({state: STATE, text, clauses: voiceDecisionClauses(text)}), timestamp: Date.now()}],
  }, {maxTokens: 1400, temperature: 0, sessionId: inner.sessionId, headers: {'x-opencode-session': inner.sessionId, 'x-opencode-client': 'pi'}, signal: AbortSignal.timeout(40_000)});

  const raw = reply.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('').trim();
  let action: string | null = null;

  try { action = JSON.parse(raw).steps?.[0]?.action ?? null; } catch { /* 非 JSON 记为 null */ }

  return {ms: Date.now() - started, action, raw: raw.slice(0, 160)};
}

async function runModel(label: string, provider: string, id: string) {
  const model = modelRuntime.getModel(provider, id);

  if (!model) return {label, provider, id, error: '模型不可用或未配置凭据', rows: []};
  const rows: any[] = [];

  for (const text of INPUTS) {
    try {
      rows.push({text, ...(await ask(model, text))});
    } catch (error) {
      rows.push({text, error: String(error).slice(0, 160)});
    }
  }

  return {label, provider, id, rows};
}

const reference = await runModel('reference', REFERENCE.provider, REFERENCE.id);

const results = [reference];

for (const candidate of CANDIDATES) results.push(await runModel(candidate.id, candidate.provider, candidate.id));

const ref = new Map(reference.rows.map((r: any) => [r.text, r.action]));

const summary = results.map(r => ({
  model: r.label,
  medianMs: (() => {
    const times = r.rows.filter((x: any) => typeof x.ms === 'number').map((x: any) => x.ms).sort((a: number, b: number) => a - b);

    return times.length ? times[Math.floor(times.length / 2)] : null;
  })(),
  decisions: r.rows.map((x: any) => `${x.action ?? 'ERR'}${ref.has(x.text) && x.action !== ref.get(x.text) ? `(≠${ref.get(x.text)})` : ''}`).join(' '),
  errors: r.rows.filter((x: any) => x.error).length,
}));

runtime.dispose();

console.log(JSON.stringify({inputs: INPUTS, summary, detail: results}, null, 1));
