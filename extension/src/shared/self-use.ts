/**
 * 模拟用户模式：代理替用户试用产品时打开，到点自动关。
 * 打开期间不写记忆、不记过往任务和浏览习惯（代理说的话不是用户的话），诊断里把这些运行标成 self-use，周报不计入。
 * 开关由 scripts/maintenance/self-use.mjs 写进扩展存储，只存一个截止时间：忘了关也会自己失效。
 */
export const SELF_USE_KEY = "sideagent_self_use";

export function selfUseActive(value: unknown, now = Date.now()): boolean {
  return !!value && typeof value === "object" && typeof (value as { until?: unknown }).until === "number" && (value as { until: number }).until > now;
}

/** offscreen 文档里没有 chrome.storage：开关由后台随模型设置一起推过来（inproc_config），存在这里。 */
let pushed: unknown = null;

export function receiveSelfUse(value: unknown): void {
  pushed = value;
}

export const pushedSelfUse = (): boolean => selfUseActive(pushed);

/** 同步判断：先读一次，之后跟着存储变化走。界面和记忆判断这类不能等的地方用它。 */
export function watchSelfUse(onChange?: (active: boolean) => void): () => boolean {
  let value: unknown = null;

  void chrome.storage.local.get(SELF_USE_KEY).then(stored => { value = stored[SELF_USE_KEY]; onChange?.(selfUseActive(value)); }, () => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && SELF_USE_KEY in changes) { value = changes[SELF_USE_KEY]!.newValue; onChange?.(selfUseActive(value)); }
  });

  return () => selfUseActive(value);
}
