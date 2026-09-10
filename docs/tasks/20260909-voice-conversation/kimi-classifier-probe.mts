/** 内容实体指代 vs 会话调度歧义：真实模型探针（变换实体名，带 conversation 上下文）。不进 CI。
 * 运行：npx tsx docs/tasks/20260909-voice-conversation/kimi-classifier-probe.mts */
import { BrowserAgentSession } from '../../../agent/src/session.js';
import { ToolRpc } from '../../../agent/src/rpc.js';

const conversation = {
  recentTurns: [
    { role: 'user', text: '看一下收件箱有什么新东西' },
    { role: 'assistant', text: '我只查看了收件箱当前这批标题。蓝湾读书会发来分享邀请，砾石工作室发来访谈邀请，还有松果月刊；尚未打开邮件正文。' },
  ],
  latestResult: { runId: 'probe-run', text: '我只查看了收件箱当前这批标题。蓝湾读书会发来分享邀请，砾石工作室发来访谈邀请，还有松果月刊；尚未打开邮件正文。', observedAt: Date.now(), source: 'assistant_output' },
} as const;

const cases: Array<{ text: string; state: string; expect: string[] }> = [
  { text: '分享那个呢？', state: 'idle', expect: ['chat'] },
  { text: '那个叫什么名字？', state: 'idle', expect: ['chat'] },
  { text: '读书会那个呢，讲什么的？', state: 'idle', expect: ['chat'] },
  { text: '不是访谈，是分享邀请。', state: 'running', expect: ['steer'] },
  { text: '暂停那个会话。', state: 'running', expect: ['clarify'] },
  { text: '停止。', state: 'running', expect: ['clarify'] },
  { text: '别说了。', state: 'running', expect: ['silence'] },
  { text: '帮我打开读书会的官网看看。', state: 'idle', expect: ['start'] },
];

const session = await BrowserAgentSession.create(new ToolRpc(() => { throw Error('no tools'); }), { emit: () => {}, setStatus: () => {} }, { modelPattern: 'minimax-cn/MiniMax-M3' });
if (!session.available) { console.log('MODEL_UNAVAILABLE'); process.exit(2); }
let failed = 0;
for (const c of cases) {
  try {
    const plan = await session.classifyVoiceInput(c.text, c.state, [], { goal: '看一下收件箱有什么新东西' }, conversation as any);
    const got = plan.steps.map(s => s.action);
    const ok = JSON.stringify(got) === JSON.stringify(c.expect);
    if (!ok) failed++;
    console.log(JSON.stringify({ text: c.text, state: c.state, expect: c.expect, got, ok }));
  } catch (error) {
    failed++;
    console.log(JSON.stringify({ text: c.text, state: c.state, expect: c.expect, error: String(error), ok: false }));
  }
}
session.dispose();
console.log(JSON.stringify({ ok: failed === 0, total: cases.length, failed }));
if (failed) process.exitCode = 1;
