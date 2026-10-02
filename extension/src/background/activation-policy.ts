import {isHostPageProbe} from '../../../shared/effect-policy.js';

/**
 * Conservative stop for opaque activation paths. This is NOT a business-effect
 * classifier: custom click/fill/navigation event handlers remain outside it.
 * Raw CDP already uses a separate read-only allowlist.
 */
export function assertActivationAllowed(name: string, params: Record<string, unknown>): void {
  if (name === 'js' && !isHostPageProbe(name, params))
    throw new Error('页面脚本可能提交或发送，本次未执行。请用 snapshot/read_element/read_elements 读取，或接管页面完成这一步。');
  if (['mouse_down', 'drag', 'html5_drag'].includes(name))
    throw new Error('底层指针或拖放不能核对业务提交，本次未执行。请使用 click，或接管页面完成这一步。');
  if (name === 'press_key' || name === 'key_down') {
    // Resolve the key syntax conservatively; arbitrary shortcut handlers remain
    // a documented gap. Space activates focused buttons as well as Enter.
    const key = String(params.key ?? params.keys ?? '').trim().toLowerCase();
    if (!key || key.split('+').some(part => ['enter','return','space','spacebar'].includes(part.trim())))
      throw new Error('回车或空格可能提交当前表单，本次未执行。请使用 click，或接管页面完成这一步。');
  }
}
