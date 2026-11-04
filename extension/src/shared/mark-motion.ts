export type MarkMotion = "grow" | "boil";

export const MARK_MOTION_KEY = "sideagent_mark_motion";

export const DEFAULT_MARK_MOTION: MarkMotion = "boil";

export const isMarkMotion = (value: unknown): value is MarkMotion => value === "grow" || value === "boil";
