import assert from 'node:assert/strict';
import test from 'node:test';
import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai';
import { parseJsonReply, sideJudgment, type SideCallHost } from './side-judgment.js';

const THINKING_TOKENS = 300;

const model = { provider: 'minimax-cn', id: 'MiniMax-M3.1-Flash-Preview', api: 'anthropic-messages', reasoning: true, compat: { forceAdaptiveThinking: true }, contextWindow: 200_000, maxTokens: 32_000 } as unknown as Model<Api>;

function thinkingHost(seen: number[]): SideCallHost {
  return {
    models: {
      completeSimple: async (_model, _context, options) => {
        const ceiling = options?.maxTokens ?? Infinity;
        seen.push(ceiling);
        const answer = '{"scope":"whole"}';
        const fits = ceiling >= THINKING_TOKENS + answer.length;
        const reply = {
          role: 'assistant', api: 'anthropic-messages', provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash-Preview', timestamp: Date.now(),
          content: fits ? [{ type: 'thinking', thinking: 'x'.repeat(THINKING_TOKENS) }, { type: 'text', text: answer }] : [{ type: 'thinking', thinking: 'x'.repeat(ceiling) }],
          stopReason: fits ? 'stop' : 'length',
          usage: { input: 10, output: Math.min(ceiling, THINKING_TOKENS + answer.length), cacheRead: 0, cacheWrite: 0, totalTokens: 10 + Math.min(ceiling, THINKING_TOKENS + answer.length), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        } as unknown as AssistantMessage;
        return reply;
      },
    },
  };
}

const isScope = (value: unknown): value is { scope: string } => !!value && typeof value === 'object' && 'scope' in value;

test('a short judgment from a model that thinks before answering is not cut off by its answer budget', async () => {
  for (const maxTokens of [20, 80, 240]) {
    const seen: number[] = [];
    const scope = await sideJudgment(thinkingHost(seen), model, {
      purpose: 'probe', systemPrompt: 'Return JSON {"scope":"whole"}.', content: 'x', maxTokens, timeoutMs: 2000, retry: 'none', effort: 'low',
      parse: text => parseJsonReply(text, isScope).scope,
    });
    assert.equal(scope, 'whole', `answer budget ${maxTokens}`);
    assert.equal(seen.length, 1, 'answered in one request');
  }
});
