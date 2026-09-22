import { validateTranslationCommand, type TranslationCommand, type TranslationReceipt } from '../../../../shared/page-translation.js';
import { translationInPage } from '../../shared/page-translation.js';
import { resolveWorkingTab } from '../state.js';

export async function pageTranslation(params: TranslationCommand, sessionId: string): Promise<TranslationReceipt> {
  let tab: chrome.tabs.Tab;

  // Before injection starts, a failure cannot have changed the page.
  try {
    validateTranslationCommand(params);
    tab = await resolveWorkingTab(params.tabId, sessionId);
  }
  catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), {executionFact: 'not_executed' as const}); }

  const tabId = tab.id!;
  const [frame] = await chrome.scripting.executeScript({target: {tabId}, world: 'ISOLATED', func: translationInPage, args: [params]});

  if (!frame?.result) throw new Error('页面翻译未收到执行回执，结果未知；请先核查当前页面。');

  if ('error' in frame.result) throw Object.assign(new Error(frame.result.error), {executionFact: frame.result.executionFact});

  return {...frame.result, tabId};
}
