/** 记忆等短小侧调用：模型（如 GLM）常把预算花在思考上、没有正文；此时立即放大预算重试一次。 */
const FIRST_BUDGET = 1600;

const RETRY_BUDGET = 8000;

const FAILED = "记忆判断失败，尚未修改记忆";

interface SideReply {
  stopReason: string;
  content: ReadonlyArray<{ type: string; text?: string }>;
}

function textOf(reply: SideReply): string {
  return reply.content.filter(part => part.type === "text").map(part => part.text ?? "").join("\n");
}

export async function completeSideText(
  run: (maxTokens: number) => Promise<SideReply>,
  signal?: AbortSignal,
): Promise<string> {
  const first = await run(FIRST_BUDGET);

  if (first.stopReason === "error" || first.stopReason === "aborted") throw new Error(FAILED);

  if (textOf(first).trim()) return textOf(first);

  if (signal?.aborted) throw new Error(FAILED);

  const second = await run(RETRY_BUDGET);

  if (second.stopReason === "error" || second.stopReason === "aborted") throw new Error(FAILED);

  if (!textOf(second).trim()) throw new Error(FAILED);

  return textOf(second);
}
