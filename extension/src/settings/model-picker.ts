import { ChevronsUpDown, Search, Check, createElement } from 'lucide';

/** Keep the native select as the single source of choices and its existing save event. */
export function mountModelPicker(select: HTMLSelectElement, decorate: (value: string) => HTMLElement | SVGElement | null): void {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'model-picker-button sel';
  button.id = `${select.id}-picker`;
  button.setAttribute('aria-haspopup', 'listbox');
  const label = select.getAttribute('aria-label') ?? '模型';
  select.classList.add('picker-source');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  select.after(button);

  const pop = document.createElement('div');
  pop.className = 'model-picker-pop';
  pop.id = `${select.id}-options`;
  pop.popover = 'auto';
  button.setAttribute('aria-controls', pop.id);
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = '搜索模型或服务商';
  search.setAttribute('aria-label', `搜索${label}`);
  const head = document.createElement('div');
  head.className = 'model-picker-search';
  head.append(createElement(Search, { width: 14, height: 14, 'aria-hidden': 'true' }), search);
  const list = document.createElement('div');
  list.className = 'model-picker-list';
  list.role = 'listbox';
  list.setAttribute('aria-label', label);
  pop.append(head, list);
  // A picker opened within a modal must belong to that dialog's top-layer subtree.
  (select.closest('dialog') ?? document.body).append(pop);
  let options: HTMLButtonElement[] = [];
  let active = 0;

  const place = () => {
    const rect = button.getBoundingClientRect();
    const width = Math.min(420, innerWidth - 24);
    const height = Math.min(360, innerHeight - 24);
    pop.style.width = `${width}px`;
    pop.style.maxHeight = `${height}px`;
    pop.style.left = `${Math.max(12, Math.min(rect.right - width, innerWidth - width - 12))}px`;
    pop.style.top = `${rect.bottom + height + 6 <= innerHeight ? rect.bottom + 6 : Math.max(12, rect.top - height - 6)}px`;
  };
  const markActive = () => options.forEach((option, index) => {
    option.tabIndex = index === active ? 0 : -1;
    option.classList.toggle('is-active', index === active);
  });
  const render = () => {
    list.replaceChildren();
    options = [];
    const query = search.value.trim().toLowerCase();
    let lastGroup = '';
    for (const option of select.options) {
      const group = option.parentElement instanceof HTMLOptGroupElement ? option.parentElement.label : '';
      if (option.disabled || !`${group} ${option.text}`.toLowerCase().includes(query)) continue;
      if (group && group !== lastGroup) {
        const heading = document.createElement('div');
        heading.className = 'model-picker-group';
        heading.textContent = group;
        list.append(heading);
      }
      lastGroup = group;
      const choice = document.createElement('button');
      choice.type = 'button';
      choice.role = 'option';
      choice.className = 'model-picker-option';
      choice.setAttribute('aria-selected', String(option.value === select.value));
      choice.dataset.value = option.value;
      const name = document.createElement('span');
      name.textContent = option.text;
      choice.append(name);
      if (option.value === select.value) choice.append(createElement(Check, { width: 14, height: 14, 'aria-hidden': 'true' }));
      choice.addEventListener('click', () => {
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        update();
        pop.hidePopover();
        button.focus();
      });
      list.append(choice);
      options.push(choice);
    }
    if (!options.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = '没有匹配的模型，可以在连接页添加服务商或模型。';
      list.append(empty);
    }
    active = Math.max(0, options.findIndex(o => o.getAttribute('aria-selected') === 'true'));
    markActive();
  };
  const update = () => {
    const option = select.selectedOptions[0];
    button.replaceChildren();
    const leading = decorate(select.value);
    if (leading) button.append(leading);
    const text = document.createElement('span');
    text.className = 'model-picker-label';
    text.textContent = option?.text ?? '选择模型';
    button.append(text, createElement(ChevronsUpDown, { width: 12, height: 14, 'aria-hidden': 'true' }));
    button.title = option?.text ?? '';
    button.setAttribute('aria-label', `${label}：${text.textContent}`);
    button.hidden = select.hidden;
    button.disabled = select.disabled;
    if (pop.matches(':popover-open')) render();
  };
  button.addEventListener('click', () => {
    if (pop.matches(':popover-open')) { pop.hidePopover(); return; }
    search.value = '';
    render();
    place();
    pop.showPopover();
    search.focus();
  });
  search.addEventListener('input', render);
  pop.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      active = document.activeElement === search ? 0 : (active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % Math.max(1, options.length);
      markActive();
      options[active]?.focus();
    } else if (event.key === 'Enter' && document.activeElement === search) {
      event.preventDefault();
      options[active]?.click();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      pop.hidePopover();
      button.focus();
    }
  });
  pop.addEventListener('toggle', () => button.setAttribute('aria-expanded', String(pop.matches(':popover-open'))));
  window.addEventListener('resize', () => { if (pop.matches(':popover-open')) place(); });
  document.addEventListener('scroll', () => { if (pop.matches(':popover-open')) place(); }, true);
  new MutationObserver(update).observe(select, { childList: true, subtree: true, attributes: true });
  select.addEventListener('change', update);
  update();
}
