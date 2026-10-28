import { CONTINUATION_KEY } from '../../../shared/task-continuation.js';

const ALARM = 'sideagent-continuation-wakeup';

/** A wake hint only. The task checkpoint, not alarm delivery, decides what may resume. */
export function installContinuationWakeup(wake: () => void): void {
  const sync = async () => {
    const values = await chrome.storage.local.get(CONTINUATION_KEY);
    if (values[CONTINUATION_KEY] === true) await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
    else await chrome.alarms.clear(ALARM);
  };
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) wake(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && CONTINUATION_KEY in changes) void sync().catch(error => console.error('[continuation] wake hint update failed', error));
  });
  void sync().catch(error => console.error('[continuation] wake hint unavailable', error));
}
