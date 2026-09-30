import { mkdir } from "node:fs/promises";
import type { Embedder } from "./embedder.ts";
import { EMBEDDING_DIMS } from "./migrations.ts";

export const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
/** The model is unloaded after this long without a request (SPEC 5.17). */
export const UNLOAD_AFTER_MS = 5 * 60_000;

/** The slice of a feature-extraction pipeline this file uses. */
interface Extractor {
  (
    texts: string[],
    options: { pooling: "mean"; normalize: true },
  ): Promise<{ data: Float32Array | number[] }>;
  dispose?: () => Promise<void>;
}

export interface TransformersOptions {
  /** `~/.majhi/cache/models`. The model is downloaded here once, then read offline. */
  cacheDir: string;
  idleMs?: number;
  /** Replaces the library import, for tests. */
  load?: (cacheDir: string) => Promise<Extractor>;
}

/**
 * `Xenova/all-MiniLM-L6-v2`, quantized (8-bit), through transformers.js on onnxruntime-node. The
 * library and the model load on first use and go again after `idleMs` without a request. A load
 * that fails rejects that call; the next call tries again.
 */
export class TransformersEmbedder implements Embedder {
  private extractor: Promise<Extractor> | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: TransformersOptions) {}

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    this.extractor ??= (this.options.load ?? loadPipeline)(this.options.cacheDir);
    let extractor: Extractor;
    try {
      extractor = await this.extractor;
    } catch (err) {
      this.extractor = undefined;
      throw err;
    }
    this.touch();
    const out = await extractor([...texts], { pooling: "mean", normalize: true });
    const flat = Float32Array.from(out.data);
    if (flat.length !== texts.length * EMBEDDING_DIMS) {
      throw new Error(`The embedding model returned ${flat.length} numbers for ${texts.length} texts.`);
    }
    return texts.map((_, i) => flat.slice(i * EMBEDDING_DIMS, (i + 1) * EMBEDDING_DIMS));
  }

  async unload(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const pending = this.extractor;
    this.extractor = undefined;
    if (pending === undefined) return;
    const extractor = await pending.catch(() => undefined);
    await extractor?.dispose?.().catch(() => undefined);
  }

  private touch(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.unload(), this.options.idleMs ?? UNLOAD_AFTER_MS);
    this.timer.unref();
  }
}

async function loadPipeline(cacheDir: string): Promise<Extractor> {
  await mkdir(cacheDir, { recursive: true });
  const { env, pipeline } = await import("@huggingface/transformers");
  env.cacheDir = cacheDir;
  const extractor = await pipeline("feature-extraction", MODEL_ID, { dtype: "q8" });
  return extractor as unknown as Extractor;
}
