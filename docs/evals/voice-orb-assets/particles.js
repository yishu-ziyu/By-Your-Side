// ../../../../private/tmp/particles-preview.ts
var ORB_STATES = [
  "idle",
  "connecting",
  "listening",
  "thinking",
  "speaking"
];
var ERROR_COLOR_FROM = "#fb7185";
var ERROR_COLOR_TO = "#f43f5e";
var hexToRgb = (hex) => {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const n = Number.parseInt(full, 16);
  return [n >> 16 & 255, n >> 8 & 255, n & 255];
};
var stateMotion = (state) => {
  switch (state) {
    case "listening":
      return "ripple";
    case "thinking":
      return "pulse";
    case "speaking":
      return "flow";
    default:
      return "none";
  }
};
var stateEnergy = (state, t) => {
  switch (state) {
    case "listening":
      return 0.4 + 0.32 * Math.abs(Math.sin(t * 8.5)) + 0.18 * Math.abs(Math.sin(t * 4.1 + 1.5));
    case "speaking":
      return 0.3 + 0.24 * Math.abs(Math.sin(t * 6.2)) + 0.16 * Math.abs(Math.sin(t * 3 + 0.6));
    case "thinking":
      return 0.24 + 0.2 * Math.abs(Math.sin(t * 2.4));
    case "connecting":
      return 0.12 + 0.1 * Math.abs(Math.sin(t * 1.6));
    case "error":
      return 0.2;
    default:
      return 0;
  }
};
var approach = (current, target, rate, dt) => current + (target - current) * (1 - Math.exp(-rate * dt));
var createStateMix = (initial = "idle") => {
  const weights = {
    idle: 0,
    connecting: 0,
    listening: 0,
    thinking: 0,
    speaking: 0,
    error: 0,
    disabled: 0
  };
  weights[initial] = 1;
  const keys = Object.keys(weights);
  const update = (state, dt, rate = 6) => {
    let total = 0;
    for (const key of keys) {
      const target = key === state ? 1 : 0;
      const next = approach(weights[key], target, rate, dt);
      weights[key] = target === 0 && next < 1e-3 ? 0 : next;
      total += weights[key];
    }
    if (total > 0) {
      for (const key of keys) weights[key] /= total;
    }
    return weights;
  };
  return { weights, update };
};
var PARTICLE_COUNT = 720;
var TWO_PI = Math.PI * 2;
var GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
var STATIC_TIME = 1.7;
var ERROR_FROM_RGB = hexToRgb(ERROR_COLOR_FROM);
var ERROR_TO_RGB = hexToRgb(ERROR_COLOR_TO);
var mixRgb = (a, b, m) => [
  a[0] + (b[0] - a[0]) * m,
  a[1] + (b[1] - a[1]) * m,
  a[2] + (b[2] - a[2]) * m
];
var buildSphere = (count) => {
  const points = [];
  for (let i = 0; i < count; i += 1) {
    const y = 1 - i / (count - 1) * 2;
    const radiusAtY = Math.sqrt(1 - y * y);
    const theta = GOLDEN_ANGLE * i;
    points.push({
      x: Math.cos(theta) * radiusAtY,
      y,
      z: Math.sin(theta) * radiusAtY,
      ringFrac: i * 0.61803398875 % 1,
      seed: i * 0.7548776662 % 1 * TWO_PI,
      tone: i * 0.5436890126 % 1
    });
  }
  return points;
};
function mountOrb(canvas, size, getState) {
  const ctx = canvas.getContext("2d");
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  ctx.scale(dpr, dpr);
  const stateRef = { current: getState() }, speedRef = { current: 1 }, colorRef = { current: { from: "#f0abfc", to: "#818cf8" } };
  const points = buildSphere(PARTICLE_COUNT);
  const center = size / 2;
  const baseRadius = center * 0.62;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const stateMix = createStateMix(stateRef.current);
  let t = reduce ? STATIC_TIME : 0;
  let angleY = 0;
  let connectingPhase = 0;
  const angleX = 0.32;
  let levelS = 0;
  const render = (dt, isStatic = false) => {
    const st = stateRef.current;
    const spd = speedRef.current;
    const easeDt = isStatic ? 60 : dt;
    const w = stateMix.update(st, easeDt);
    let ripple = 0;
    let pulse = 0;
    let flow = 0;
    for (const s of ORB_STATES) {
      const kind = stateMotion(s);
      if (kind === "ripple") ripple += w[s];
      else if (kind === "pulse") pulse += w[s];
      else if (kind === "flow") flow += w[s];
    }
    const wIdle = w.idle;
    const wConn = w.connecting;
    const wError = w.error;
    const wDisabled = w.disabled;
    const motionScale = 1 - wDisabled * 0.96;
    const rawLevel = isStatic ? stateEnergy(st, t) : stateEnergy(st, t);
    levelS = approach(levelS, rawLevel, 9, easeDt);
    const level = levelS;
    const spin = (0.14 + ripple * (0.9 + level * 1.6) + flow * 0.4 + wConn * 0.3) * motionScale;
    angleY += dt * spd * spin;
    connectingPhase = (connectingPhase + dt * spd * 1.1) % TWO_PI;
    const breathe = 0.05 * (0.25 + wIdle * 0.75) * Math.sin(t * 1.1 * spd) * motionScale;
    const conv = pulse * (0.22 + 0.12 * Math.sin(t * 2.6 * spd + 1));
    const expand = flow * (0.08 + level * 0.32);
    const radius = baseRadius * (1 + breathe + level * 0.16 + expand - conv);
    const from = mixRgb(hexToRgb(colorRef.current.from), ERROR_FROM_RGB, wError);
    const to = mixRgb(hexToRgb(colorRef.current.to), ERROR_TO_RGB, wError);
    const shakeAmp = wError * radius * 0.05 * motionScale;
    const shakeX = shakeAmp * (Math.sin(t * 26 * spd) + 0.5 * Math.sin(t * 15.7 * spd));
    const shakeY = shakeAmp * (Math.cos(t * 22.5 * spd) + 0.5 * Math.sin(t * 13.1 * spd));
    const idleAmp = wIdle * radius * 0.055 * motionScale;
    const jitterAmp = (flow + wError * 0.7) * radius * (0.015 + level * 0.085) * motionScale;
    const rippleAmp = ripple * (0.045 + level * 0.24);
    const pulseAmp = pulse * 0.16;
    const alphaScale = 1 - wDisabled * 0.35;
    const cosY = Math.cos(angleY);
    const sinY = Math.sin(angleY);
    const cosX = Math.cos(angleX);
    const sinX = Math.sin(angleX);
    ctx.clearRect(0, 0, size, size);
    const glow = ripple + pulse + flow;
    ctx.globalCompositeOperation = !isStatic && glow > 0.5 ? "lighter" : "source-over";
    for (let i = 0; i < points.length; i += 1) {
      const p = points[i];
      const x1 = p.x * cosY - p.z * sinY;
      const z1 = p.x * sinY + p.z * cosY;
      const y1 = p.y * cosX - z1 * sinX;
      const z2 = p.y * sinX + z1 * cosX;
      const depth = (z2 + 1) / 2;
      const perspective = 0.65 + depth * 0.45;
      let pointRadius = radius;
      if (rippleAmp > 2e-3) {
        pointRadius *= 1 + rippleAmp * Math.sin(p.y * 4.5 - t * 6.5 * spd);
      }
      if (pulseAmp > 2e-3) {
        pointRadius *= 1 - pulseAmp * (0.5 + 0.5 * Math.sin(p.ringFrac * TWO_PI + t * 3.1 * spd));
      }
      let ox = shakeX;
      let oy = shakeY;
      if (idleAmp > 0.01) {
        ox += idleAmp * (Math.sin(t * 0.55 * spd + p.seed * 3.7) + 0.5 * Math.sin(t * 1.3 * spd + p.seed * 1.3));
        oy += idleAmp * (Math.cos(t * 0.62 * spd + p.seed * 2.9) + 0.5 * Math.sin(t * 1.05 * spd + p.seed * 5.1));
      }
      if (jitterAmp > 0.01) {
        ox += jitterAmp * Math.sin(t * 14 * spd + p.seed * 9.3);
        oy += jitterAmp * Math.cos(t * 17 * spd + p.seed * 6.1);
      }
      const sphereX = center + x1 * pointRadius * perspective + ox;
      const sphereY = center + y1 * pointRadius * perspective + oy;
      const sphereAlpha = (0.12 + depth * depth * 0.78) * alphaScale;
      const sphereDot = 0.6 + depth * 1.5;
      let screenX = sphereX;
      let screenY = sphereY;
      let alpha = sphereAlpha;
      let dot = sphereDot;
      if (wConn > 4e-3) {
        const base = i / points.length * TWO_PI;
        const jitter = 0.05 * Math.sin(t * 1.3 + p.seed);
        const ringAngle = base + connectingPhase + jitter;
        const ringR = center * (0.58 + 0.13 * p.ringFrac) * (1 + 0.05 * Math.sin(t + p.seed * 1.7));
        const circleX = center + Math.cos(ringAngle) * ringR;
        const circleY = center + Math.sin(ringAngle) * ringR;
        const ringAlpha = 0.35 + p.tone * 0.5;
        const ringDot = 0.75 + p.tone * 0.9;
        screenX = sphereX + (circleX - sphereX) * wConn;
        screenY = sphereY + (circleY - sphereY) * wConn;
        alpha = sphereAlpha + (ringAlpha - sphereAlpha) * wConn;
        dot = sphereDot + (ringDot - sphereDot) * wConn;
      }
      const cr = from[0] + (to[0] - from[0]) * p.tone;
      const cg = from[1] + (to[1] - from[1]) * p.tone;
      const cb = from[2] + (to[2] - from[2]) * p.tone;
      ctx.beginPath();
      ctx.fillStyle = `rgba(${cr | 0}, ${cg | 0}, ${cb | 0}, ${alpha.toFixed(3)})`;
      ctx.arc(screenX, screenY, dot, 0, TWO_PI);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  };
  let last = 0, raf;
  function frame(now) {
    stateRef.current = getState();
    let dt = last ? Math.min((now - last) / 1e3, 0.05) : 0;
    last = now;
    if (!document.hidden) {
      t += reduce ? 0 : dt;
      render(reduce ? 0 : dt, reduce);
    }
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}
export {
  ERROR_COLOR_FROM,
  ERROR_COLOR_TO,
  ORB_STATES,
  approach,
  createStateMix,
  hexToRgb,
  mountOrb,
  stateEnergy,
  stateMotion
};
