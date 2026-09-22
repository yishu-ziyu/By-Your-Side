interface EventView { at: number; direction: string; message: Record<string, unknown> }

/** wire 调用只接受同一 wire id 的客户端结果；SDK 同名 tool_end 不能证明哪个并发调用已执行。 */
export function pairCallsWithEnds(events: EventView[], conversationId: string) {
  const own = events.filter((e) => (e.message as { conversationId?: string }).conversationId === conversationId
    || (e.message as { event?: { conversationId?: string } }).event?.conversationId === conversationId);

  const calls = own.filter((e) => e.direction === "server" && e.message.type === "tool_call");
  // tool_result 可以不带 conversationId；其全局唯一 id 由当前会话的 tool_call 绑定。
  const ends = events.filter((e) => e.direction === "client" && e.message.type === "tool_result");
  const usedEnds = new Set<number>();

  return calls.map((e) => {
    const m = e.message as { id?: string; name?: string; params?: { target?: string; value?: string } };
    const name = String(m.name ?? "");

    const endIdx = ends.findIndex((x, i) => {
      if (usedEnds.has(i)) return false;
      const result = x.message as { id?: string; conversationId?: string };

      return !!m.id && result.id === m.id && x.at >= e.at
        && (!result.conversationId || result.conversationId === conversationId);
    });

    let end: { at: number; ok: boolean; executionFact?: string } | undefined;

    if (endIdx >= 0) {
      usedEnds.add(endIdx);
      const x = ends[endIdx]!;
      const result = x.message as { ok?: boolean; executionFact?: string };
      end = { at: x.at, ok: result.ok === true, executionFact: result.executionFact };
    }

    return {
      name, at: e.at, toolCallId: m.id,
      params: { target: m.params?.target, value: m.params?.value },
      ...(end ? { confirmedAt: end.at, ok: end.ok, executionFact: end.executionFact } : {}),
    };
  });
}
