/**
 * 回答写到一半改方向：任务运行时输入区上方出现快捷按钮，点了就作为插话发出（与打字回车同一条插话）。
 * 运行中发出的插话之后，新写出的回答前挂一枚「已改方向」标记。标记只看会话记录里的先后，
 * 所以重开侧栏回放历史时同样出现。
 */

export const STEER_CHIPS = [
  { label: '改成对比表格', text: '把正在写的回答改成对比表格。' },
  { label: '浓缩成 3 句话', text: '把正在写的回答浓缩成 3 句话。' },
] as const;

const OWN_WORDS = '按你的补充';

export function steerLabel(text: string): string {
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
    /** 运行中用户又说了一句（打字或快捷按钮）：下一段新回答按它写。 */
    noteSteer(text: string) {
      pending = steerLabel(text);
    },
    /** 新回答的气泡刚出现：有待挂的改方向就挂标记，并让气泡淡入替换原来那段。 */
    decorate(bubble: HTMLElement, animate: boolean) {
      if (!pending) return;
      const tag = document.createElement('div');
      tag.className = 'steer-tag';
      tag.textContent = `⚡ 已改方向：${pending}`;
      bubble.before(tag);

      if (animate) bubble.classList.add('steer-morph');
      pending = null;
    },
    /** 挂了标记的气泡被收进执行过程（这段只是过渡话）：标记一起拿掉，留给下一段新回答。 */
    undecorate(bubble: HTMLElement) {
      const tag = bubble.previousElementSibling;

      if (!tag?.classList.contains('steer-tag')) return;
      pending = tag.textContent?.replace('⚡ 已改方向：', '') ?? null;
      tag.remove();
    },
    reset() {
      pending = null;
    },
  };
}
