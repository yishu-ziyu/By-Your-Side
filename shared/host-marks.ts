/**
 * 宿主自己画在页面上的标注（圈画）的读数。由扩展在隔离环境从标注层读出，
 * 页面脚本读不到也写不了；核验「圈给用户看」只认这份读数，不认工具回执。
 */
export interface HostDrawnMark {
  /** 标注旁的名牌文字；没有名牌时为空串。 */
  label: string;
  /** 标注当前圈住的元素；元素已离开文档或解析不到时为 null。 */
  element: { tag: string; name: string } | null;
  /** 标注此刻是否显示在页面上。 */
  shown: boolean;
}
