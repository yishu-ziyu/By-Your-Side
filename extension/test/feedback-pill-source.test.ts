import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 反馈胶囊的呈现契约（页面侧源码检查）。
 * DOM 行为的真人观感由用户裁决；这里锁住机器能查的部分：
 * 复用同一个 overlay 宿主、文案走 textContent、减少动态偏好下不回弹。
 */
const cursorTs = readFileSync(resolve(__dirname, '../src/content/cursor.ts'), 'utf-8');

describe('执行反馈胶囊（content 源码契约）', () => {
  it('复用现有 overlay 宿主，不再建第二个悬浮窗', () => {
    const block = cursorTs.slice(cursorTs.indexOf('function renderFeedbackPill'), cursorTs.indexOf('function hideFeedbackPill'));
    expect(block).toContain('feedbackPill.className = "xpage xfeedback"');
    expect(block).toContain('shadow!.appendChild(feedbackPill)');
    expect(block).not.toContain('attachShadow');
    expect(cursorTs).not.toContain('OVERLAY_KIND_FEEDBACK');
  });

  it('文案只用 textContent 写入，不拼 innerHTML', () => {
    const block = cursorTs.slice(cursorTs.indexOf('function renderFeedbackPill'), cursorTs.indexOf('function hideFeedbackPill'));
    expect(block).toContain('main.textContent = feedbackPillState.text');
    expect(block).not.toContain('innerHTML');
  });

  it('回弹只有一次动画且尊重 prefers-reduced-motion', () => {
    const block = cursorTs.slice(cursorTs.indexOf('function showFeedbackPill'), cursorTs.indexOf('function hideFeedbackPill'));
    expect(block).toContain('const played = bounce && !reducedMotion.matches');
    expect(block.match(/\.animate\(/g) ?? []).toHaveLength(1);
  });

  it('自检入口可读当前反馈与回弹次数', () => {
    expect(cursorTs).toContain('ns.feedbackState = () => feedbackPillState ? {');
    expect(cursorTs).toContain('bounces: feedbackPillState.bounces');
  });
});
