import { reducedMotion } from "./branch-graph.js";

interface Dot { x: number; y: number; phase: number; speed: number; weight: number }

const GAP = 10;
const RADIUS = 1.5;
const BAND = 78;

function cloud(x: number, y: number): number {
  const v = Math.sin(x / 37 + y / 53) + Math.sin(x / 23 - y / 31 + 1.7) + Math.sin(x / 61 + y / 19 + 4.1);

  return Math.max(0, Math.min(1, (v + 1.2) / 3.2));
}

export function mountDottedGlow(canvas: HTMLCanvasElement, anchor: () => HTMLElement): () => void {
  const ctx = canvas.getContext("2d");

  if (!ctx) return () => {};
  const dpr = Math.min(Math.max(1, window.devicePixelRatio || 1), 2);
  let dots: Dot[] = [];
  let color = "";
  let raf = 0;
  let placed = "";

  const layout = () => {
    const box = canvas.getBoundingClientRect();
    const orb = anchor().getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(box.width * dpr));
    canvas.height = Math.max(1, Math.floor(box.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    color = getComputedStyle(canvas).getPropertyValue("--accent").trim() || "#2d4a86";
    placed = `${orb.left - box.left},${orb.top - box.top}`;
    const cx = orb.left - box.left + orb.width / 2;
    const cy = orb.top - box.top - 40;
    dots = [];

    for (let j = -1; j * GAP < box.height + GAP; j++) {
      const y = j * GAP;
      const dy = (y - cy) / (y > cy ? BAND / 2 : BAND);

      for (let i = -1; i * GAP < box.width + GAP; i++) {
        const x = i * GAP + (j % 2 ? GAP / 2 : 0);
        const dx = (x - cx) / (box.width * 0.55);
        const weight = Math.exp(-(dy * dy + dx * dx));

        if (weight > 0.03) dots.push({ x, y, weight, phase: Math.random() * 2, speed: 0.4 + Math.random() * 0.9 });
      }
    }
  };

  const draw = (now: number) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    const time = now / 1000;
    const drift = time * 9;

    for (const d of dots) {
      const mod = (time * d.speed + d.phase) % 2;
      const a = 0.25 + 0.55 * (mod < 1 ? mod : 2 - mod);
      ctx.shadowBlur = a > 0.6 ? 6 * (a - 0.6) / 0.4 : 0;
      ctx.globalAlpha = a * d.weight * cloud(d.x - drift, d.y) * 1.3;
      ctx.beginPath();
      ctx.arc(d.x, d.y, RADIUS, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  const loop = (now: number) => {
    const box = canvas.getBoundingClientRect(), orb = anchor().getBoundingClientRect();

    if (`${orb.left - box.left},${orb.top - box.top}` !== placed) layout();
    draw(now);
    raf = requestAnimationFrame(loop);
  };
  const ro = new ResizeObserver(() => { layout(); if (reducedMotion()) draw(0); });
  ro.observe(canvas);
  layout();

  if (reducedMotion()) draw(0);
  else raf = requestAnimationFrame(loop);

  return () => { cancelAnimationFrame(raf); ro.disconnect(); };
}
