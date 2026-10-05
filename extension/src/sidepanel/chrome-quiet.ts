/**
 * 工具栏淡出（#46）：连续打字约 1 秒或用滚轮读回答时，顶栏按钮和输入区的次要按钮淡下去；
 * 鼠标一动、键盘焦点移到别处、菜单开着时立刻回来。状态、输入框、发送/停止、我来/你继续、任务条不动。
 * 用 Web Animations 叠在原有样式上，不改各按钮自己的按压过渡。
 */

const QUIET_AFTER_TYPING_MS = 1000;

/** 两次按键间隔超过它，就算重新开始打字。 */
const TYPING_GAP_MS = 600;

const FADE_OUT_MS = 400;

const FADE_IN_MS = 120;

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
      // 恢复时只回到元素自己的样式（比如禁用时的半透明），动画结束就撤掉，不留下覆盖。
      animations.set(element, element.animate(next ? [{ opacity: from }, { opacity: QUIET_OPACITY }] : [{ opacity: from, offset: 0 }], {
        duration: reducedMotion.matches ? 0 : next ? FADE_OUT_MS : FADE_IN_MS, easing: 'cubic-bezier(0.23, 1, 0.32, 1)', fill: next ? 'forwards' : 'none',
      }));
    }
  };

  // 指针停在这些控件上、菜单开着、焦点不在输入框（比如 Tab 到了按钮上）时不淡出：免得「看不见却点到」。
  const mayQuiet = () => !options.menuOpen() && !document.querySelector(options.hoverZone)
    && (document.activeElement === options.input || document.activeElement === document.body || options.messages.contains(document.activeElement));

  const settle = () => { burstStart = 0; apply(false); };

  // 只在打字过程中判断：打两个字就发送不会事后变淡。
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
