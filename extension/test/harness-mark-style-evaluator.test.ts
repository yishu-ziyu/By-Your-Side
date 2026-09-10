import {afterEach,beforeEach,expect,it,vi} from 'vitest';
beforeEach(()=>vi.resetModules());afterEach(()=>vi.unstubAllGlobals());
it('a fresh profile uses the existing hand-drawn boiling motion by default',async()=>{vi.stubGlobal('chrome',{storage:{local:{get:async()=>({})}}});const {getMarkMotion}=await import('../src/background/mode.js');expect(await getMarkMotion()).toBe('boil');});
it('an explicit saved motion choice is still respected',async()=>{vi.stubGlobal('chrome',{storage:{local:{get:async(key:string)=>({[key]:'grow'})}}});const {getMarkMotion}=await import('../src/background/mode.js');expect(await getMarkMotion()).toBe('grow');});
