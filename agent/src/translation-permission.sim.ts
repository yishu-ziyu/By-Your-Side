import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeTrace } from '../../shared/trace-sanitize.js';
import { intactTranslationRequest } from './translation-permission.js';

test('有删改或凭据的文字不能再作为页内写入授权', () => {
  const changed = String(sanitizeTrace('整页译文写回网页，token=demo；改为只发侧栏'));
  assert.equal(intactTranslationRequest(changed), false);
  for (const size of [24, 36, 64]) {
    const syntheticKey = 'demo_' + 'a'.repeat(size);
    assert.equal(intactTranslationRequest('说明：' + syntheticKey), false);
  }
  assert.equal(intactTranslationRequest('把这两段译文以中英对照放回原文旁。'), true);
});
