/**
 * tabs:switch 模型可见文字（工具 content）与核验结果一致：
 * 工作目标与可见结果分开表达；未核验/核验不通过时不得告诉模型“用户已经看到目标页”。
 * 回执来自扩展真实读回形状；这里只固定文字投影，成功资格由 execution-feedback 分类负责。
 */
import { expect, it } from 'vitest';
import { createBrowserTools } from '../src/tools.js';

const executeSwitch = async (receipt: unknown): Promise<{ text: string; details: unknown }> => {
  const call = async (name: string) => {
    if (name !== 'switch_tab') throw new Error(`unexpected tool ${name}`);
    return receipt;
  };
  // 与 tool-surface.test.ts 同法：execute 走 Function 调用面，本测试只关注入参与返回内容。
  const tools = createBrowserTools({ call, ensureToolCall() {}, markCallRejected() {} } as never) as Array<{ name: string; execute: Function }>;
  const tool = tools.find(t => t.name === 'tabs')!;
  const result = await tool.execute('call-1', { action: 'switch', tabId: 8 }) as { content: { text: string }[]; details: unknown };
  return { text: result.content[0]!.text, details: result.details };
};

it('核验通过：说明工作目标 + 核验时刻的可见事实（回执原样作为 details 贯穿）', async () => {
  const verification = { verified: true, activeTabId: 8, windowId: 1, windowFocused: true, workingTabId: 8 };
  const { text, details } = await executeSwitch({ tabId: 8, verification });
  expect(text).toContain('Working tab is now 8');
  expect(text).toContain('active tab of its focused window');
  expect(details).toMatchObject({ tabId: 8, verification });
});

it('回显一致但实际未激活：明说不是活动页，不宣称用户看到目标页', async () => {
  const { text } = await executeSwitch({ tabId: 8, verification: { verified: false, activeTabId: 7, windowId: 1, windowFocused: true, workingTabId: 8 } });
  expect(text).toContain('Working tab is now 8');
  expect(text).toContain('NOT the active tab (the active tab is 7)');
  expect(text).not.toContain('the user was on this page');
});

it('窗口未聚焦：明说用户可能没在看，不给可见承诺', async () => {
  const { text } = await executeSwitch({ tabId: 8, verification: { verified: false, activeTabId: 8, windowId: 1, windowFocused: false, workingTabId: 8 } });
  expect(text).toContain('was not focused');
  expect(text).toContain('may not be looking at it');
  expect(text).not.toContain('the user was on this page');
});

it('读回失败：可见性未确认', async () => {
  const { text } = await executeSwitch({ tabId: 8, verification: { verified: false } });
  expect(text).toContain('could not be read back; visibility is unconfirmed');
  expect(text).not.toContain('the user was on this page');
});

it('旧形状回执（无核验事实）：明确未经核验', async () => {
  const { text } = await executeSwitch({ tabId: 8 });
  expect(text).toContain('Working tab is now 8');
  expect(text).toContain('was not verified');
  expect(text).not.toContain('the user was on this page');
});
