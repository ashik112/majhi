import { EMBEDDING_DIMS } from "./migrations.ts";

/** Turns texts into unit vectors of 384 numbers. It rejects when it cannot embed (the model did not load). */
export interface Embedder {
  embed(texts: readonly string[]): Promise<Float32Array[]>;
  /** Frees the model. The next `embed` loads it again. */
  unload?(): Promise<void>;
}

/** Cosine similarity of two unit vectors. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

/**
 * A deterministic stand-in for tests: each word of the text adds one to a bucket picked by its
 * hash, and the counts are scaled to length 1. Texts with the same words are close, texts without
 * shared words are not. No model, no download.
 */
export class HashEmbedder implements Embedder {
  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    return texts.map(hashVector);
  }
}

export function hashVector(text: string): Float32Array {
  const v = new Float32Array(EMBEDDING_DIMS);
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    v[fnv1a(word) % EMBEDDING_DIMS] = (v[fnv1a(word) % EMBEDDING_DIMS] ?? 0) + 1;
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / norm;
  return v;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
