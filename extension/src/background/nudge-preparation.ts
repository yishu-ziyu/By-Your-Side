import { NUDGE_PANEL_KEY, NUDGE_RESULTS_KEY, nudgeReceipts, isStoredNudgeOffer, nudgeableUrl, type NudgePreparationResult, type StoredNudgeOffer } from '../shared/nudge.js';
import { getTabResource } from './state.js';
import { readNudgeLinks } from './nudge-links.js';

const pageKey = (url: string) => url.split('#')[0]!;

export async function storedNudgeOffer(): Promise<StoredNudgeOffer | null> {
  const value: unknown = (await chrome.storage.session.get(NUDGE_PANEL_KEY))[NUDGE_PANEL_KEY];
  return isStoredNudgeOffer(value) ? value : null;
}

export function installNudgePreparation() {
  let queue: Promise<unknown> = Promise.resolve();
  const touched = new Set<number>();
  const read = async () => nudgeReceipts((await chrome.storage.session.get(NUDGE_RESULTS_KEY))[NUDGE_RESULTS_KEY]);
  const receipt = async (id: string) => (await read()).find(offer => offer.card.id === id) ?? null;
  const serial = <T>(action: () => Promise<T>): Promise<T> => {
    const next = queue.then(action);
    queue = next.catch(() => {});
    return next;
  };
  const update = (id: string | null, change: (result: NudgePreparationResult, offer: StoredNudgeOffer) => void) => {
    return serial(async () => {
      const receipts = await read();
      let changed = false;
      for (const offer of receipts) {
        if (id !== null && offer.card.id !== id) continue;
        const before = JSON.stringify(offer.result);
        change(offer.result, offer);
        if (JSON.stringify(offer.result) !== before) changed = true;
      }
      if (changed) await chrome.storage.session.set({ [NUDGE_RESULTS_KEY]: receipts });
    });
  };
  const ready = update(null, result => {
    if (result.state === 'opening') {
      result.state = 'stopped';
      result.message = '准备中断了，已经打开的入口仍保留。';
      result.completedAt = Date.now();
    }
  });

  const protect = (tabId: number) => {
    touched.add(tabId);
    void update(null, result => {
      const item = result.opened.find(tab => tab.tabId === tabId);
      if (item) item.canUndo = false;
    }).catch(() => {});
  };
  chrome.tabs.onActivated.addListener(info => protect(info.tabId));
  chrome.tabs.onMoved.addListener(tabId => protect(tabId));
  chrome.tabs.onDetached.addListener(tabId => protect(tabId));
  chrome.tabs.onRemoved.addListener(tabId => {
    touched.delete(tabId);
    void update(null, result => {
      const item = result.opened.find(tab => tab.tabId === tabId);
      if (item) { item.canUndo = false; item.closed = true; }
    }).catch(() => {});
  });
  chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (!change.url && !change.status && change.pinned === undefined) return;
    void update(null, result => {
      const item = result.opened.find(item => item.tabId === tabId);
      if (!item) return;
      if (tab.active || tab.pinned || (item.loaded && (change.url !== undefined || change.status === 'loading'))) item.canUndo = false;
      // 首次加载的跳转仍属于刚打开的入口；后续导航结束自动关闭的权限。
      if (!item.loaded && change.url) {
        if (nudgeableUrl(change.url)) item.actualUrl = change.url;
        else item.canUndo = false;
      }
      if (change.status === 'complete') item.loaded = true;
    }).catch(() => {});
  });

  const open = async (offer: StoredNudgeOffer, guard: () => Promise<string | null>, clickedAt = Date.now()): Promise<void> => {
    await ready;
    const preparation = offer.card.preparation;
    if (!preparation) return;
    const started = await serial(async () => {
      const receipts = await read();
      if (receipts.some(item => item.card.id === offer.card.id)) return false;
      const current = await storedNudgeOffer();
      if (current?.card.id !== offer.card.id || current.result) return false;
      const result: NudgePreparationResult = { state: 'opening', opened: [], reused: [], message: '正在准备入口…', clickedAt };
      await chrome.storage.session.set({ [NUDGE_RESULTS_KEY]: [...receipts, { ...current, result }] });
      return true;
    });
    if (!started) return;
    let stopped = '';
    try {
      let index = 1;
      for (const link of preparation.links) {
        const reason = await guard();
        if (reason) { stopped = reason; break; }
        const page = await readNudgeLinks(offer.tabId);
        if (!page || pageKey(page.url) !== pageKey(offer.url) || !page.links.some(actual => actual.url === link.url)) {
          stopped = '页面里的入口变了，先前的建议已停止。'; break;
        }
        const existing = (await chrome.tabs.query({})).find(tab => pageKey(tab.pendingUrl ?? tab.url ?? '') === pageKey(link.url));
        if (existing) {
          await update(offer.card.id, result => { result.reused.push(link); });
          continue;
        }
        const origin = await chrome.tabs.get(offer.tabId);
        if (!origin.active || pageKey(origin.pendingUrl ?? origin.url ?? '') !== pageKey(offer.url)) {
          stopped = '你已经换了页面，先前的建议已停止。'; break;
        }
        const opened = await chrome.tabs.create({ url: link.url, active: false, windowId: origin.windowId, index: origin.index + index++ });
        if (opened.id === undefined) throw new Error('入口没有打开。');
        const firstActionAt = Date.now();
        const tab = await chrome.tabs.get(opened.id).catch(() => null);
        await update(offer.card.id, result => {
          result.firstActionAt ??= firstActionAt;
          result.opened.push({ ...link, actualUrl: tab?.pendingUrl ?? tab?.url ?? link.url, tabId: opened.id!, windowId: opened.windowId,
            canUndo: !!tab && !tab.active && !tab.pinned && !touched.has(opened.id!), loaded: tab?.status === 'complete', ...(!tab ? { closed: true } : {}) });
        });
      }
    } catch { stopped = '有入口没能打开，已打开的仍保留。'; }
    await update(offer.card.id, result => {
      result.state = stopped ? 'stopped' : 'opened';
      const count = result.opened.filter(tab => !tab.closed).length;
      result.message = stopped || (count ? '已打开 ' + count + ' 个入口' : '这些入口已经开着');
      result.completedAt = Date.now();
    });
  };

  const undo = async (id: string): Promise<boolean> => {
    await ready;
    const offer = await receipt(id);
    if (!offer || offer.result.state === 'opening' || offer.result.state === 'undone') return false;
    for (const item of offer.result.opened) {
      if (!item.canUndo || item.closed) continue;
      const resource = await getTabResource(item.tabId);
      const fresh = await receipt(id);
      const tab = await chrome.tabs.get(item.tabId).catch(() => null);
      if (fresh?.card.id !== id || !fresh.result?.opened.find(t => t.tabId === item.tabId)?.canUndo
        || !tab || resource || touched.has(item.tabId) || tab.active || tab.pinned || tab.windowId !== item.windowId
        || (tab.pendingUrl ?? tab.url) !== item.actualUrl) continue;
      const closed = await chrome.tabs.remove(item.tabId).then(() => true, () => false);
      if (closed) await update(id, result => {
        const entry = result.opened.find(t => t.tabId === item.tabId);
        if (entry) { entry.closed = true; entry.canUndo = false; }
      });
    }
    await update(id, result => {
      const closed = result.opened.filter(tab => tab.closed).length;
      const kept = result.opened.length - closed;
      result.state = 'undone';
      result.message = '已收起 ' + closed + ' 个新入口' + (kept ? '；保留了 ' + kept + ' 个已使用或变化的标签页' : '');
      result.opened.forEach(tab => { tab.canUndo = false; });
    });
    return true;
  };

  const dismiss = async (id: string) => {
    await serial(async () => {
      const receipts = await read();
      await chrome.storage.session.set({ [NUDGE_RESULTS_KEY]: receipts.filter(offer => offer.card.id !== id) });
    });
  };
  return { open, undo, receipt, dismiss, busy: async () => (await read()).some(offer => offer.result.state === 'opening') };
}
