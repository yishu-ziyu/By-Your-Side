import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { JsonlStorage } from "@earendil-works/pi-durable/storage/jsonl";
import { createOpfsFileSystem } from "./opfs-fs.js";

const fs = createOpfsFileSystem();

export function openDurableStorage(conversationId: string): Promise<JsonlStorage> {
  const safe = conversationId.replace(/[^a-zA-Z0-9_-]/g, "_") || "default";
  return JsonlStorage.open(`/pi-durable/${safe}`, fs, BACKGROUND_CONTEXT);
}
