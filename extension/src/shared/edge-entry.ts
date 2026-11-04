export const EDGE_ENTRY_KEY = "sideagent_edge_translate_entry";

export function isEdgeEntryOff(stored: unknown): stored is false {
  return stored === false;
}

export const EDGE_Y_KEY = "sideagent_edge_tab_y";

export function edgeY(stored: unknown): number | null {
  return typeof stored === "number" && Number.isFinite(stored) ? stored : null;
}
