export const SELF_USE_KEY = "sideagent_self_use";

export function selfUseActive(value: unknown, now = Date.now()): boolean {
  return !!value && typeof value === "object" && typeof (value as { until?: unknown }).until === "number" && (value as { until: number }).until > now;
}

export function watchSelfUse(onChange?: (active: boolean) => void): () => boolean {
  let value: unknown = null;

  void chrome.storage.local.get(SELF_USE_KEY).then(stored => { value = stored[SELF_USE_KEY]; onChange?.(selfUseActive(value)); }, () => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && SELF_USE_KEY in changes) { value = changes[SELF_USE_KEY]!.newValue; onChange?.(selfUseActive(value)); }
  });

  return () => selfUseActive(value);
}
