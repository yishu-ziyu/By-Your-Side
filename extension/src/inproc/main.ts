import { createModelRuntime } from "./model-runtime.js";
import { startInprocHost } from "./browser-host.js";
import { installPushToTalk } from "./ptt-capture.js";
import { installPttSpeech } from "./ptt-speech.js";

startInprocHost({
  createRuntime: createModelRuntime,
  onConnect: (listener) => chrome.runtime.onConnect.addListener(listener),
});

installPushToTalk();
installPttSpeech();
