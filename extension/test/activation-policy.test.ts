import {describe, expect, it} from 'vitest';
import {assertActivationAllowed} from '../src/background/activation-policy.js';
import {HOST_PAGE_PROBES} from '../../shared/effect-policy.js';

// Failure cases specified before implementation: raw activation, arbitrary script,
// model forged confirmation, while immutable host probes and cleanup still work.
describe('activation bypass boundary', () => {
  it.each([
    ['js', {code:'document.querySelector("form").requestSubmit()'}],
    ['js', {code:'fetch("/purchase", {method:"POST"})', readonly:true}],
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
    for (const code of Object.values(HOST_PAGE_PROBES)) expect(() => assertActivationAllowed('js', {code})).not.toThrow();
    for (const name of ['mouse_up','key_up','release_held_inputs','snapshot','fill'])
      expect(() => assertActivationAllowed(name, {})).not.toThrow();
    expect(() => assertActivationAllowed('press_key', {key:'Tab'})).not.toThrow();
    expect(() => assertActivationAllowed('js', {code:HOST_PAGE_PROBES.pageInfo+';fetch("/buy")'})).toThrow();
  });
});
