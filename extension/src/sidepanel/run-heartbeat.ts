/**
 * 过程行的「在想」标记：一条三圈线圈在 16×16 框里左移一圈、只露出中间一段，看着像一个在转的圈。
 * 形状和节奏照 Agent Elements 的 spiral loader（MIT，原为 Lottie）：快轮 0.5 秒转 4 次，慢轮 1 秒转 2 次，循环。
 * 关键帧在这里按原数据逐帧算好、写成一条 CSS 动画：元素不显示时浏览器自己停，不用脚本循环。
 */
/** 线圈的点：x, y，入手柄 dx, dy，出手柄 dx, dy（取自原动画）。 */
const COIL: ReadonlyArray<readonly [number, number, number, number, number, number]> = [
  [-12, 6, 0, 0, 4.452, 0], [-4.975, -1.012, -0.289, 3.296, 0.23, -2.627], [-8, -6, 2.218, 0, -2.218, 0], [-11.025, -1.012, -0.23, -2.627, 0.289, 3.296],
  [-4, 6, -4.452, 0, 4.452, 0], [3.025, -1.012, -0.289, 3.296, 0.23, -2.627], [0, -6, 2.218, 0, -2.218, 0], [-3.025, -1.012, -0.23, -2.627, 0.289, 3.296],
  [4, 6, -4.452, 0, 4.452, 0], [11.025, -1.012, -0.289, 3.296, 0.23, -2.627], [8, -6, 2.218, 0, -2.218, 0], [4.98, -1.012, -0.232, -2.627, 0.292, 3.296],
  [12, 6, -4.443, 0, 0, 0],
];

function coilPath(): string {
  let d = "";
  let prev: (typeof COIL)[number] | null = null;

  for (const point of COIL) {
    const [x, y, inX, inY] = point;
    d += prev ? ` C${prev[0] + prev[4]} ${prev[1] + prev[5]} ${x + inX} ${y + inY} ${x} ${y}` : `M${x} ${y}`;
    prev = point;
  }

  return d;
}

/** 三次贝塞尔缓动（x1, y1, x2, y2），按 x 二分求 y。 */
function ease(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const at = (a: number, b: number, u: number) => 3 * (1 - u) * (1 - u) * u * a + 3 * (1 - u) * u * u * b + u * u * u;

  return (t) => {
    let lo = 0;
    let hi = 1;
    let u = t;

    for (let n = 0; n < 24; n += 1) {
      u = (lo + hi) / 2;

      if (at(x1, x2, u) < t) lo = u;
      else hi = u;
    }

    return at(y1, y2, u);
  };
}

/** 原动画的两轮：露出段的起点、终点各走自己的缓动，线圈同时左移 8（正好一圈，首尾接得上）。 */
const ROUNDS = [
  { seconds: 0.5, times: 4, start: ease(0.32, 0.154, 0.826, 0.579), end: ease(0.341, 0.488, 0.269, 0.75) },
  { seconds: 1, times: 2, start: ease(0.32, 0.313, 0.826, 0.143), end: ease(0.341, 0.992, 0.269, 0.491) },
];
const SHIFT = ease(0.167, 0.167, 0.833, 0.833);

function coilKeyframes(): string {
  const total = ROUNDS.reduce((sum, r) => sum + r.seconds * r.times, 0);
  const stops: string[] = [];
  let elapsed = 0;

  for (const round of ROUNDS) {
    for (let rep = 0; rep < round.times; rep += 1) {
      const frames = round.seconds * 30;

      for (let f = 0; f <= frames; f += 1) {
        const t = f / frames;
        const start = 23 + 34 * round.start(t);
        const end = 44 + 33 * round.end(t);
        const at = ((elapsed + t * round.seconds) / total) * 100;
        stops.push(`${at.toFixed(3)}%{transform:translate(${(12 - 8 * SHIFT(t)).toFixed(3)}px,8px);stroke-dasharray:${(end - start).toFixed(2)} 200;stroke-dashoffset:${(-start).toFixed(2)}}`);
      }

      elapsed += round.seconds;
    }
  }

  return `@keyframes runCoil{${stops.join("")}}`;
}

let keyframesAdded = false;

export function paintBeatMark(el: HTMLElement): void {
  if (!keyframesAdded) {
    const style = document.createElement("style");
    style.textContent = coilKeyframes();
    document.head.append(style);
    keyframesAdded = true;
  }

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", coilPath());
  path.setAttribute("pathLength", "100");
  svg.append(path);
  el.replaceChildren(svg);
}

/** 回答还没出字时占住回答位置的三行骨架。显隐和淡出全由样式按它后面有没有东西决定；收尾时 main.ts 拿掉。 */
export function answerSkeleton(): HTMLElement {
  const el = document.createElement("div");
  el.className = "answer-skeleton";
  el.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 3; i += 1) el.append(document.createElement("i"));

  return el;
}
