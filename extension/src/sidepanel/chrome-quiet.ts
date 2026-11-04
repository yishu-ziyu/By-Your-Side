import { D_EMPH, D_MICRO, E_ENTER } from "../shared/motion-tokens.js";

const QUIET_AFTER_TYPING_MS = 1000;

const TYPING_GAP_MS = 600;

const QUIET_OPACITY = 0.08;

export function installChromeQuiet(options: { input: HTMLTextAreaElement; messages: HTMLElement; faded: () => HTMLElement[]; hoverZone: string; menuOpen: () => boolean }): void {
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let quiet = false;
  let burstStart = 0;
  let lastInput = 0;
  const animations = new Map<HTMLElement, Animation>();

  const apply = (next: boolean) => {
    if (next === quiet) return;
    quiet = next;

    for (const element of options.faded()) {
      const from = Number(getComputedStyle(element).opacity);
      animations.get(element)?.cancel();
      animations.set(element, element.animate(next ? [{ opacity: from }, { opacity: QUIET_OPACITY }] : [{ opacity: from, offset: 0 }], {
        duration: reducedMotion.matches ? 0 : next ? D_EMPH : D_MICRO, easing: E_ENTER, fill: next ? 'forwards' : 'none',
      }));
    }
  };

  const mayQuiet = () => !options.menuOpen() && !document.querySelector(options.hoverZone)
    && (document.activeElement === options.input || document.activeElement === document.body || options.messages.contains(document.activeElement));

  const settle = () => { burstStart = 0; apply(false); };

  options.input.addEventListener('input', () => {
    const now = performance.now();

    if (!burstStart || now - lastInput > TYPING_GAP_MS) burstStart = now;
    lastInput = now;

    if (now - burstStart >= QUIET_AFTER_TYPING_MS && mayQuiet()) apply(true);
  });
  options.messages.addEventListener('wheel', () => { if (mayQuiet()) apply(true); }, { passive: true });
  document.addEventListener('pointermove', event => { if (event.movementX || event.movementY || event.pointerType !== 'mouse') settle(); });
  document.addEventListener('pointerdown', settle);
  document.addEventListener('focusin', () => { if (document.activeElement !== options.input) settle(); });
  // SAFETY: toggle 事件只在 popover 元素上触发，target 一定是 Element。
  document.addEventListener('toggle', event => { if ((event.target as Element).matches('[popover]')) settle(); }, true);
}
