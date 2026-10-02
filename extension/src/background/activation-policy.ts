
/**
 * Conservative stop for opaque activation paths. This is NOT a business-effect
 * classifier: every unknown effect is handled by the separate consent gate.
 * Raw CDP already uses a separate read-only allowlist.
 */
export function assertActivationAllowed(name: string, params: Record<string, unknown>): void {

  if (['mouse_down', 'mouse_up', 'key_up', 'drag', 'html5_drag'].includes(name))
    throw new Error('底层指针或拖放不能核对业务提交，本次未执行。请使用 click，或接管页面完成这一步。');
  if (name === 'press_key' || name === 'key_down') {
    // Space activates focused buttons as well as Enter. Other shortcuts still
    // require an exact grant through the conservative consent gate.
    const key = String(params.key ?? params.keys ?? '').trim().toLowerCase();
    if (!key || key.split('+').some(part => ['enter','return','space','spacebar'].includes(part.trim())))
      throw new Error('回车或空格可能提交当前表单，本次未执行。请使用 click，或接管页面完成这一步。');
  }
}

/** Unknown requests need a precise user grant; labels never prove harmlessness. */
export function requiresActivationConsent(name:string, params:Record<string,unknown>):boolean {
  // Even fixed JS runs in MAIN world, where page-owned getters may write.
  return !new Set(['list_tabs','get_active_tab','network','dialog_info','download_stat','consume_events','arm_event','wait_event','disarm_event','clear_marks','ask_user_to_point','worker_tabs','cdp']).has(name);
}
