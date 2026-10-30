import { isPageElementSource, isPageDocumentIdentity } from '../../../shared/protocol.js';

export interface CitationContext { tabId: number; url: string; document: string }

export async function captureCitationContext(page: { id: number; url: string } | { tabId: number; url: string }): Promise<CitationContext | null> {
  const tabId = 'id' in page ? page.id : page.tabId;

  try {
    const result = await chrome.runtime.sendMessage({ type: 'PINPOINT_DOM_TARGET', action: 'identity', tabId, url: page.url });

    return result?.ok && isPageDocumentIdentity(result) && result.url === page.url ? { tabId, url: result.url, document: result.document } : null;
  } catch { return null; }
}

/** 正文里可去原页核对位置的数字（同一套规则也给出处角标找段落用）。 */
export function citationValues(text: string): string[] {
  return [...new Set(text.match(/[+−-]?\d[\d,]*(?:\.\d+)?(?:%|％|M|亿|万|元)?/g) ?? [])].filter(value => value.length >= 2).slice(0, 8);
}

export function toast(text: string): void {
  document.querySelector(".source-toast")?.remove();
  const note = document.createElement("div");
  note.className = "source-toast";
  note.setAttribute("role", "status");
  note.textContent = text;
  document.body.append(note);
  setTimeout(() => note.remove(), 2400);
}

/** 没做成的原因写进那条回答底部一排并一直留着：用户点完往往在看网页，回头时会自己消失的提示早没了。 */
export function noteFailure(from: Element, text: string): void {
  const feedback = from.closest(".msg.assistant")?.querySelector<HTMLElement>(".answer-action-feedback");

  if (!feedback) { toast(text);

 return; }
  feedback.classList.remove("answer-feedback-sr");
  feedback.textContent = text;
}

/** 同一处再点成功了，先前写下的原因就不再成立。 */
export function clearFailure(from: Element): void {
  const feedback = from.closest(".msg.assistant")?.querySelector<HTMLElement>(".answer-action-feedback");

  if (feedback && !feedback.classList.contains("answer-feedback-sr")) feedback.textContent = "";
}

/** 正文里第一处写着 value 的文字（不进链接、代码、界面文字、已标过的数字）。 */
function findNumberText(answer: HTMLElement, value: string): { node: Text; at: number } | null {
  const walker = document.createTreeWalker(answer, NodeFilter.SHOW_TEXT, {
    // 卡片里写了出处标签页的行有自己的“回原页”（answer-cards.ts），不再按提问那一页挂一次，免得同一行点数字和点空白去两个地方。
    acceptNode: node => node.parentElement?.closest("a,code,pre,button,.num-cite,.answer-actions,.answer-panel,.memory-used-line,.gen-card [data-gc-tab]") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    let at = text.indexOf(value);

    // 只认完整的数字：481 不能命中 1481 或 4810 里的一段。
    while (at >= 0 && (/[\d.,]/.test(text[at - 1] ?? "") || /\d/.test(text[at + value.length] ?? ""))) at = text.indexOf(value, at + 1);

    if (at < 0) continue;

    // SAFETY: SHOW_TEXT 的 walker 只返回文本节点。
    return { node: node as Text, at };
  }

  return null;
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
  body.querySelectorAll('.answer-sources,.source-fav,.answer-actions,.answer-panel,.memory-used-line').forEach(node => node.remove());
  const values = citationValues(body.textContent ?? '');

  for (const value of values) {
    let result;

    try { result = await chrome.runtime.sendMessage({ type: 'PINPOINT_DOM_TARGET', action: 'resolve', query: value, ...context }); }
    catch { continue; }

    if (!answer.isConnected || generations.get(answer) !== generation) return;

    if (!result?.ok || !isPageElementSource(result.source)) continue;
    const source = result.source;
    const found = findNumberText(answer, value);

    if (!found) continue;
    // 回答正文里的数字本身就是入口：虚下划线，点它回原页定位。
    const rest = found.node.splitText(found.at);
    rest.splitText(value.length);
    const mark = document.createElement('span');
    mark.className = 'num-cite';
    mark.tabIndex = 0;
    mark.setAttribute('role', 'button');
    mark.title = `回原页核对：${source.text}`;
    mark.setAttribute('aria-label', `回原页定位 ${value}`);
    rest.replaceWith(mark);
    mark.append(rest);

    let busy = false;

    const reveal = async () => {
      if (busy) return;
      busy = true;

      try {
        const reply = await chrome.runtime.sendMessage({ type: 'PINPOINT_DOM_TARGET', action: 'reveal', source, tabId });

        if (reply?.ok) clearFailure(mark);
        else noteFailure(mark, reply?.error ?? '未能定位原文。');
      } catch { noteFailure(mark, '来源页面连接已断开，请重新核对。'); }
      finally { busy = false; }
    };

    mark.onclick = () => void reveal();
    mark.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); void reveal(); } };
  }
}
