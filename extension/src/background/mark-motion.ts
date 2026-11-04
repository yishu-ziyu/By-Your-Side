import { DEFAULT_MARK_MOTION, isMarkMotion, MARK_MOTION_KEY, type MarkMotion } from "../shared/mark-motion.js";

export async function getMarkMotion(): Promise<MarkMotion> {
  try {
    const got = await chrome.storage.local.get(MARK_MOTION_KEY);

    const motion = got[MARK_MOTION_KEY];

    return isMarkMotion(motion) ? motion : DEFAULT_MARK_MOTION;
  } catch {
    return DEFAULT_MARK_MOTION;
  }
}
