export interface SkimPoint {
  id: string;
  quote: string;
  note: string;
}

export interface GuideStepSpec {
  id: string;
  selector: string;
  instruction: string;
  advanceOn?: "click" | "change";
}

export type PageTransformAction =
  | { type: "enhance_table"; selector: string; text?: string }
  | { type: "hide_elements"; selector: string }
  | { type: "collapse_elements"; selector: string; label?: string };

export interface SelectorFieldSpec {
  name: string;
  selector: string;
}

export type Phase2ContentMessage =
  | { type: "bys_page_skim"; points: SkimPoint[] }
  | { type: "bys_page_skim_clear" }
  | { type: "bys_interactive_guide_start"; steps: GuideStepSpec[] }
  | { type: "bys_interactive_guide_stop" }
  | { type: "bys_page_transform_apply"; actions: PageTransformAction[] }
  | { type: "bys_page_transform_restore" }
  | { type: "bys_selector_extract"; fields: SelectorFieldSpec[] };
