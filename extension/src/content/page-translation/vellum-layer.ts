/** Injected before translationInPage; all runtime helpers stay in this ISOLATED-world function. */
export function installVellumLayer(): void {
  // SAFETY: this private namespace is created only by our scripts in the extension ISOLATED world.
  const world = globalThis as typeof globalThis & {
    __bysMountVellum?: (element: HTMLElement, sheet: HTMLElement) => () => void;
  };

  if (world.__bysMountVellum) return;

  world.__bysMountVellum = (element, sheet) => {
    const hadStyle = element.hasAttribute('style');
    const styles = new Map<string, {value: string; priority: string; applied: string}>();

    const ownStyle = (name: string, value: string) => {
      const saved = styles.get(name);
      // A website's later inline edit belongs to the website, including during cleanup.

      if (saved && (element.style.getPropertyValue(name) !== saved.applied || element.style.getPropertyPriority(name) !== 'important')) return false;

      if (!saved) styles.set(name, {value: element.style.getPropertyValue(name), priority: element.style.getPropertyPriority(name), applied: value});
      element.style.setProperty(name, value, 'important');
      styles.get(name)!.applied = element.style.getPropertyValue(name);

      return true;
    };

    const appearance = getComputedStyle(element);

    if (appearance.position === 'static') ownStyle('position', 'relative');
    sheet.classList.add('vellum-sheet');
    sheet.dataset.bysVellum = 'true';
    sheet.title = '按住查看原文';
    sheet.style.position = 'absolute';
    sheet.style.inset = '0 auto auto 0';
    sheet.style.width = '100%';
    sheet.style.boxSizing = 'border-box';
    sheet.style.margin = '0';
    sheet.style.padding = `${appearance.paddingTop} ${appearance.paddingRight} ${appearance.paddingBottom} ${appearance.paddingLeft}`;
    sheet.style.zIndex = '1';
    sheet.style.background = 'rgba(250, 249, 245, 0.96)';
    sheet.style.color = '#253146';
    sheet.style.borderRadius = '3px';
    sheet.style.boxShadow = '0 1px 4px rgba(28, 36, 52, 0.08)';
    sheet.style.transformOrigin = 'top left';
    sheet.style.userSelect = 'none';
    sheet.style.cursor = 'grab';

    for (const link of sheet.querySelectorAll('a')) link.style.color = '#2d4a86';

    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    let peeled = false;
    let suppressClick = false;
    let clickTimer: ReturnType<typeof setTimeout> | undefined;

    const paint = () => {
      sheet.style.transition = reducedMotion.matches ? 'none' : 'transform 0.3s cubic-bezier(0.34, 1.4, 0.64, 1), box-shadow 0.3s ease';
      // Reduced motion still reveals the actual source, without spatial movement.
      sheet.style.transform = peeled && !reducedMotion.matches ? 'translate(36%, -24%) rotate(13deg) scale(0.95)' : 'none';
      sheet.style.opacity = peeled && reducedMotion.matches ? '0' : '1';
      sheet.style.boxShadow = peeled ? '-12px 18px 30px rgba(0, 0, 0, 0.18)' : '0 1px 4px rgba(28, 36, 52, 0.08)';
      sheet.style.cursor = peeled ? 'grabbing' : 'grab';
      sheet.classList.toggle('peeled', peeled);
    };

    const reset = () => {
      if (peeled) { peeled = false; paint(); }

      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => { suppressClick = false; }, 0);
    };

    const consumePeelClick = (event: MouseEvent) => {
      if (!suppressClick) return;
      suppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const press = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;

      if (event.target instanceof Element && event.target.closest('a')) return;
      event.preventDefault();
      suppressClick = true;
      peeled = true;
      paint();
    };

    sheet.addEventListener('mousedown', press);
    element.addEventListener('click', consumePeelClick, true);
    // Listen on the stationary source block: the transformed sheet leaves the pointer itself.
    element.addEventListener('mouseleave', reset);
    document.addEventListener('mouseup', reset);
    document.addEventListener('pointercancel', reset);
    window.addEventListener('blur', reset);
    reducedMotion.addEventListener('change', paint);
    paint();

    let extraHeight = 0;
    let frame = 0;
    let disposed = false;

    const resize = () => {
      if (disposed || !element.isConnected || !sheet.isConnected) return;
      // Absolute translation does not take part in flow. Reserve only its extra height,
      // keeping source nodes, inline links and their original layout in place underneath.
      const padding = styles.get('padding-bottom');

      if (padding && (element.style.getPropertyValue('padding-bottom') !== padding.applied || element.style.getPropertyPriority('padding-bottom') !== 'important')) extraHeight = 0;
      const naturalHeight = Math.max(0, element.clientHeight - extraHeight);
      sheet.style.minHeight = `${naturalHeight}px`;
      const needed = Math.max(0, sheet.offsetHeight - naturalHeight);

      if (Math.abs(needed - extraHeight) < 1) return;
      const basePadding = Math.max(0, Number.parseFloat(getComputedStyle(element).paddingBottom) - extraHeight);

      if (ownStyle('padding-bottom', `${basePadding + needed}px`)) extraHeight = needed;
    };

    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(resize);
    });

    observer.observe(element);
    observer.observe(sheet);
    resize();

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      clearTimeout(clickTimer);
      sheet.removeEventListener('mousedown', press);
      element.removeEventListener('click', consumePeelClick, true);
      element.removeEventListener('mouseleave', reset);
      document.removeEventListener('mouseup', reset);
      document.removeEventListener('pointercancel', reset);
      window.removeEventListener('blur', reset);
      reducedMotion.removeEventListener('change', paint);

      for (const [name, saved] of styles) {
        if (element.style.getPropertyValue(name) !== saved.applied || element.style.getPropertyPriority(name) !== 'important') continue;

        if (saved.value) element.style.setProperty(name, saved.value, saved.priority);
        else element.style.removeProperty(name);
      }

      if (!hadStyle && !element.getAttribute('style')?.trim()) element.removeAttribute('style');
    };
  };
}

if (typeof document !== 'undefined') installVellumLayer();
