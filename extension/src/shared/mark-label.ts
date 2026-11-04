const MARK_LABEL_SPACE_NEEDED_PX = 34;

export function markLabelPlacement(elementViewportTop: number): "above" | "below" {
  return elementViewportTop >= MARK_LABEL_SPACE_NEEDED_PX ? "above" : "below";
}
