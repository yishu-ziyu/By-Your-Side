// pi-durable 自带的存储一致性套件，跑在 JSONL 核心 + IndexedDB 文件外观上（fake-indexeddb）。用法：npx vitest run
import "fake-indexeddb/auto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { JsonlStorage } from "@earendil-works/pi-durable/storage/jsonl";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { describe, expect, it } from "vitest";
import { openIdbFileSystem } from "./idb-fs.ts";

let n = 0;
registerStorageConformance({ describe, expect, it }, "JSONL over IndexedDB", async (use) => {
  const fs = await openIdbFileSystem(`conformance-${n++}`);
  const storage = await JsonlStorage.open("/session", fs, BACKGROUND_CONTEXT);
  try {
    await use(storage);
  } finally {
    await storage.close(BACKGROUND_CONTEXT);
    fs.db.close();
  }
});
