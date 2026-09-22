/** Also serialized into a page for AX targets; keep this function self-contained. */
export function replaceEditableText(element: HTMLElement, value: string): void {
  const document = element.ownerDocument;
  const selection = document.getSelection();
  if (!selection) throw new Error('富文本编辑器选区不可用，未填写');
  element.focus();
  if (!element.isConnected) throw new Error('富文本编辑器已失效，未填写');
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
  // Use one editing transaction. Direct textContent assignment is parsed back
  // by rich editors and can turn newlines into spaces; key events may submit.
  if (!document.execCommand('insertText', false, value)) {
    throw new Error('富文本编辑器未确认完整文本插入；请先读回字段，不要自动重试');
  }
}
