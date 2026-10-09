/**
 * 认控件用的描述：无障碍树里的「角色 + 名字 + 所在区域」，不存一次性编号；为什么见 docs/evals/20261007-route-record.md。
 */

/** 认控件用的描述；算法见 extension/src/background/route-target.ts。 */
export interface RouteTarget {
  role: string;
  name: string;
  /** 往上最近的有名字的区域（表单、行、对话框…），形如 `row:青松`；没有为空。 */
  area: string;
  /** 页面上有同名控件时：只装着它一个同名控件的最小容器里，第一段不是它自己名字的文字；不重名为空。 */
  box: string;
}

/** 有名字的文字块（不是控件）：模型按文字点（text=青松 点到卡片标题）时也认得出（YIS-103）。 */
export const ROUTE_TEXT_ROLES: ReadonlySet<string> = new Set(["heading", "paragraph", "LabelText", "cell", "gridcell", "rowheader", "columnheader", "image"]);
