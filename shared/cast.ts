/**
 * 并行时侧栏/光标上的人。律师班 + 火线班都可以上场。
 * 按 worker id 稳定散列，纯函数，面板和页面光标同一套。
 * Lead（main）不是这张名册。
 */

export const LEAD_COLOR = "#2f6fed";
export const LEAD_NAME = "SideAgent";

export type CastShape = "blob" | "pebble" | "squircle" | "capsule" | "hex" | "triangle";

export interface KenneyFace {
  body: string;
  face: string;
}

export interface Person {
  key: "kim" | "mike" | "lalo" | "gus" | "kima" | "omar" | "bunk" | "lester";
  name: string;
  crew: "bcs" | "wire";
  color: string;
  shape: CastShape;
  expr: number;
  pool: number[];
  mood: "idle" | "wait" | "play" | "work";
  waitLine: string;
  /** 常驻 Kenney 脸（Omar 紫菱）。 */
  kenney?: KenneyFace;
  /** 等待时换成 Kenney（Mike 黄球皱眉）。 */
  kenneyWait?: KenneyFace;
}

/** 律师班 + 火线班。Grok Bot 形色眼；Mike 等待 / Omar 常驻用 Kenney。 */
export const CAST: readonly Person[] = [
  {
    key: "kim",
    name: "Kim",
    crew: "bcs",
    color: "#000000",
    shape: "squircle",
    expr: 0,
    pool: [0, 8],
    mood: "idle",
    waitLine: "在对齐",
  },
  {
    key: "mike",
    name: "Mike",
    crew: "bcs",
    color: "#9a6737",
    shape: "pebble",
    expr: 4,
    pool: [4, 22],
    mood: "wait",
    waitLine: "还没到",
    kenneyWait: { body: "yellow_body_circle.png", face: "face_b.png" },
  },
  {
    key: "lalo",
    name: "Lalo",
    crew: "bcs",
    color: "#ff6a00",
    shape: "blob",
    expr: 2,
    pool: [2, 11, 17],
    mood: "play",
    waitLine: "我先看看",
  },
  {
    key: "gus",
    name: "Gus",
    crew: "bcs",
    color: "#000000",
    shape: "hex",
    expr: 14,
    pool: [14, 0],
    mood: "idle",
    waitLine: "两边都在",
  },
  {
    key: "kima",
    name: "Kima",
    crew: "wire",
    color: "#ff3347",
    shape: "capsule",
    expr: 7,
    pool: [7, 16, 10],
    mood: "work",
    waitLine: "上手了",
  },
  {
    key: "omar",
    name: "Omar",
    crew: "wire",
    color: "#8656f6",
    shape: "triangle",
    expr: 0,
    pool: [0, 8],
    mood: "idle",
    waitLine: "来了",
    kenney: { body: "purple_body_rhombus.png", face: "face_h.png" },
  },
  {
    key: "bunk",
    name: "Bunk",
    crew: "wire",
    color: "#9a6737",
    shape: "pebble",
    expr: 11,
    pool: [11, 2],
    mood: "idle",
    waitLine: "成了",
  },
  {
    key: "lester",
    name: "Lester",
    crew: "wire",
    color: "#ff9800",
    shape: "squircle",
    expr: 8,
    pool: [8, 16, 5],
    mood: "idle",
    waitLine: "拼上了",
  },
];

function hash(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

export function isLeadId(id: string | undefined | null): boolean {
  return !id || id === "main";
}

/** worker sessionId → 人。Lead 返回 null。 */
export function personFor(id: string): Person | null {
  if (isLeadId(id)) return null;
  const person = CAST[hash(id) % CAST.length];
  return person ?? CAST[0] ?? null;
}

/** 光标/色条颜色。Lead 品牌蓝，人用自己的色。 */
export function displayColor(id: string): string {
  return personFor(id)?.color ?? LEAD_COLOR;
}

/** 光标名牌 / 步骤行名字。 */
export function displayNameFor(id: string): string {
  return personFor(id)?.name ?? LEAD_NAME;
}
