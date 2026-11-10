export const EVENT_QUESTION = '这个时间对应的是什么活动？只回活动名称，不超过 16 个字，不要标点，不要解释。';

export interface SelectionEvent {
  start: Date;
  timed: boolean;
}

const MAX_CHARS = 48;

const TITLE_LIMIT = 60;

const AFTERNOON: Record<string, boolean> = { 上午: false, 早上: false, 中午: true, 下午: true, 晚上: true, am: false, pm: true };

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const LOCAL = /(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)/;

const NUMERIC = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/;

const NAMED = new RegExp(`\\b(${MONTHS.join('|')})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?`, 'i');

const CLOCK = /(\d{1,2})\s*(?::|：|点|时)\s*(\d{1,2}|半)?/;

const HALF_DAY = new RegExp(Object.keys(AFTERNOON).join('|'), 'i');

export function parseSelectionEvent(text: string, now = new Date()): SelectionEvent | null {
  if (text.length > MAX_CHARS) return null;
  const local = LOCAL.exec(text);
  const numeric = local ? null : NUMERIC.exec(text);
  const named = local || numeric ? null : NAMED.exec(text);
  const found = local ?? numeric ?? named;

  if (!found) return null;
  const month = local ? Number(local[2]) : numeric ? Number(numeric[2]) : MONTHS.indexOf(named![1]!.toLowerCase()) + 1;
  const day = Number(local ? local[3] : numeric ? numeric[3] : named![2]);
  const stated = local ? local[1] : numeric ? numeric[1] : named![3];
  const rest = text.slice(found.index + found[0].length);
  const clock = CLOCK.exec(rest) ?? /(\d{1,2})\s*(am|pm)/i.exec(rest);
  const half = HALF_DAY.exec(rest)?.[0].toLowerCase();
  let hour = clock ? Number(clock[1]) : 0;
  const minute = clock?.[2] === '半' ? 30 : Number(clock?.[2]) || 0;

  if (clock && half && AFTERNOON[half] && hour < 12) hour += 12;
  let year = stated ? Number(stated) : now.getFullYear();
  const at = () => new Date(year, month - 1, day, hour, minute);

  if (!stated && at().getTime() < now.getTime() - 86_400_000) year += 1;
  const start = at();

  if (start.getMonth() !== month - 1 || start.getDate() !== day || hour > 23 || minute > 59) return null;

  return { start, timed: !!clock };
}

const pad = (value: number) => String(value).padStart(2, '0');

const day = (date: Date) => `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;

const moment = (date: Date) => `${day(date)}T${pad(date.getHours())}${pad(date.getMinutes())}00`;

const escaped = (value: string) => value.replace(/[\\;,]/g, mark => `\\${mark}`).replace(/\r?\n/g, '\\n');

export function eventFile(event: SelectionEvent, title: string, source: { text: string; url: string }): string {
  const end = new Date(event.start);

  if (event.timed) end.setHours(end.getHours() + 1);
  else end.setDate(end.getDate() + 1);
  const stamp = new Date().toISOString().replace(/[-:]|\.\d+/g, '');

  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//By Your Side//Selection//ZH', 'BEGIN:VEVENT',
    `UID:${crypto.randomUUID()}`, `DTSTAMP:${stamp}`,
    event.timed ? `DTSTART:${moment(event.start)}` : `DTSTART;VALUE=DATE:${day(event.start)}`,
    event.timed ? `DTEND:${moment(end)}` : `DTEND;VALUE=DATE:${day(end)}`,
    `SUMMARY:${escaped(title)}`, `DESCRIPTION:${escaped(`${source.text}\n${source.url}`)}`, `URL:${source.url}`,
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}

export function renderSelectionEvent(event: SelectionEvent, source: { text: string; title: string; url: string }): { element: HTMLElement; settle(answer: string | null): void } {
  const element = document.createElement('div');
  element.className = 'event';
  const title = document.createElement('input');
  title.type = 'text';
  title.placeholder = '正在找活动名称…';
  title.maxLength = TITLE_LIMIT;
  title.setAttribute('aria-label', '活动名称');
  const when = document.createElement('div');
  when.className = 'when';
  when.textContent = new Intl.DateTimeFormat('zh-CN', event.timed ? { month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false } : { month: 'long', day: 'numeric', weekday: 'short' }).format(event.start) + (event.timed ? '，一小时' : '，全天');
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'go';
  add.textContent = '加入日历';
  const saved = document.createElement('span');
  saved.className = 'saved';
  saved.setAttribute('role', 'status');
  let edited = false;
  let settled = false;
  title.addEventListener('input', () => { edited = true; });
  add.addEventListener('click', click => {
    click.stopPropagation();
    const name = title.value.trim() || source.title;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([eventFile(event, name, source)], { type: 'text/calendar' }));
    link.download = `${name.replace(/[\\/:*?"<>|]/g, ' ').trim() || 'event'}.ics`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    saved.textContent = '日程文件已下载，打开它就加进日历';
  });
  element.append(title, when, add, saved);

  return {
    element,
    settle(answer) {
      if (answer === null || settled) return;
      settled = true;
      title.placeholder = '活动名称';
      if (edited) return;
      title.value = (answer.split('\n').find(line => line.trim()) ?? '').trim().slice(0, TITLE_LIMIT) || source.title;
    },
  };
}
