import { LEAD_SESSION_ID } from "../../../../shared/protocol.js";
import { appendTrail, type StoredTrail, type TrailPoint } from "../../shared/cursor-trail.js";

let current: StoredTrail | null = null;
let last: StoredTrail | null = null;

export function recordTrailPoint(sessionId: string, point: TrailPoint): void {
  if (!current || current.sessionId !== sessionId) {
    current = { tabId: point.tabId, sessionId, points: [] };
  }
  current.tabId = point.tabId;
  current.points = appendTrail(current.points, point);
}

export function commitTrail(sessionId: string = LEAD_SESSION_ID): void {
  if (current && current.sessionId === sessionId && current.points.length > 0) {
    last = current;
  }
  if (current?.sessionId === sessionId) current = null;
}

export function trailForReplay(): StoredTrail | null {
  if (last && last.points.length > 0) return last;
  if (current && current.points.length > 0) return current;
  return null;
}

export function resetTrailsForTests(): void {
  current = null;
  last = null;
}
