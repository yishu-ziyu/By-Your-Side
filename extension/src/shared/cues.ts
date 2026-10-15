/** 提示音：侧栏与设置页共用的开关。 */

/** chrome.storage.local 键：用户不在看侧栏时，做完或要用户出手是否响提示音。 */
export const ATTENTION_CUES_KEY = 'sideagent_attention_cues';

/** 只有明确存了 false 才算关闭；没存过算开启。 */
export function isCuesOn(stored: unknown): boolean {
  return stored !== false;
}
