/**
 * 恢复/插话轮次的证据判据：T05 接续验收、P0 receipt-loss 验收与定点反例共用。
 * 轮次边界由调用方在点击/发送前记下的时间点划定；这里只做纯判定，不碰事件流。
 */
export interface RoundDelivery {
  kind?: string;
  runId?: string | null;
  composedAt?: number;
}
export interface RoundReceipt {
  requestId?: string;
  status?: string;
}

/**
 * 本轮正式交付：同一 run，且组合时间不早于轮次开始。
 * 执行停止或宿主重启只说明轮次结束；同 run 的旧 finding（composedAt 在轮次之前）不能算本轮交付。
 */
export function roundFinding<T extends RoundDelivery>(deliveries: readonly T[], runId: string | null | undefined, startedAtMs: number): T | undefined {
  if (typeof runId !== 'string' || !runId.trim() || !Number.isFinite(startedAtMs)) return undefined;
  const own = runId;
  for (let index = deliveries.length - 1; index >= 0; index -= 1) {
    const delivery = deliveries[index]!;
    if (delivery.kind !== 'finding' || (delivery.runId ?? null) !== own) continue;
    if (typeof delivery.composedAt !== 'number' || !Number.isFinite(delivery.composedAt) || delivery.composedAt < startedAtMs) continue;
    return delivery;
  }
  return undefined;
}

/**
 * 与请求编号配对且被接收/应用的回执。
 * 只有 requestId 命中且 status 为 accepted/applied 才算送达；仅 action 或会话相同都会误匹配。
 * 没有可配对的请求编号时返回 undefined——无法证明送达，不标通过。
 */
export function pairedAcceptedReceipt<T extends RoundReceipt>(receipts: readonly T[], requestIds: Iterable<string>): T | undefined {
  const ids = new Set(requestIds);
  if (ids.size === 0) return undefined;
  return receipts.find((receipt) =>
    typeof receipt.requestId === 'string' && ids.has(receipt.requestId)
    && (receipt.status === 'accepted' || receipt.status === 'applied'));
}
