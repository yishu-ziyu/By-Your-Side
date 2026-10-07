import type { ServerMessage } from '../../../shared/protocol.js';
import type { TaskView } from '../../../shared/task-view.js';
import { PTT_CAPSULE, PTT_LEVEL, type PttCapsule, type PttSpeechReply } from '../shared/ptt.js';

/**
 * 按住说话的网页底部胶囊（#125 第 2 步，docs/evals/20261007-ptt-capsule.md）：后台只管松开以后。
 * 按住、听写中由网页自己画；话交给助手后，按这个会话的任务视图和交付换成 在做 / 等你 / 结果 / 已停下。
 * 只读任务视图和交付，不是第二套任务状态；胶囊只在说话的那个标签页上。
 * 结果和等你同时念出来（docs/evals/20261007-ptt-speak.md）：念的时候胶囊带 speaking，念完再去掉。
 */

/** 任务停下后等这么久再出结果：目标核对和交付可能随后才到。 */
const SETTLE_MS = 800;

/** saidPhase：这一轮已经念过的那一步（结果或等你）；任务再跑起来就清空，下次停下再念。 */
interface Tracked { tabId: number; conversationId: string; heard: string; sawRun: boolean; result: string | null; settle?: ReturnType<typeof setTimeout>; saidPhase?: 'done' | 'waiting'; speaking?: boolean; last?: PttCapsule }

/** 回答的第一句；太长就截断。 */
function firstSentence(text: string): string {
  const plain = text.replace(/[#*`>_[\]]/g, '').replace(/\s+/g, ' ').trim();
  const end = plain.search(/[。！？!?](\s|$)|[。！？]/);
  const sentence = end >= 0 ? plain.slice(0, end + 1) : plain;

  return sentence.length > 80 ? `${sentence.slice(0, 79)}…` : sentence;
}

/** 当前步骤：和侧栏任务栏一样取正在做的动作，没有就是上一步。 */
const stepOf = (view: TaskView) => view.active.at(-1)?.action ?? view.lastAction?.action ?? null;

/** 念结果：speak 在不念（没 Key、关了）时返回 null，否则等念完；hush 马上停。 */
export interface PttVoice { speak(text: string): Promise<PttSpeechReply> | null; hush(): void }

/** 要念的那一句：结果 + 留给你的；等你时说需要你做什么。 */
export function speechFor(capsule: PttCapsule): string | null {
  if (capsule.phase === 'done') return capsule.left ? `${capsule.result} 留给你的：${capsule.left}` : capsule.result;

  if (capsule.phase === 'waiting') return `需要你：${capsule.reason}`;

  return null;
}

export function installPttCapsule(onChange: () => void, voice: PttVoice) {
  let tracked: Tracked | null = null;
  let recordingTab: number | null = null;

  const show = (tabId: number, capsule: PttCapsule | null) => {
    void chrome.tabs.sendMessage(tabId, { type: PTT_CAPSULE, capsule }).catch(() => { /* 网页已关或没有内容脚本 */ });
  };

  /** 显示结果或等你，同一步只念一次（目标核对、交付可能随后又让胶囊刷新一遍）；念完时还是这次跟踪，就去掉 speaking。 */
  const showAndSay = (t: Tracked, capsule: Extract<PttCapsule, { phase: 'done' | 'waiting' }>) => {
    t.last = capsule;

    if (t.saidPhase !== capsule.phase) {
      t.saidPhase = capsule.phase;
      const text = speechFor(capsule);
      const speaking = text ? voice.speak(text) : null;

      if (speaking) {
        t.speaking = true;
        void speaking.then(() => {
          t.speaking = false;

          if (tracked === t && t.last) show(t.tabId, t.last);
        });
      }
    }

    show(t.tabId, t.speaking ? { ...capsule, speaking: true } : capsule);
  };

  const settle = (view: TaskView) => {
    const t = tracked;

    if (!t) return;

    if (view.state === 'aborted' || view.state === 'error') voice.hush();

    if (view.state === 'aborted') return show(t.tabId, { phase: 'stopped', heard: t.heard });

    if (view.state === 'error') return show(t.tabId, { phase: 'failed', reason: '出错了，回侧栏看看。' });

    const goal = view.goalStatus;

    if (goal?.status === 'waiting') return showAndSay(t, { phase: 'waiting', heard: t.heard, reason: goal.remaining ?? '需要你回一句' });
    const left = goal && goal.status !== 'done' ? goal.remaining ?? view.latestDelivery?.unfinished?.[0] ?? null : null;
    showAndSay(t, { phase: 'done', heard: t.heard, result: t.result ? firstSentence(t.result) : '做完了。', left });
  };

  const onView = (view: TaskView) => {
    const t = tracked;

    if (!t || view.conversationId !== t.conversationId) return;
    clearTimeout(t.settle);

    if (view.state === 'running') {
      t.sawRun = true;
      t.saidPhase = undefined;
      show(t.tabId, { phase: 'doing', heard: t.heard, step: stepOf(view) });
    } else if (view.state === 'paused') {
      showAndSay(t, { phase: 'waiting', heard: t.heard, reason: '页面交给你了，做完回侧栏点继续。' });
    } else if (t.sawRun && (view.state === 'idle' || view.state === 'aborted' || view.state === 'error')) {
      t.settle = setTimeout(() => settle(view), SETTLE_MS);
    }
  };

  return {
    /** 现在显示胶囊的标签页：药丸在这一页让位。 */
    tabId: () => tracked?.tabId ?? recordingTab,
    /** 按下：记住是哪一页在录，音量往这一页送。 */
    recording(tabId: number) {
      voice.hush();

      if (tracked) clearTimeout(tracked.settle);
      tracked = null; recordingTab = tabId; onChange();
    },
    level(level: number) { if (recordingTab !== null) void chrome.tabs.sendMessage(recordingTab, { type: PTT_LEVEL, level }).catch(() => {}); },
    /** 松开后的结局：交给了助手（开始跟踪），或没成（直接显示原因）。 */
    handedOff(tabId: number, conversationId: string, heard: string) {
      recordingTab = null;
      tracked = { tabId, conversationId, heard, sawRun: false, result: null };
      show(tabId, { phase: 'doing', heard, step: null });
      onChange();
    },
    failed(tabId: number, reason: string, heard?: string) {
      recordingTab = null; tracked = null;
      show(tabId, heard ? { phase: 'failed', reason, heard } : { phase: 'failed', reason });
      onChange();
    },
    /** 网页收起了胶囊（取消、✕、到时间）。 */
    closed(tabId: number) {
      if (tracked?.tabId === tabId) { clearTimeout(tracked.settle); tracked = null; voice.hush(); }

      if (recordingTab === tabId) recordingTab = null;
      onChange();
    },
    /** 念的时候按了 Esc：停下声音，胶囊留着。 */
    hush() { voice.hush(); },
    conversationId: () => tracked?.conversationId ?? null,
    heard: () => tracked?.heard ?? null,
    server(msg: ServerMessage) {
      if (msg.type === 'task_view') onView(msg.view);

      if (msg.type === 'agent_event' && tracked && msg.conversationId === tracked.conversationId && msg.event.kind === 'user_delivery') tracked.result = msg.event.delivery.text;
    },
  };
}
