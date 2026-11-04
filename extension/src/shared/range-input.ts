import type { InputRangeReadout } from "../../../shared/page-readout.js";

export function readInputRange(el: Element | null | undefined): InputRangeReadout | null {
  if (el?.tagName !== "INPUT") return null;
  // SAFETY: tagName === "INPUT" means the runtime object is an HTMLInputElement.
  const input = el as HTMLInputElement;

  if (!["time", "date", "datetime-local", "month", "week", "number", "range"].includes(input.type)) return null;
  const readout: InputRangeReadout = { type: input.type, value: input.value };

  for (const key of ["min", "max", "step"] as const) {
    const limit = input.getAttribute(key);

    if (limit) readout[key] = limit;
  }

  if (input.validity.rangeUnderflow) readout.problem = "rangeUnderflow";
  else if (input.validity.rangeOverflow) readout.problem = "rangeOverflow";
  else if (input.validity.stepMismatch) readout.problem = "stepMismatch";

  return readout;
}
