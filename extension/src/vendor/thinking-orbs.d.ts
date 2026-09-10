/**
 * thinking-orbs v0.3.1 的最小类型面。
 * 只需要取帧与预设两件事，其余导出（paint/paintFrame/...）本产品不用，不声明。
 */

/** 一帧里的一条描边。white 是引擎自己的白度，上色时换算成 alpha。 */
export type OrbStroke = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  w: number;
  white: number;
  a?: number;
};

/** 一帧里的一个点。 */
export type OrbDot = {
  x: number;
  y: number;
  r: number;
  white: number;
  a?: number;
};

export type OrbFrame = { lines: OrbStroke[]; dots: OrbDot[] };

export type OrbPreset = {
  mode: string;
  speed: number;
  opts: Record<string, unknown>;
};

/** 几何坐标系固定 20；显示尺寸由调用方缩放。 */
export declare const MODE_FRAMES: Record<
  string,
  (geom: number, t: number, opts: OrbPreset["opts"]) => OrbFrame
>;

export declare const STATE_TO_MODE: Record<string, string>;

export declare function resolvePreset(state: string, geom: number): OrbPreset;
