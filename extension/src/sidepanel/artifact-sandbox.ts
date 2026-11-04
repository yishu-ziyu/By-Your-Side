import { removeWebRtc } from "./sandbox-offline.js";

type SandboxMessage = { html: string };

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== window.parent) return;
  const { html } = event.data as SandboxMessage;

  removeWebRtc();
  document.open();
  document.write(String(html));
  document.close();
});

window.parent.postMessage({ artifactSandbox: "ready" }, "*");
