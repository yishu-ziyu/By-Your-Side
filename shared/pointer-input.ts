/**
 * 指针与按键参数形状与纯函数。只放类型与纯逻辑；执行（CDP）留在 extension。
 */

export type MouseButton = "left" | "middle" | "right";

/** 相对元素左上角的 CSS 像素偏移（与 EGO `position: {x,y}` 同语义）。 */
export type ElementPosition = { x: number; y: number };

export type DomRectLike = { x: number; y: number; width: number; height: number };

/** CDP Input.dispatchMouseEvent 的 button 字段。 */
export function cdpMouseButton(button: MouseButton): MouseButton {
  return button;
}

/** 按下某键时 CDP `buttons` 位掩码：left=1, right=2, middle=4。 */
export function pressedButtonsMask(button: MouseButton): number {
  if (button === "left") return 1;

  if (button === "right") return 2;

  if (button === "middle") return 4;
  throw new Error(`unsupported mouse button: ${button}`);
}

/**
 * 元素内点击点：无 position 时取中心；有则相对左上角 CSS 像素。
 * 结果四舍五入到整数 CSS 像素（不乘 DPR）。
 */
export function pointInElementRect(
  rect: DomRectLike,
  position?: ElementPosition | null,
): [number, number] {
  if (!position) {
    return [
      Math.round(rect.x + rect.width / 2),
      Math.round(rect.y + rect.height / 2),
    ];
  }

  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
    throw new Error("position.x / position.y 必须是有限数字（CSS 像素）");
  }

  return [Math.round(rect.x + position.x), Math.round(rect.y + position.y)];
}

/** macOS → Meta，其它 → Control（EGO ControlOrMeta）。 */
export function controlOrMetaKey(platform: string): "Meta" | "Control" {
  return /mac|iphone|ipad|ipod/i.test(platform) ? "Meta" : "Control";
}
