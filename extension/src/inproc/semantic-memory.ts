import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { Memory } from "rememori";
import type { MemoryQuery, SemanticMemoryIndex } from "@sideagent/agent/browser-core";
import type { MemoryEntry } from "../../../shared/memory.js";

const MODEL_ID = "Xenova/multilingual-e5-small";
const EMBED_TIMEOUT_MS = 1500;
// 这个小模型给无关中文句子也可能打出 0.85，不能沿用通用向量库常见的 0.70 门槛。
const MIN_SIMILARITY = 0.86;

env.allowLocalModels = false;
env.backends.onnx.wasm!.wasmPaths = chrome.runtime.getURL("ort/");

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("本地语义计算超时")), EMBED_TIMEOUT_MS); });

  try { return await Promise.race([promise, timeout]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

function revisionOf(entries: MemoryEntry[]): string {
  return JSON.stringify(entries.map(entry => [
    entry.id, entry.version, entry.text, entry.status, entry.scope, entry.validity,
    entry.notOnHosts, entry.experience?.topic, entry.createdAt,
  ]).sort(([a], [b]) => String(a).localeCompare(String(b))));
}

function indexText(entry: MemoryEntry): string {
  return entry.experience?.topic ? `${entry.experience.topic}\n${entry.text}` : entry.text;
}

/** 派生索引可以随时清空重建；MemoryStore 仍是唯一事实来源。 */
export class BrowserSemanticMemory implements SemanticMemoryIndex {
  private engine: Promise<Memory> | null = null;
  private extractor: Promise<FeatureExtractionPipeline> | null = null;
  private revision = "";
  private syncing: Promise<void> = Promise.resolve();

  private ready = false;

  private model(): Promise<FeatureExtractionPipeline> {
    this.extractor ??= pipeline("feature-extraction", MODEL_ID, { device: "wasm", dtype: "q8" }).then(model => {
      this.ready = true;
      return model;
    }).catch(error => {
      this.extractor = null;
      this.ready = false;
      throw error;
    });

    return this.extractor;
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

  private open(): Promise<Memory> {
    this.engine ??= Memory.open("idb://sideagent-semantic-v1", {
      extractor: false,
      minSimilarity: MIN_SIMILARITY,
      embedder: { embed: texts => this.embed(texts) },
    }).catch(error => { this.engine = null; throw error; });

    return this.engine;
  }

  sync(entries: MemoryEntry[]): Promise<void> {
    const revision = revisionOf(entries);

    // 首次使用不等待模型下载：先走原来的关键词结果，模型在后台就绪后自然启用。
    if (!this.ready) {
      void this.model().catch(() => undefined);
      return Promise.resolve();
    }

    this.syncing = this.syncing.catch(() => undefined).then(async () => {
      if (revision === this.revision) return;
      const engine = await this.open();
      // 记忆写入远少于查询。内容版本变化时整份重建，避免映射损坏后旧记忆复活。
      await engine.prune({ olderThan: Date.now() + 1 });

      for (const entry of entries) {
        if (entry.status !== "active") continue;
        await engine.remember(`passage: ${indexText(entry)}`, {
          createdAt: entry.createdAt,
          meta: { memoryId: entry.id, version: entry.version },
        });
      }

      this.revision = revision;
    }).catch(error => { this.revision = ""; throw error; });

    return this.syncing;
  }

  async select(query: MemoryQuery): Promise<Array<{ id: string; version: number }>> {
    if (!this.ready) throw new Error("本地语义模型尚未就绪");
    const engine = await this.open();
    const hits = await within(engine.recall(`query: ${query.text}`, { limit: 8, graph: false, minSimilarity: MIN_SIMILARITY }));

    return hits.flatMap(hit => {
      const id = hit.meta.memoryId;
      const version = hit.meta.version;

      return typeof id === "string" && typeof version === "number" && Number.isSafeInteger(version) && version > 0
        ? [{ id, version }]
        : [];
    });
  }
}
