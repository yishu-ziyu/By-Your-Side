import {expect,it} from 'vitest';
import {judgeBudgetRun} from '../../scripts/acceptance/voice-steer-oracle.mjs';
const valid = {mode:'voice',baseline:{budget:1000,prices:[899,699,799]},page:{budget:800,prices:[699,799],sort:'asc'},starts:1,receipts:1,receiptAt:10,firstAudioAt:20};
it('requires exact DOM and actual delivery before speech',()=>{
  expect(judgeBudgetRun(valid).ok).toBe(true);
  for(const change of [
    {page:{...valid.page,budget:1000}}, {page:{...valid.page,prices:[699,799,899]}},
    {page:{...valid.page,prices:[799,699]}}, {page:{...valid.page,sort:'original'}},
    {receipts:0},{receipts:2},{starts:2},{firstAudioAt:5},{page:undefined},{baseline:undefined},
  ]) expect(judgeBudgetRun({...valid,...change}).ok).toBe(false);
});
