import { isPageElementSource, type PageElementSource } from '../../../shared/protocol.js';

export interface DropDraftState { ready: boolean; scope: string; revision: number }

export function installDropzone(composer: HTMLElement, accept: (source: PageElementSource, tabId: number) => void, draft: () => DropDraftState): void {
  let generation = 0;
  const hint = document.createElement('div');
  hint.className = 'dropzone-hint';
  hint.hidden = true;
  hint.textContent = '松手添加网页材料，不自动发送';
  composer.prepend(hint);
  const error = document.createElement('div');
  error.setAttribute('role', 'status');
  composer.append(error);
  const recognized = (event: DragEvent) => event.dataTransfer?.types.includes('application/x-by-your-side-feed');
  const clear = () => { composer.classList.remove('dropzone-hover'); hint.hidden = true; };

  composer.addEventListener('dragover', event => {
    if (!recognized(event)) return;
    event.preventDefault();
    event.dataTransfer!.dropEffect = 'copy';
    composer.classList.add('dropzone-hover');
    hint.hidden = false;
  });
  composer.addEventListener('dragleave', event => {
    if (!(event.relatedTarget instanceof Node) || !composer.contains(event.relatedTarget)) clear();
  });
  composer.addEventListener('drop', event => {
    const raw = event.dataTransfer?.getData('text/plain') ?? '';
    const token = event.dataTransfer?.getData('application/x-by-your-side-feed') || (raw.startsWith('by-your-side-feed:') ? raw.slice('by-your-side-feed:'.length) : '');
    clear();

    if (!token || token.length > 80) return;
    event.preventDefault();
    const before = draft();
    const current = ++generation;

    if (!before.ready) {
      error.textContent = '草稿还在恢复，材料未添加；请稍后重新拖入。';

      return;
    }

    error.textContent = '';
    void chrome.runtime.sendMessage({ type: 'FEED_DROPPED_ELEMENT', action: 'consume', token }).then(reply => {
      const after = draft();

      if (current !== generation || after.scope !== before.scope) return;

      if (!after.ready || after.revision !== before.revision) {
        error.textContent = '草稿已变化，未覆盖已有内容；请重新拖入。';

        return;
      }

      if (!reply?.ok || !isPageElementSource(reply.source) || !Number.isInteger(reply.tabId)) {
        error.textContent = reply?.error ?? '未能添加材料。';

        return;
      }

      accept(reply.source, reply.tabId);
    }, () => {
      if (current === generation && draft().scope === before.scope) error.textContent = '扩展连接已断开，材料未添加。';
    });
  });
  document.addEventListener('dragend', clear);
  window.addEventListener('blur', clear);
  window.addEventListener('pagehide', clear);
}
