/** Permission is requested from a full extension tab, never a hidden capture surface. */
export async function requestMicrophonePermission(getMedia = () => navigator.mediaDevices.getUserMedia({audio:true,video:false})): Promise<void> {
  const stream = await getMedia();
  stream.getTracks().forEach(track => track.stop());
}
export async function microphonePermissionState(): Promise<PermissionState | 'unknown'> {
  try { return (await navigator.permissions.query({name:'microphone' as PermissionName})).state; }
  catch { return 'unknown'; }
}
