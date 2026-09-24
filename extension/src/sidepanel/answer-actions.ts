/** 文末操作只在回答落定时添加，复制文本不包含按钮文案。 */
export function attachAnswerActions(answer: HTMLElement): void {
  if (answer.querySelector('.answer-actions') || !answer.textContent?.trim()) return;
  const text = answer.innerText;
  const actions = document.createElement('div');
  actions.className = 'answer-actions';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = '复制回答';
  const feedback = document.createElement('span');
  feedback.className = 'answer-action-feedback';
  feedback.setAttribute('role', 'status');
  copy.onclick = async () => {
    copy.disabled = true;

    try {
      await navigator.clipboard.writeText(text);
      feedback.textContent = '已复制';
    } catch {
      feedback.textContent = '复制失败，请选中文字复制';
    } finally {
      copy.disabled = false;
    }
  };

  actions.append(copy, feedback);
  answer.append(actions);
}
