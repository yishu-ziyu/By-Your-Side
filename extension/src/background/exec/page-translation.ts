import { validateTranslationCommand, type TranslationCommand, type TranslationReceipt } from '../../../../shared/page-translation.js';
import { translationInPage } from '../../shared/page-translation.js';
import { resolveWorkingTab } from '../state.js';

export async function pageTranslation(params: TranslationCommand, sessionId: string): Promise<TranslationReceipt> {
  validateTranslationCommand(params);
  const tab = await resolveWorkingTab(params.tabId, sessionId);
  const tabId = tab.id!;
  const [frame] = await chrome.scripting.executeScript({target: {tabId}, world: 'ISOLATED', func: translationInPage, args: [params]});
  if (!frame?.result) throw new Error('此页面不支持正文翻译。');
  return {...frame.result, tabId};
}
