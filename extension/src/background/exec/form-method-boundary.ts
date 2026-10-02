import type { RequiredFormField } from "../../../../shared/protocol.js";
import { resolveWorkingTab } from "../state.js";

/** Uninspected primitives cannot bypass a confirmed form rule; navigation/read/GET stay available. */
export async function assertCheckedFormPrimitive(params: { tabId?: number; url?: string; formRequirements?: RequiredFormField[] }, sessionId?: string): Promise<void> {
  if (!params.formRequirements?.length) return;
  const url = params.url ?? (await resolveWorkingTab(params.tabId, sessionId)).url;
  const hostname = url ? new URL(url).hostname : "";
  const required = params.formRequirements.filter(rule => !rule.hostname || rule.hostname === hostname);

  if (!required.length) return;
  throw Object.assign(new Error(`该网站已确认字段${required.map(rule => `「${rule.label}」`).join("、")}须有内容。脚本、直接POST或低层输入未执行；请用受检查的fill与click，缺内容先问用户，不要绕过。`), { executionFact: "not_executed" as const });
}
