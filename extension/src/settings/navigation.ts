import { Database, KeyRound, Mic, MousePointer2, Palette, SlidersHorizontal, createElement } from 'lucide';

const pages = [
  { id: 'models', label: '模型', icon: SlidersHorizontal },
  { id: 'connections', label: '连接', icon: KeyRound },
  { id: 'voice', label: '语音', icon: Mic },
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'preferences', label: '使用偏好', icon: MousePointer2 },
  { id: 'data', label: '数据与诊断', icon: Database },
] as const;
type SettingsPage = typeof pages[number]['id'];

export function mountSettingsNavigation(beforeLeave: () => void): (page: SettingsPage) => void {
  const nav = document.getElementById('settings-nav')!;
  const buttons = pages.map(page => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.settingsPage = page.id;
    button.append(createElement(page.icon, { width: 16, height: 16, 'aria-hidden': 'true' }), document.createTextNode(page.label));
    nav.append(button);
    button.addEventListener('click', () => show(page.id));
    return button;
  });
  const show = (id: SettingsPage) => {
    beforeLeave();
    for (const panel of document.querySelectorAll<HTMLElement>('[data-settings-panel]')) panel.hidden = panel.dataset.settingsPanel !== id;
    buttons.forEach(button => {
      button.classList.toggle('active', button.dataset.settingsPage === id);
      if (button.dataset.settingsPage === id) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    document.getElementById('settings-page-title')!.textContent = pages.find(p => p.id === id)!.label;
    document.getElementById('manage-connections')!.hidden = id !== 'models';
    history.replaceState(null, '', `#${id}`);
  };
  const fromHash = () => show(pages.find(p => p.id === location.hash.slice(1))?.id ?? 'models');
  document.getElementById('manage-connections')!.addEventListener('click', () => show('connections'));
  window.addEventListener('hashchange', fromHash);
  fromHash();
  return show;
}
