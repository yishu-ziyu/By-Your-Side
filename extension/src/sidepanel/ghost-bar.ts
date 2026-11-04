import type { GhostQuickAction, GhostQuickReply } from '../../../shared/protocol.js';

type Probe = Extract<GhostQuickReply, { available: GhostQuickAction[] }>;

const RETRY_EMPTY_MS = 1500;

const TIMING_VISIBLE_MS = 4000;

function label(action: GhostQuickAction, state: { playing: boolean; codeFolded: boolean }): string {
  if (action === 'toggle_play') return state.playing ? '⏸ 暂停视频' : '▶ 播放视频';

  if (action === 'next') return '⏭ 下一个';

  return state.codeFolded ? '⇱ 展开代码' : '⇲ 折叠代码';
}

async function ask(tabId: number, action: GhostQuickAction | 'probe'): Promise<GhostQuickReply | null> {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'GHOST_QUICK_ACTION', action }, { frameId: 0 }) ?? null;
  } catch {
    return null;
  }
}

interface GhostBar { setTab(tab: { id: number; url: string } | null): void }

export function createGhostBar(root: HTMLElement): GhostBar {
  let tabId: number | null = null;
  let generation = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let timingTimer: ReturnType<typeof setTimeout> | undefined;
  const buttons = document.createElement('div');
  buttons.className = 'ghost-actions';
  const timing = document.createElement('span');
  timing.className = 'ghost-timing';
  timing.setAttribute('role', 'status');
  root.append(buttons, timing);
  root.hidden = true;

  const render = (probe: Probe | null) => {
    buttons.replaceChildren();
    root.hidden = !probe || probe.available.length === 0;

    for (const action of probe?.available ?? []) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ghost-action';
      button.dataset.action = action;
      button.textContent = label(action, probe!);
      button.title = '直接在页面上做，不用模型';
      button.onclick = () => void run(action);
      buttons.append(button);
    }
  };

  const showTiming = (text: string, ok: boolean) => {
    clearTimeout(timingTimer);
    timing.textContent = text;
    timing.classList.toggle('failed', !ok);
    timing.hidden = false;
    if (ok) timingTimer = setTimeout(() => { timing.hidden = true; }, TIMING_VISIBLE_MS);
  };

  const probe = async (current: number, retryEmpty: boolean) => {
    const id = tabId;

    if (id === null) return;
    const reply = await ask(id, 'probe');

    if (current !== generation) return;
    const found = reply && 'available' in reply ? reply : null;
    render(found);

    if (retryEmpty && (!found || found.available.length === 0)) retry = setTimeout(() => void probe(current, false), RETRY_EMPTY_MS);
  };

  const run = async (action: GhostQuickAction) => {
    const id = tabId;

    if (id === null) return;
    const current = generation;
    const started = performance.now();
    const reply = await ask(id, action);
    const elapsed = Math.round(performance.now() - started);

    if (current !== generation) return;

    if (!reply || !('message' in reply)) {
      showTiming('页面没有回应，刷新页面后再试', false);
      retry = setTimeout(() => void probe(current, false), TIMING_VISIBLE_MS);

      return;
    }

    showTiming(reply.ok ? `${elapsed} ms · ${reply.message} · 没用模型` : reply.message, reply.ok);
    root.dataset.lastElapsedMs = String(elapsed);

    if (reply.ok) void probe(current, false);
    else retry = setTimeout(() => void probe(current, false), TIMING_VISIBLE_MS);
  };

  return {
    setTab(tab) {
      generation += 1;
      clearTimeout(retry);
      tabId = tab && /^https?:/.test(tab.url) ? tab.id : null;

      if (tabId === null) { render(null);

        return; }

      void probe(generation, true);
    },
  };
}
