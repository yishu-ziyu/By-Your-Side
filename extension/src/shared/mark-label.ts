/**
 * mark 名牌（label pill）相对标注框的方位判定，纯函数可单测。
 * 默认画在框上方；元素贴视口顶部、上方空间放不下 pill 时翻到框下方。
 */

/** pill 高约 20px + 与标注框的间距约 6px + 标注框 pad 6px ≈ 上方所需视口高度。 */
export const MARK_LABEL_SPACE_NEEDED_PX = 34;

/** elementViewportTop = 元素包围盒的视口顶距（rect.y）。上方空间不足时返回 "below"。 */
export function markLabelPlacement(elementViewportTop: number): "above" | "below" {
  return elementViewportTop >= MARK_LABEL_SPACE_NEEDED_PX ? "above" : "below";
}
