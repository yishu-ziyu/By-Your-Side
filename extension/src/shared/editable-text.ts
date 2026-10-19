/** Also serialized into a page for AX targets; keep this function self-contained. */
export function replaceEditableText(element: HTMLElement, value: string): void {
  const document = element.ownerDocument;
  const selection = document.getSelection();

  if (!selection) throw new Error('富文本编辑器选区不可用，未填写');
  let host = element;
  while (host.parentElement?.isContentEditable) host = host.parentElement;
  host.focus();

  if (!element.isConnected) throw new Error('富文本编辑器已失效，未填写');
  const before = (element.innerText ?? '').replace(/\n$/, '');
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);

  if (value === '') {
    if (document.execCommand('delete', false) || (element.innerText ?? '').replace(/\n$/, '') === '') return;
  }

  // Use one editing transaction. Direct textContent assignment is parsed back
  // by rich editors and can turn newlines into spaces; key events may submit.
  const inserted = value !== '' && document.execCommand('insertText', false, value);
  const afterInsert = (element.isConnected ? element.innerText : host.innerText).replace(/\n$/, '');
  if (inserted && (afterInsert !== before || before === value)) return;

  // Modern rich editors (ProseMirror, Slate, Notion/Feishu blocks) often ignore execCommand
  // and update internal document state from ClipboardEvent('paste') / beforeinput DataTransfer.
  if (typeof DataTransfer === 'function' && typeof ClipboardEvent === 'function') {
    const dt = new DataTransfer();
    dt.setData('text/plain', value);
    const box = document.createElement('div');
    for (const paragraph of value.split('\n\n')) {
      const p = document.createElement('p');
      paragraph.split('\n').forEach((line, idx) => {
        if (idx) p.append(document.createElement('br'));
        p.append(document.createTextNode(line));
      });
      box.append(p);
    }
    dt.setData('text/html', box.innerHTML);
    const target = element.isConnected ? element : host;
    const pasteEvt = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
    target.dispatchEvent(pasteEvt);
    const afterPaste = (element.isConnected ? element.innerText : host.innerText).replace(/\n$/, '');
    if (afterPaste !== before || before === value || pasteEvt.defaultPrevented) return;
    const beforeEvt = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertFromPaste', dataTransfer: dt });
    target.dispatchEvent(beforeEvt);
    const afterBeforeInput = (element.isConnected ? element.innerText : host.innerText).replace(/\n$/, '');
    if (afterBeforeInput !== before || beforeEvt.defaultPrevented) return;
  }

  if (!inserted) {
    throw new Error('富文本编辑器未确认完整文本插入；请先读回字段，不要自动重试');
  }
}
