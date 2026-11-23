import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { IndexedDBStorage, Memory, type StorageAdapter } from "rememori";
import { BackgroundSemanticIndex, type MemoryQuery, type SemanticDocument, type SemanticMemoryHit, type SemanticMemoryIndex } from "@sideagent/agent/browser-core";
import type { MemoryEntry } from "../../../shared/memory.js";
import type { TaskHistoryEntry } from "../../../shared/task-history.js";

const MODEL_ID = "Xenova/multilingual-e5-small";
const EMBED_TIMEOUT_MS = 1500;
const MIN_SIMILARITY = 0.86;

env.allowLocalModels = false;
env.backends.onnx.wasm!.wasmPaths = chrome.runtime.getURL("ort/");

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("本地语义计算超时")), EMBED_TIMEOUT_MS); });
  try { return await Promise.race([promise, timeout]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

export class BrowserSemanticMemory implements SemanticMemoryIndex {
  private engine: Promise<Memory> | null = null;
  private extractor: { phase: "cold" } | { phase: "loading" | "ready"; model: Promise<FeatureExtractionPipeline> } = { phase: "cold" };
  private readonly background: BackgroundSemanticIndex;
  private canWrite: () => boolean;

  constructor(private readonly readOnly: () => boolean = () => false) {
    this.canWrite = () => !this.readOnly();
    this.background = new BackgroundSemanticIndex({
      warmup: async () => { await this.model(); if (!this.readOnly()) await this.open(); },
      replace: (documents, canWrite) => this.replace(documents, canWrite),
      recall: query => this.recall(query),
    }, readOnly);
  }

  private model(): Promise<FeatureExtractionPipeline> {
    if (this.extractor.phase !== "cold") return this.extractor.model;
    const loading = pipeline("feature-extraction", MODEL_ID, { device: "wasm", dtype: "q8" }).then(model => {
      this.extractor = { phase: "ready", model: loading };
      return model;
    }).catch(error => { this.extractor = { phase: "cold" }; throw error; });
    this.extractor = { phase: "loading", model: loading };
    return loading;
  }

  private async embed(texts: string[]): Promise<Float32Array[]> {
    const output = await within(this.model().then(extractor => extractor(texts, { pooling: "mean", normalize: true })));
    const rows: unknown = output.tolist();
    if (!Array.isArray(rows) || rows.length !== texts.length) throw new Error("本地语义结果数量无效");
    return rows.map(row => {
      if (!Array.isArray(row) || !row.every(value => typeof value === "number" && Number.isFinite(value))) throw new Error("本地语义结果格式无效");
      return new Float32Array(row);
    });
  }

  private assertWritable(): void {
    if (this.readOnly() || !this.canWrite()) throw new Error("语义索引当前只读或已更新");
  }

  private open(): Promise<Memory> {
    if (!this.engine) {
      const underlying = new IndexedDBStorage("sideagent-semantic-v2");
      const storage: StorageAdapter = {
        load: () => underlying.load(), close: () => underlying.close(),
        append: async record => { this.assertWritable(); await underlying.append(record); },
        tombstone: async id => { this.assertWritable(); await underlying.tombstone(id); },
        compact: async records => { this.assertWritable(); await underlying.compact(records); },
      };
      this.engine = Memory.open("idb://sideagent-semantic-v2", {
        storage, extractor: false, minSimilarity: MIN_SIMILARITY,
        embedder: { embed: texts => this.embed(texts) },
      }).catch(error => { this.engine = null; throw error; });
    }
    return this.engine;
  }

  private async replace(documents: SemanticDocument[], canWrite: () => boolean): Promise<void> {
    this.canWrite = canWrite;
    const engine = await this.open();
    this.assertWritable();
    await engine.prune({ olderThan: Date.now() + 1 });
    for (const document of documents) {
      this.assertWritable();
      await engine.remember(`passage: ${document.text}`, {
        createdAt: document.createdAt,
        meta: { kind: document.kind, memoryId: document.id, version: document.version, fingerprint: document.fingerprint },
      });
    }
  }

  sync(entries: MemoryEntry[], tasks?: TaskHistoryEntry[]): Promise<void> {
    return this.background.sync(entries, tasks);
  }

  select(query: MemoryQuery): Promise<SemanticMemoryHit[]> {
    return this.background.select(query);
  }

  private async recall(query: MemoryQuery): Promise<SemanticMemoryHit[]> {
    if (this.extractor.phase !== "ready" || (this.readOnly() && !this.engine)) return [];
    const hits = await within((await this.open()).recall(`query: ${query.text}`, { limit: 16, graph: false, minSimilarity: MIN_SIMILARITY }));
    return hits.flatMap((hit): SemanticMemoryHit[] => {
      const { kind, memoryId: id, version, fingerprint } = hit.meta;
      if (typeof id !== "string" || typeof fingerprint !== "string" || !Number.isFinite(hit.similarity) || hit.similarity < MIN_SIMILARITY) return [];
      if (kind === "task") return [{ kind, id, fingerprint, score: hit.similarity }];
      return kind === "memory" && typeof version === "number" && Number.isSafeInteger(version) && version > 0
        ? [{ kind, id, version, fingerprint, score: hit.similarity }]
        : [];
    });
  }
}
