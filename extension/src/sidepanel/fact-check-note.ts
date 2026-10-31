/**
 * 事实核对的诊断不显示为卡片。证据修订只更新同一份回答，历史事件仍可重放。
 * 按回答开头找那一条，找不到（回答已被续做换掉）就不画：挂到别的回答下会让人以为说的是那一条。
 */
const squash = (text: string) => text.replace(/[\s*_`#>|]/g, "");

function answerFor(start: string, messages: HTMLElement): HTMLElement | null {
  const key = squash(start).slice(0, 40);

  if (!key) return null;
  const answers = [...messages.querySelectorAll<HTMLElement>(".msg.assistant")].reverse();

  return answers.find((answer) => squash(answer.dataset.markdown ?? answer.textContent ?? "").startsWith(key)) ?? null;
}

export function renderFactCheck(event: { answer: string; problems: string[]; replacement?: string }, messages: HTMLElement, replaceAnswer?: (answer: HTMLElement, text: string) => void): HTMLElement | null {
  const answer = answerFor(event.answer, messages);
  if (!answer) return null;
  answer.querySelector(":scope > .fact-check")?.remove();
  if (event.replacement !== undefined) {
    if (answer.dataset.markdown?.trim() !== event.answer) return null;
    replaceAnswer?.(answer, event.replacement);
  }
  answer.dataset.factChecked = "0";
  return answer;
}
