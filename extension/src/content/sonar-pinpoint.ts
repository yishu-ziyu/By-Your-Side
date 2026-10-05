import { isPageInteractionMessage } from '../../../shared/protocol.js';
import { findUniqueSource, resolveSource, documentIdentity } from './page-sources.js';

export function installSonarPinpoint(): void {
  let active: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const style = document.createElement('style');
  style.textContent = `@keyframes bys-sonar-wave{0%{box-shadow:0 0 0 0 #2d4a86aa}60%{box-shadow:0 0 0 14px #2d4a8600}100%{box-shadow:0 0 0 0 #2d4a8600}}.bys-sonar-active{outline:2px solid #2d4a86;outline-offset:3px;animation:bys-sonar-wave 1.2s ease-out}@media(prefers-reduced-motion:reduce){.bys-sonar-active{animation:none}}`;
  document.documentElement.append(style);
  const clear = () => { clearTimeout(timer); active?.classList.remove('bys-sonar-active'); active = null; };

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (!isPageInteractionMessage(message)) return;


    if (message?.type !== 'PINPOINT_DOM_TARGET') return;

    if (message.action === 'identity') { respond({ ok: true, ...documentIdentity() });

      return; }

    if (message.action === 'resolve') {
      const identity = documentIdentity();

      if (message.document !== identity.document || message.url !== identity.url) { respond({ ok: false, error: '请求的原页面已变化，未生成引用。' });

        return; }

      const source = findUniqueSource(message.query);
      respond(source ? { ok: true, source } : { ok: false, error: '没有唯一的原文位置，未生成引用。' });

      return;
    }

    if (message.action !== 'reveal') return;
    const element = resolveSource(message.source);

    if (!element) { respond({ ok: false, error: '原文已变化，请重新核对来源。' });

      return; }

    clear();
    active = element;
    element.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' });
    element.classList.add('bys-sonar-active');
    timer = setTimeout(clear, 1200);
    respond({ ok: true });
  });
  window.addEventListener('pagehide', clear);
}
