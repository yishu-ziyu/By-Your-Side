import { describe, expect, it } from "vitest";
import { LATE_TRANSCRIPT_MERGE_MS, VoiceInputLedger } from "../src/voice-input-ledger.js";
import { VoicePlayback } from "../src/voice-playback.js";

describe("voice input vs playback vs task", () => {
  it("keeps a late ASR fragment on the new turn inside the merge window", () => {
    const input = new VoiceInputLedger();
    input.turn = 4;
    input.interrupt(5, true);
    expect(input.mergeLate(4, "预算改成")).toBe(true);
    expect(input.takeTranscript("六百")).toBe("预算改成 六百");
  });

  it("drops late ASR after the merge window", () => {
    const input = new VoiceInputLedger();
    input.turn = 1;
    input.interrupt(2, true);
    expect(input.mergeLate(1, "旧半句", Date.now() + LATE_TRANSCRIPT_MERGE_MS + 1)).toBe(false);
  });

  it("does not treat playback interrupt as a new input identity", () => {
    const playback = new VoicePlayback();
    playback.bind("resp-1", "delivery-1");
    const epoch = playback.interrupt();
    const done = playback.done("resp-1");
    expect(epoch).toBe(1);
    expect(done.ignored).toBe(true);
    expect(done.deliveryId).toBeNull();
  });

  it("queues official speech and drops it when control version no longer matches", () => {
    const playback = new VoicePlayback();
    playback.enqueue({ id: "d1", runId: "run-1", kind: "finding" }, 3);
    expect(playback.hasQueued("d1")).toBe(true);
    const [item] = playback.takeQueued();
    expect(item?.[1].controlVersion).toBe(3);
    expect(playback.hasQueued("d1")).toBe(false);
  });

  it("silences queued speech without a task-cancel API", () => {
    const playback = new VoicePlayback();
    playback.enqueue({ id: "ack", runId: "run-1", kind: "ack" }, 1);
    playback.silenceQueued();
    expect(playback.hasQueued("ack")).toBe(false);
    expect(playback.isSilenced("ack")).toBe(true);
    expect("cancelTask" in playback).toBe(false);
  });
});

it('preserves an unfinished phrase across noise, then consumes it once',()=>{
 const input=new VoiceInputLedger();input.holdTranscript('预算改成');
 expect(input.takeTranscript('')).toBe('');
 expect(input.takeTranscript('六百')).toBe('预算改成 六百');
 expect(input.takeTranscript('谢谢')).toBe('谢谢');
});
it('does not carry an unfinished phrase into a much later question',()=>{
 const input=new VoiceInputLedger();input.holdTranscript('预算改成');
 const now=Date.now;Date.now=()=>now()+21000;
 try{expect(input.takeTranscript('现在几点')).toBe('现在几点');}finally{Date.now=now;}
});

it('keeps multiple late fragments across rapid pauses and orders them by capture turn',()=>{
 const input=new VoiceInputLedger();input.turn=1;
 input.interrupt(2,true);input.interrupt(3,true);
 expect(input.mergeLate(2,'了解')).toBe(true);
 expect(input.mergeLate(1,'我想')).toBe(true);
 expect(input.mergeLate(1,'重复')).toBe(false);
 expect(input.takeTranscript('这个页面')).toBe('我想 了解 这个页面');
});
