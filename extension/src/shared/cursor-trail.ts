const TRAIL_CAP = 40;

export type TrailPoint = {
  tabId: number;
  x: number;
  y: number;
  click: boolean;
};

export type StoredTrail = {
  tabId: number;
  sessionId: string;
  points: TrailPoint[];
};

export function appendTrail(points: TrailPoint[], next: TrailPoint, cap = TRAIL_CAP): TrailPoint[] {
  const out = [...points, next];

  return out.length > cap ? out.slice(out.length - cap) : out;
}

export function documentPoint(viewportX: number, viewportY: number, scrollX: number, scrollY: number): {
  x: number;
  y: number;
} {
  return { x: Math.round(viewportX + scrollX), y: Math.round(viewportY + scrollY) };
}

export function pointsOnTab(trail: StoredTrail, tabId: number): TrailPoint[] {
  return trail.points.filter((p) => p.tabId === tabId);
}

export function isReplayRequest(text: string): boolean {
  const t = text.trim();

  if (!t || t.length > 60) return false;

  if (t.includes("回放")) return true;

  if (/再(看|演)一遍/.test(t) && /刚才|刚刚|上一次|上次/.test(t)) return true;

  if (/^(please\s+)?replay(\b.*)?$/i.test(t)) return true;

  return false;
}
