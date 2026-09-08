/* Loaded only after an explicit voice start; its output stays silent. */
class VoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor() { super(); this.frame = new Int16Array(480); this.offset = 0; this.energy = 0; }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      const value = Math.max(-1, Math.min(1, input[i]));
      this.frame[this.offset++] = Math.round(value * (value < 0 ? 32768 : 32767));
      this.energy += value * value;
      if (this.offset === 480) {
        const frame = this.frame;
        this.port.postMessage({ pcm: frame.buffer, rms: Math.sqrt(this.energy / 480) }, [frame.buffer]);
        this.frame = new Int16Array(480); this.offset = 0; this.energy = 0;
      }
    }
    return true;
  }
}
registerProcessor("voice-capture", VoiceCaptureProcessor);
