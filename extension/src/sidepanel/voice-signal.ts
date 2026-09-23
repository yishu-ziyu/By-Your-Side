export function pcmBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.length * 2);
  const view = new DataView(bytes.buffer);

  for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i]!, true);

  return btoa(String.fromCharCode(...bytes));
}
