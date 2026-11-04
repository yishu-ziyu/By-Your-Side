export interface RouteTarget {
  role: string;
  name: string;
  area: string;
  box: string;
}

export const ROUTE_TEXT_ROLES: ReadonlySet<string> = new Set(["heading", "paragraph", "LabelText", "cell", "gridcell", "rowheader", "columnheader", "image"]);
