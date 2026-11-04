/**
 * WHY: 沙箱页写入模型内容前调用。CSP 管不到 WebRTC：STUN/TURN 走 UDP，用户名或服务器域名就能把页面里的资料带出去，
 * Chrome 也不认 CSP 的 webrtc 指令，只能在写入前把构造函数删掉（document.open 不换 window，删掉的仍然不在）。
 */
export function removeWebRtc(): void {
  for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection"]) Reflect.deleteProperty(window, name);
}
