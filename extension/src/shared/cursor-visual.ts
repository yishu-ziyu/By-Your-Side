/**
 * 虚拟光标视觉常量（tldraw 协作光标：色填 + 白描边 + 深色外晕 + 名牌）。
 * 大小接近系统 / OpenAI 的普通箭头，静止时不压住站点 logo。
 * 箭头取 lucide MousePointer2 的轮廓，三个角和内凹加大圆角，看着不扎手；
 * 圆角会削掉面积，所以轮廓略放大到面积和原箭头相同（不变胖，两翼略短），圆角后的尖仍落在原来的尖上。
 */

export const CURSOR_SVG_SIZE = 20;

export const CURSOR_STROKE_WHITE = 2.2;

export const CURSOR_STROKE_HALO = 3.8;

export const CURSOR_TIP = { x: 4.037, y: 4.688 };

export const CURSOR_ARROW_PATH =
  "M5.881 3.796L17.774 8.628A2 2 0 0 1 17.521 12.417L15.176 13.022A3 3 0 0 0 13.02 15.178L12.417 17.519A2 2 0 0 1 8.627 17.772L3.796 5.881A1.6 1.6 0 0 1 5.881 3.796Z";
