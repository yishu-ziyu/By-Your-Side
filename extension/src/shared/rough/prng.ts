/**
 * 确定性 32 位伪随机数生成器（PRNG），用于手绘笔触生成。
 * 保证相同种子（seed）必定生成完全相同的手绘路径，避免滚动/重绘时产生闪烁变形。
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 0x100000000);
}
