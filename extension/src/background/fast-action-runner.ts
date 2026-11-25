import type { FastActionRunResult, LocalFastAction } from "../../../shared/fast-actions.js";

export class LocalFastActionRunner {
  constructor(
    private readonly sendToTab: <T>(tabId: number, message: unknown) => Promise<T>,
    private readonly recordUsage: (actionId: string) => Promise<void> | void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  async run(tabId: number, action: LocalFastAction): Promise<FastActionRunResult> {
    const started = this.now();

    if (action.payload.kind === "page_transform") {
      const res = await this.sendToTab<{ ok?: boolean; affected?: number }>(tabId, {
        type: "bys_page_transform_apply",
        actions: action.payload.actions,
      });
      await this.recordUsage(action.id);
      const affected = res?.affected ?? 0;
      return {
        ok: affected > 0,
        elapsedMs: Math.round(this.now() - started),
        summary: affected > 0 ? `已应用「${action.name}」（影响 ${affected} 处）` : "当前页面未匹配到目标区域",
      };
    }

    const res = await this.sendToTab<{ ok?: boolean; data?: Record<string, string> }>(tabId, {
      type: "bys_selector_extract",
      fields: action.payload.fields,
    });
    await this.recordUsage(action.id);
    const data = res?.data ?? {};
    const filled = Object.values(data).filter(Boolean).length;
    return {
      ok: filled > 0,
      elapsedMs: Math.round(this.now() - started),
      summary: `已抓取 ${filled}/${action.payload.fields.length} 项字段`,
      data,
    };
  }
}
