/** 手绘标注动效偏好：侧栏右击直接写 storage，这里每次现读，不能缓存。模块顶层不触碰 chrome API。 */
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
