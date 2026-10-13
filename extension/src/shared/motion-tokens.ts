/**
 * 动效 token：5 个时长 + 4 条曲线。CSS 源在 sidepanel/motion-tokens.css，两边数字必须一致。
 * 语义见设计稿 A10：同类变化同一个手感；退出比进入短；高频操作不加长动效。
 */
export const D_TAP = 90;
export const D_MICRO = 140;
export const D_STATE = 200;
export const D_LAYOUT = 280;
export const D_EMPH = 420;

export const E_ENTER = "cubic-bezier(0.23, 1, 0.32, 1)";
export const E_EXIT = "cubic-bezier(0.4, 0, 1, 1)";
export const E_MOVE = "cubic-bezier(0.16, 1, 0.3, 1)";
export const E_SPRING = "cubic-bezier(0.34, 1.4, 0.64, 1)";

export const MOTION_CSS_VARS = `
  --d-tap: ${D_TAP}ms;
  --d-micro: ${D_MICRO}ms;
  --d-state: ${D_STATE}ms;
  --d-layout: ${D_LAYOUT}ms;
  --d-emph: ${D_EMPH}ms;
  --e-enter: ${E_ENTER};
  --e-exit: ${E_EXIT};
  --e-move: ${E_MOVE};
  --e-spring: ${E_SPRING};
`.trim();
