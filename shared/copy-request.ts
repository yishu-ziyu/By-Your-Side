/**
 * 用户原话是否明确要求照原文搬运（2026-09-25 用户裁决「逐字一致只管复制任务」）。
 * 命中时才启用「先保存原文、填写须逐字一致」这套流程；导出、整理、调研、改错字、填数字都不走它。
 * 说法不在这张词表里时不保护，是已知局限；见 docs/evals/20260925-sitegeist-parity.md。
 */
const COPY_REQUEST = /复制|拷贝|粘贴|照抄|抄到|抄进|抄下|原文|原封不动|一字不差|搬到|搬进|搬过去|贴到|贴进|贴过去|copy|paste/i;

export function isCopyRequest(requirements: readonly string[]): boolean {
  return requirements.some((text) => COPY_REQUEST.test(text));
}
