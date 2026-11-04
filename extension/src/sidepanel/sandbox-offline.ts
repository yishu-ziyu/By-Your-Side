export function removeWebRtc(): void {
  for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection"]) Reflect.deleteProperty(window, name);
}
