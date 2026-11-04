const STEER_CHIPS = [
  { label: '改成对比表格', text: '把正在写的回答改成对比表格。' },
  { label: '浓缩成 3 句话', text: '把正在写的回答浓缩成 3 句话。' },
] as const;

const OWN_WORDS = '按你的补充';

function steerLabel(text: string): string {
  return STEER_CHIPS.find(chip => chip.text === text.trim())?.label ?? OWN_WORDS;
}

export function createSteerRibbon(composer: HTMLElement, before: HTMLElement, send: (text: string) => void) {
  const ribbon = document.createElement('div');
  ribbon.id = 'steer-ribbon';
  ribbon.hidden = true;
  const head = document.createElement('div');
  head.className = 'steer-ribbon-head';
  const title = document.createElement('span');
  title.className = 'steer-ribbon-title';
  title.textContent = '写到一半也能改方向';
  const hint = document.createElement('span');
  hint.className = 'steer-ribbon-hint';
  hint.textContent = '不用停，直接说';
  head.append(title, hint);
  const chips = document.createElement('div');
  chips.className = 'steer-chips';

  for (const chip of STEER_CHIPS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'steer-chip';
    button.textContent = `✦ ${chip.label}`;
    button.onclick = () => send(chip.text);
    chips.append(button);
  }

  ribbon.append(head, chips);
  composer.insertBefore(ribbon, before);
  let pending: string | null = null;

  return {
    setRunning(running: boolean) {
      ribbon.hidden = !running;
      composer.classList.toggle('steering-active', running);
    },
    noteSteer(text: string) {
      pending = steerLabel(text);
    },
    decorate(bubble: HTMLElement, animate: boolean) {
      if (!pending) return;
      const tag = document.createElement('div');
      tag.className = 'steer-tag';
      tag.textContent = `已改方向：${pending}`;
      bubble.before(tag);

      if (animate) bubble.classList.add('steer-morph');
      pending = null;
    },
    undecorate(bubble: HTMLElement) {
      const tag = bubble.previousElementSibling;

      if (!tag?.classList.contains('steer-tag')) return;
      pending = tag.textContent?.replace('已改方向：', '') ?? null;
      tag.remove();
    },
    reset() {
      pending = null;
    },
  };
}
