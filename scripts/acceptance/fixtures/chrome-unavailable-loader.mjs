/** Fault injection only; never preload for a real browser acceptance run. */
import {registerHooks} from 'node:module';
registerHooks({load(url,context,next){
  if(url.endsWith('/scripts/acceptance/discover.mjs')) return {
    format:'module', shortCircuit:true,
    source:'export function discoverChromeMain(){throw new Error("P0 injected: Chrome unavailable");}',
  };
  return next(url,context);
}});
