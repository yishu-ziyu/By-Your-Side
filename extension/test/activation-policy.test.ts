import {describe, expect, it} from 'vitest';
import {assertActivationAllowed, requiresActivationConsent} from '../src/background/activation-policy.js';
import {HOST_PAGE_PROBES} from '../../shared/effect-policy.js';

// Failure cases specified before implementation: raw activation, arbitrary script,
// model forged confirmation, while immutable host probes and cleanup still work.
describe('activation bypass boundary', () => {
  it.each([
    ['mouse_down', {point:[10,10]}],
    ['key_down', {key:'Enter'}],
    ['key_down', {key:'Space'}],
    ['press_key', {key:'Control+Enter'}],
    ['press_key', {key:' '}],
    ['html5_drag', {from:'#a',to:'#b'}],
  ])('rejects %s before any browser dispatch', (name, params) => {
    expect(() => assertActivationAllowed(name, params)).toThrow(/未执行/);
  });
  it('permits only exact host probes, ordinary editing keys and release cleanup', () => {
    for (const code of Object.values(HOST_PAGE_PROBES)) {expect(() => assertActivationAllowed('js', {code})).not.toThrow();expect(requiresActivationConsent('js',{code})).toBe(true);}
    for (const name of ['release_held_inputs','snapshot','fill'])
      expect(() => assertActivationAllowed(name, {})).not.toThrow();
    expect(() => assertActivationAllowed('press_key', {key:'Tab'})).not.toThrow();
    expect(requiresActivationConsent('js', {code:HOST_PAGE_PROBES.pageInfo+';fetch("/buy")'})).toBe(true);
  });
});

it('every opaque activation requires consent regardless of label or readonly claims',()=>{for(const name of ['snapshot','read_element','read_elements','screenshot','observe_page','mark','release_held_inputs','click','double_click','fill','navigate','fetch','js','accept_dialog','select_option','type_text','press_key'])expect(requiresActivationConsent(name,{label:'safe',readonly:true})).toBe(true);});
