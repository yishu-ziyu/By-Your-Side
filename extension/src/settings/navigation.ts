import { Database, FlaskConical, ListChecks, Mic, MousePointer2, Palette, SlidersHorizontal, createElement } from 'lucide';

const pages = [
  { id: 'models', label: '模型与连接', icon: SlidersHorizontal },
  { id: 'voice', label: '语音与朗读', icon: Mic },
  { id: 'web', label: '网页体验', icon: MousePointer2 },
  { id: 'tasks', label: '任务与通知', icon: ListChecks },
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'data', label: '记忆与数据', icon: Database },
  { id: 'labs', label: '实验功能', icon: FlaskConical },
] as const;
type SettingsPage = typeof pages[number]['id'];
type SettingsDestination = SettingsPage | 'connections' | 'preferences';
const aliases = { connections: 'models', preferences: 'web' } as const;

export function mountSettingsNavigation(beforeLeave: () => void): (page: SettingsDestination) => void {
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
  const show = (destination: SettingsDestination) => {
    const id = Object.hasOwn(aliases, destination) ? aliases[destination as keyof typeof aliases] : destination as SettingsPage;
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
  const fromHash = () => {
    const hash = location.hash.slice(1);
    show(pages.some(page => page.id === hash) || Object.hasOwn(aliases, hash) ? hash as SettingsDestination : 'models');
  };
  document.getElementById('manage-connections')!.addEventListener('click', () => {
    show('models');
    document.getElementById('connections-title')?.scrollIntoView({ block: 'start' });
  });
  window.addEventListener('hashchange', fromHash);
  fromHash();
  return show;
}
