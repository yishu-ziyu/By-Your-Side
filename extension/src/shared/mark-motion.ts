// 手绘标注动效偏好：grow = 420ms 生长后定格；boil = 1200ms 持续微动。
// 侧栏提示和后台画法都从这里取默认值，未存偏好时两边才说同一件事。
export type MarkMotion = "grow" | "boil";

export const MARK_MOTION_KEY = "sideagent_mark_motion";

export const DEFAULT_MARK_MOTION: MarkMotion = "boil";

/** 存储读出的值先过这里；不认识的值由调用方换成 DEFAULT_MARK_MOTION。 */
export const isMarkMotion = (value: unknown): value is MarkMotion => value === "grow" || value === "boil";
