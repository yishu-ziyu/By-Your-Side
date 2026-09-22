export type VoiceIntentErrorCode = 'model_unavailable' | 'classifier_timeout' | 'classifier_failed' | 'classifier_invalid_reply' | 'free_reply_failed';

export class VoiceIntentError extends Error {
  constructor(readonly code: VoiceIntentErrorCode, readonly reason?:string) { super(code); this.name = 'VoiceIntentError'; }
}
