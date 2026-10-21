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
const E_SPRING = "cubic-bezier(0.34, 1.4, 0.64, 1)";

/** 回答流式：每段淡入。 */
export const D_READ = 400;

/** 回答块入场。 */
const D_RISE = 1100;

/** 回答块入场弹簧（约 16% 过冲；前半段是 Claude 实测，后半段按趋势补齐）。 */
const E_RISE = "linear(0, 0.0706 3.67%, 0.1921 6.42%, 0.3452 9.17%, 0.5097 11.93%, 0.6698 14.68%, 0.8139 17.43%, 0.935 20.18%, 1.0296 22.94%, 1.0971 25.69%, 1.1394 28.44%, 1.1597 31.19%, 1.163 33.03%, 1.1561 35.78%, 1.1387 38.53%, 1.115 41.28%, 1.0884 44.04%, 1.06 47%, 1.03 55%, 1.01 66%, 1 80%, 1)";

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
  --m-read: ${D_READ}ms;
  --m-rise: ${D_RISE / 1000}s;
  --e-rise: ${E_RISE};
`.trim();
