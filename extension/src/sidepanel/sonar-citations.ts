import { isPageElementSource, isPageDocumentIdentity } from '../../../shared/protocol.js';

export interface CitationContext { tabId: number; url: string; document: string }

export async function captureCitationContext(page: { id: number; url: string } | { tabId: number; url: string }): Promise<CitationContext | null> {
  const tabId = 'id' in page ? page.id : page.tabId;

  try {
    const result = await chrome.runtime.sendMessage({ type: 'PINPOINT_DOM_TARGET', action: 'identity', tabId, url: page.url });

    return result?.ok && isPageDocumentIdentity(result) && result.url === page.url ? { tabId, url: result.url, document: result.document } : null;
  } catch { return null; }
}

/** 正文里可去原页核对位置的数字（同一套规则也给 #49 出处角标找段落用）。 */
export function citationValues(text: string): string[] {
  return [...new Set(text.match(/[+−-]?\d[\d,]*(?:\.\d+)?(?:%|％|M|亿|万|元)?/g) ?? [])].filter(value => value.length >= 2).slice(0, 8);
}

const generations = new WeakMap<HTMLElement, number>();
/** A number's presence in one original block is evidence of location, not proof of the model's interpretation. */

export async function attachSourceCitations(answer: HTMLElement, context: CitationContext | null): Promise<void> {
  if (!context) return;
  const { tabId } = context;
  const generation = (generations.get(answer) ?? 0) + 1;
  generations.set(answer, generation);
  answer.querySelector('.citation-row')?.remove();
  // 出处清单和角标是界面文字，不是回答正文里的数字。
  // SAFETY: cloneNode 保持原节点类型，answer 是 HTMLElement。
  const body = answer.cloneNode(true) as HTMLElement;
  body.querySelectorAll('.answer-sources,.source-mark').forEach(node => node.remove());
  const values = citationValues(body.textContent ?? '');
  const row = document.createElement('div');
  row.className = 'citation-row';

  for (const value of values) {
    let result;

    try { result = await chrome.runtime.sendMessage({ type: 'PINPOINT_DOM_TARGET', action: 'resolve', query: value, ...context }); }
    catch { continue; }

    if (!answer.isConnected || generations.get(answer) !== generation) return;

    if (!result?.ok || !isPageElementSource(result.source)) continue;
    const source = result.source;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'citation-btn';
    button.textContent = `✦ ${value} ↗`;
    button.title = `定位原文：${source.text}`;
    button.setAttribute('aria-label', `定位原文中的 ${value}`);
    button.onclick = async () => {
      button.disabled = true;
      row.querySelector('[role="status"]')?.remove();

      try {
        const reply = await chrome.runtime.sendMessage({ type: 'PINPOINT_DOM_TARGET', action: 'reveal', source, tabId });

        if (!reply?.ok) {
          const error = document.createElement('span');
          error.setAttribute('role', 'status');
          error.textContent = reply?.error ?? '未能定位原文。';
          row.querySelector('[role="status"]')?.remove();
          row.append(error);
        }
      } catch { button.title = '来源页面连接已断开，请重新核对。'; }
      finally { button.disabled = false; }
    };

    row.append(button);
  }

  if (row.childElementCount && answer.isConnected && generations.get(answer) === generation) answer.append(row);
}
