const squash = (text: string) => text.replace(/[\s*_`#>|]/g, "");

function answerFor(start: string, messages: HTMLElement): HTMLElement | null {
  const key = squash(start).slice(0, 40);

  if (!key) return null;
  const answers = [...messages.querySelectorAll<HTMLElement>(".msg.assistant")].reverse();

  return answers.find((answer) => squash(answer.dataset.markdown ?? answer.textContent ?? "").startsWith(key)) ?? null;
}

function resolveAnswerBubble(event: { answer: string; answerId?: string }, messages: HTMLElement): HTMLElement | null {
  if (event.answerId) {
    const answers = [...messages.querySelectorAll<HTMLElement>(".msg.assistant")];
    const exact = answers.find((el) => el.dataset.deliveryId === event.answerId);
    if (exact) return exact;
    if (answers.some((el) => typeof el.dataset.deliveryId === "string" && el.dataset.deliveryId.length > 0)) return null;
  }

  return answerFor(event.answer, messages);
}

export function factCheckAnswerId(answer: HTMLElement | null, event: { answerId?: string }): string | null {
  return answer?.dataset.deliveryId ?? event.answerId ?? null;
}

export function renderFactCheck(event: { answer: string; problems: string[]; replacement?: string; answerId?: string }, messages: HTMLElement, replaceAnswer?: (answer: HTMLElement, text: string) => void): HTMLElement | null {
  const answer = resolveAnswerBubble(event, messages);
  if (!answer) return null;
  answer.querySelector(":scope > .fact-check")?.remove();
  if (event.replacement !== undefined) {
    if (answer.dataset.markdown?.trim() !== event.answer) return null;
    replaceAnswer?.(answer, event.replacement);
  }
  answer.dataset.factChecked = "0";
  return answer;
}
