import {afterEach, expect, it, vi} from "vitest";
import {historyEventTime, recordedDuration} from "../src/sidepanel/steps.js";
import {PanelHistory} from "../src/background/panel-history.js";
afterEach(()=>vi.restoreAllMocks());
it("restores 59 seconds from original events regardless of 1.4-second replay",()=>{
 vi.spyOn(Date,"now").mockReturnValue(1400);
 expect(recordedDuration(historyEventTime(true,1000),historyEventTime(true,60000))).toBe("59s");
});
it("does not invent elapsed time for old untimestamped history",()=>{
 expect(recordedDuration(historyEventTime(true),historyEventTime(true))).toBeNull();
});
it("keeps current live timing and records the original event timestamp",()=>{
 vi.spyOn(Date,"now").mockReturnValue(9000);
 expect(historyEventTime(false)).toBe(9000);
 expect(new PanelHistory().record({kind:"user",text:"A"}).occurredAt).toBe(9000);
});
it("keeps different conversation histories independent",()=>{
 const a=new PanelHistory(), b=new PanelHistory();
 const now=vi.spyOn(Date,"now").mockReturnValue(1000);
 const first=a.record({kind:"user",text:"A"});
 now.mockReturnValue(5000); b.record({kind:"user",text:"B"});
 now.mockReturnValue(60000); const last=a.record({kind:"server",msg:{type:"status",state:"idle"}});
 expect(recordedDuration(first.occurredAt!,last.occurredAt!)).toBe("59s");
});
