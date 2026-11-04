import { ORB_STYLE_STORAGE_KEY, parseOrbStyle, type OrbStyle } from '../../../shared/voice.js';
import { mountOrb, type OrbState } from './voice-orb.js';

interface VideoOrbLook { rate: number; brightness: number; scale: number }

const MAX_SCALE = 1.04;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

function videoOrbLook(state: OrbState, level: number, t: number): VideoOrbLook {
  if (state === 'thinking') return { rate: 1.45, brightness: 1, scale: 1 };

  if (state === 'listening') return { rate: 1.1, brightness: 1.08, scale: 1 + 0.03 * clamp01(level) };

  if (state === 'speaking') return { rate: 1.2, brightness: 1.12, scale: 1.02 + 0.02 * Math.sin(t * 7) };

  if (state === 'connecting') return { rate: 1, brightness: 0.95, scale: 1 };

  if (state === 'error' || state === 'disabled') return { rate: 1, brightness: 0.8, scale: 1 };

  return { rate: 1, brightness: 1, scale: 1 };
}

function mountVideoOrb(canvas: HTMLCanvasElement, size: number, style: Exclude<OrbStyle, 'particles'>, getState: () => OrbState, getLevel: () => number): () => void {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = canvas.height = Math.round(size * dpr);
  const ctx = canvas.getContext('2d')!;
  const video = Object.assign(document.createElement('video'), { src: chrome.runtime.getURL(`orbs/${style}.mp4`), muted: true, loop: true, playsInline: true, preload: 'auto' });
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const started = performance.now();
  let frame = 0;

  const draw = () => {
    const look = reduce ? videoOrbLook('idle', 0, 0) : videoOrbLook(getState(), getLevel(), (performance.now() - started) / 1000);

    if (!reduce && video.playbackRate !== look.rate) video.playbackRate = look.rate;
    const center = canvas.width / 2;
    const radius = (center / MAX_SCALE) * look.scale;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.filter = look.brightness === 1 ? 'none' : `brightness(${look.brightness})`;
    ctx.beginPath();
    ctx.arc(center, center, radius, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(video, center - radius, center - radius, radius * 2, radius * 2);
    ctx.restore();
  };

  const loop = () => {
    draw();
    frame = requestAnimationFrame(loop);
  };

  canvas.dataset.orbStyle = style;

  if (reduce) {
    canvas.dataset.orbPlaying = 'false';
    video.addEventListener('loadeddata', draw, { once: true });
  } else {
    video.addEventListener('playing', () => { canvas.dataset.orbPlaying = 'true'; });
    void video.play().catch(() => { canvas.dataset.orbPlaying = 'false'; });
    loop();
  }

  return () => {
    cancelAnimationFrame(frame);
    video.pause();
    video.removeAttribute('src');
    video.load();
    delete canvas.dataset.orbPlaying;
  };
}

export function mountVoiceOrb(canvas: HTMLCanvasElement, size: number, getState: () => OrbState, getLevel: () => number = () => 0): () => void {
  let style: OrbStyle | null = null;
  let dispose = () => {};

  let disposed = false;

  const apply = (next: OrbStyle) => {
    if (disposed || next === style) return;
    dispose();
    style = next;

    if (next === 'particles') {
      canvas.dataset.orbStyle = 'particles';
      dispose = mountOrb(canvas, size, getState, getLevel);
    } else {
      dispose = mountVideoOrb(canvas, size, next, getState, getLevel);
    }
  };

  const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && ORB_STYLE_STORAGE_KEY in changes) apply(parseOrbStyle(changes[ORB_STYLE_STORAGE_KEY]!.newValue));
  };

  chrome.storage.onChanged.addListener(onChanged);
  void chrome.storage.local.get(ORB_STYLE_STORAGE_KEY).then(stored => apply(parseOrbStyle(stored[ORB_STYLE_STORAGE_KEY])), () => apply(parseOrbStyle(undefined)));

  return () => {
    disposed = true;
    dispose();
    chrome.storage.onChanged.removeListener(onChanged);
  };
}
