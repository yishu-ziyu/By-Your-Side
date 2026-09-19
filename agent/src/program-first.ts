/** Execution policy only: unknown targets still require observation, not a guessed program. */
export const PROGRAM_FIRST_GUIDANCE = `
[Browser execution policy]
For a known multi-step task, default to one browser_run: actions followed by a read_element expect check. The tools are already bound to the supplied current tab; do not call tabs/switch just to select it. Use targets from the supplied fresh snapshot directly, not a guessed regex parser. After navigation or replaced nodes, observe again inside the program.
Use the regular tool object arguments inside browser.*. For readback the exact shape is expect:{property:"textContent",contains:"required text"}; contains is ONE string, never an array. Use separate readbacks to check several values. Return concise evidence, then deliver the checked result. A returned program is not success by itself. For unclear targets, new information or confirmation, observe or pause instead. Any failed/held call stops the program; inspect the page and ledger before continuing, never replay writes blindly or add unrequested actions.
`;

export function programFirstGuidance(): string {
  // Two real paired trials did not meet the acceptance target. Keep the existing
  // product strategy by default; this extra policy remains explicitly experimental.
  return process.env.SIDEAGENT_PROGRAM_FIRST === "1" ? PROGRAM_FIRST_GUIDANCE : "";
}
