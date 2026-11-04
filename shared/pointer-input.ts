export type MouseButton = "left" | "middle" | "right";

export type ElementPosition = { x: number; y: number };

type DomRectLike = { x: number; y: number; width: number; height: number };

export function pressedButtonsMask(button: MouseButton): number {
  if (button === "left") return 1;

  if (button === "right") return 2;

  if (button === "middle") return 4;
  throw new Error(`unsupported mouse button: ${button}`);
}

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

export function controlOrMetaKey(platform: string): "Meta" | "Control" {
  return /mac|iphone|ipad|ipod/i.test(platform) ? "Meta" : "Control";
}
