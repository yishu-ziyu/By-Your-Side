/**
 * Page readout rules shared by snapshot, read_element and fill (docs/page-readouts.md).
 *
 * 1. Truncated text: when the text a page shows ends with an ellipsis ("…" or "..."), and the
 *    element carries a fuller value in title / aria-label / aria-description that starts with the
 *    shown text (minus the ellipsis), the readout also gives that fuller value. Only those page-
 *    provided naming attributes count; data-* attributes and neighbouring text are never guessed.
 *    CSS clipping (text-overflow) needs no rule: the DOM text is already complete.
 * 2. Input ranges: native time/date/datetime-local/month/week/number/range inputs report their
 *    type and min/max/step; a value the browser marks rangeUnderflow / rangeOverflow / stepMismatch
 *    is reported as out of range with the allowed range, never as plain success.
 */

/** Shown text ends with a page-made ellipsis. */
const TRUNCATION_TAIL = /(?:…|\.{3})$/;

/** A shorter shown prefix than this is too weak to prove the fuller value belongs to it. */
const MIN_PREFIX = 3;

const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * The fuller value behind a visibly truncated text, or undefined when the text is not truncated
 * or no candidate extends it. Candidates are checked in the given order (title, aria-label,
 * aria-description; in the accessibility tree: the node's description).
 */
export function fullerText(shown: string, candidates: ReadonlyArray<string | null | undefined>): string | undefined {
  const visible = normalize(shown);

  if (!TRUNCATION_TAIL.test(visible)) return undefined;
  const prefix = visible.replace(TRUNCATION_TAIL, "").trimEnd().toLowerCase();

  if (prefix.length < MIN_PREFIX) return undefined;

  for (const candidate of candidates) {
    const full = normalize(candidate ?? "");

    if (full.length > prefix.length && full.toLowerCase().startsWith(prefix) && full !== visible) return full;
  }

  return undefined;
}

/** Native input types whose value has a range. */
export const RANGE_INPUT_TYPES: ReadonlySet<string> = new Set(["time", "date", "datetime-local", "month", "week", "number", "range"]);

/** A native range input's own constraints, as written on the page. */
export interface InputRange { type: string; min?: string; max?: string; step?: string }

export type RangeProblem = "rangeUnderflow" | "rangeOverflow" | "stepMismatch";

/** A value the browser itself rejects for the field's range or step. */
export interface RangeIssue extends InputRange { problem: RangeProblem; value: string; message: string }

/** Live readout of a range input: constraints, current value and the browser's verdict. */
export interface InputRangeReadout extends InputRange { value: string; problem?: RangeProblem }

/** ` type=time min="11:00" max="21:00" step="900"` for snapshot lines; only attributes the page set. */
export function rangeAttributes(range: InputRange): string {
  let out = ` type=${range.type}`;

  for (const key of ["min", "max", "step"] as const) {
    const value = range[key];

    if (value !== undefined && value !== "") out += ` ${key}=${JSON.stringify(value)}`;
  }

  return out;
}

const STEP_UNIT = new Map([["time", " s"], ["datetime-local", " s"], ["date", " day(s)"], ["week", " week(s)"], ["month", " month(s)"]]);

function allowedRange(range: InputRange): string {
  const parts: string[] = [];

  if (range.min && range.max) parts.push(`${range.min}–${range.max}`);
  else if (range.min) parts.push(`from ${range.min}`);
  else if (range.max) parts.push(`up to ${range.max}`);

  if (range.step && range.step !== "any") parts.push(`step ${range.step}${STEP_UNIT.get(range.type) ?? ""}`);

  return parts.join(", ");
}

/** Model-facing sentence for an out-of-range fill; names the value and the allowed range. */
export function describeRangeIssue(issue: Omit<RangeIssue, "message">): string {
  const value = JSON.stringify(issue.value);

  const what = issue.problem === "rangeOverflow" ? `${value} is above the page's maximum ${issue.max}`
    : issue.problem === "rangeUnderflow" ? `${value} is below the page's minimum ${issue.min}`
      : `${value} does not match the page's step of ${issue.step}${STEP_UNIT.get(issue.type) ?? ""}${issue.min ? ` counted from ${issue.min}` : ""}`;

  return `Out of range: ${what}. Allowed: ${allowedRange(issue)}. The field now holds this invalid value and the form will reject it; fill an allowed value or tell the user.`;
}

/** The structured issue for a readout the browser marked invalid; undefined when the value is fine. */
export function rangeIssueOf(readout: InputRangeReadout | null | undefined): RangeIssue | undefined {
  if (!readout?.problem) return undefined;
  const { value, problem, ...range } = readout;
  const issue = { ...range, value, problem };

  return { ...issue, message: describeRangeIssue(issue) };
}
