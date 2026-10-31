/**
 * 交付后的事实核对（agent/src/fact-check.ts）先由助手自己改正回答；改过仍对不上才挂在那条回答下面，都对得上就不出声。
 * 按回答开头找那一条，找不到（回答已被续做换掉）就不画：挂到别的回答下会让人以为说的是那一条。
 */
const squash = (text: string) => text.replace(/[\s*_`#>|]/g, "");

function answerFor(start: string, messages: HTMLElement): HTMLElement | null {
  const key = squash(start).slice(0, 40);

  if (!key) return null;
  const answers = [...messages.querySelectorAll<HTMLElement>(".msg.assistant")].reverse();

  return answers.find((answer) => squash(answer.dataset.markdown ?? answer.textContent ?? "").startsWith(key)) ?? null;
}

export function renderFactCheck(event: { answer: string; problems: string[] }, messages: HTMLElement): HTMLElement | null {
  const answer = answerFor(event.answer, messages);

  if (!answer) return null;
  answer.querySelector(":scope > .fact-check")?.remove();
  // 核对过、都对得上时界面上什么都没有：留一个标记，验收据此区分「核对过了」和「还没核对完」。
  answer.dataset.factChecked = String(event.problems.length);

  if (!event.problems.length) return answer;
  const note = document.createElement("div");
  note.className = "fact-check";
  note.setAttribute("role", "note");
  const title = document.createElement("div");
  title.className = "fact-check-title";
  title.textContent = `对照网页，有 ${event.problems.length} 处对不上`;
  const list = document.createElement("ul");

  for (const problem of event.problems) {
    const item = document.createElement("li");
    item.textContent = problem;
    list.append(item);
  }

  note.append(title, list);
  const actions = answer.querySelector(":scope > .answer-actions");

  if (actions) actions.before(note); else answer.append(note);
  return answer;
}
