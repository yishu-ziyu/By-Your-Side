const TRUNCATION_TAIL = /(?:…|\.{3})$/;

const MIN_PREFIX = 3;

const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();

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

export const RANGE_INPUT_TYPES: ReadonlySet<string> = new Set(["time", "date", "datetime-local", "month", "week", "number", "range"]);

export interface InputRange { type: string; min?: string; max?: string; step?: string }

export type RangeProblem = "rangeUnderflow" | "rangeOverflow" | "stepMismatch";

export interface RangeIssue extends InputRange { problem: RangeProblem; value: string; message: string }

export interface InputRangeReadout extends InputRange { value: string; problem?: RangeProblem }

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

function describeRangeIssue(issue: Omit<RangeIssue, "message">): string {
  const value = JSON.stringify(issue.value);

  const what = issue.problem === "rangeOverflow" ? `${value} is above the page's maximum ${issue.max}`
    : issue.problem === "rangeUnderflow" ? `${value} is below the page's minimum ${issue.min}`
      : `${value} does not match the page's step of ${issue.step}${STEP_UNIT.get(issue.type) ?? ""}${issue.min ? ` counted from ${issue.min}` : ""}`;

  return `Out of range: ${what}. Allowed: ${allowedRange(issue)}. The field now holds this invalid value and the form will reject it; fill an allowed value or tell the user.`;
}

export function rangeIssueOf(readout: InputRangeReadout | null | undefined): RangeIssue | undefined {
  if (!readout?.problem) return undefined;
  const { value, problem, ...range } = readout;
  const issue = { ...range, value, problem };

  return { ...issue, message: describeRangeIssue(issue) };
}
