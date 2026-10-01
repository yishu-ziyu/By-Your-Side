/**
 * 生成网页的沙箱页（manifest 的 sandbox.pages）：独立的不透明来源，没有 chrome.* 接口、读不到扩展存储与查看页 DOM。
 * 查看页把网页正文 postMessage 过来，这里整页写入，模型写的脚本在这里运行。
 * 本页 CSP 见 manifest 的 content_security_policy.sandbox。
 */
/** 查看页发来的唯一一种消息。 */
type SandboxMessage = { html: string };

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== window.parent) return;
  // SAFETY: 上一行已确认发送方是嵌着本页的查看页，它只发 {html: 字符串}（artifact-viewer-page.ts renderHtml）。
  const { html } = event.data as SandboxMessage;

  document.open();
  document.write(String(html));
  document.close();
});

window.parent.postMessage({ artifactSandbox: "ready" }, "*");
