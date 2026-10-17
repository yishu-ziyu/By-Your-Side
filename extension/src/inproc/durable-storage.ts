/**
 * 每个会话一个 OPFS 目录，给 pi-durable 的 JSONL 存储用。
 * 扩展重载和浏览器重启都还在同一个扩展来源里，所以重开后能打开同一份。
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { JsonlStorage } from "@earendil-works/pi-durable/storage/jsonl";
import { createOpfsFileSystem } from "../../../experiments/pi-durable/opfs-fs.js";

const fs = createOpfsFileSystem();

export function openDurableStorage(conversationId: string): Promise<JsonlStorage> {
  const safe = conversationId.replace(/[^a-zA-Z0-9_-]/g, "_") || "default";
  return JsonlStorage.open(`/pi-durable/${safe}`, fs, BACKGROUND_CONTEXT);
}
