/**
 * Pluggable embedding provider.
 *
 * Phase 1 ships a deterministic, fully-offline placeholder so the sqlite-vec
 * pipeline is exercised end to end without an API key. It hashes character
 * n-grams into a fixed-dimension, L2-normalized vector: it captures lexical
 * overlap but NOT real semantics. Keyword (FTS5) search is the reliable default
 * for now; swap in a real embedding model (local model or an API) in a later
 * phase by implementing `Embedder` and passing it where the store is built.
 */
import { createHash } from "node:crypto";
import type { AppConfig } from "./config.js";

export interface Embedder {
  readonly dimension: number;
  /** Return an L2-normalized embedding for the given text. */
  embed(text: string): Promise<Float32Array>;
}

/** Lowercased character n-grams (n=3), with simple whitespace normalization. */
function charNgrams(text: string, n = 3): string[] {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return [];
  if (normalized.length <= n) return [normalized];
  const grams: string[] = [];
  for (let i = 0; i + n <= normalized.length; i++) {
    grams.push(normalized.slice(i, i + n));
  }
  return grams;
}

/** Stable hash of a string into [0, mod). */
function hashBucket(token: string, mod: number): number {
  const digest = createHash("md5").update(token).digest();
  // Use the first 4 bytes as an unsigned int.
  const value = digest.readUInt32BE(0);
  return value % mod;
}

export class HashingEmbedder implements Embedder {
  constructor(readonly dimension: number = 256) {
    if (!Number.isInteger(dimension) || dimension <= 0) {
      throw new Error("embedding dimension must be a positive integer");
    }
  }

  async embed(text: string): Promise<Float32Array> {
    const vec = new Float32Array(this.dimension);
    for (const gram of charNgrams(text)) {
      const bucket = hashBucket(gram, this.dimension);
      // Signed contribution keeps the space from collapsing toward all-positive.
      const sign = hashBucket(gram + "#sign", 2) === 0 ? 1 : -1;
      vec[bucket] = (vec[bucket] as number) + sign;
    }
    // L2 normalize so cosine == dot product and distances are comparable.
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < vec.length; i++) vec[i] = (vec[i] as number) / norm;
    }
    return vec;
  }
}

/**
 * Single construction point for the embedding provider.
 *
 * The rest of the app never instantiates an `Embedder` directly and never
 * hard-codes a dimension: it calls this factory and then derives the DB's
 * vector column width from the returned `embedder.dimension`. That keeps the
 * embedder the single source of truth for dimensionality, so swapping in a
 * real model — whose dimension is fixed by the model, not by config — needs
 * no second knob kept in sync.
 *
 * To adopt real semantic search later, branch here (e.g. on a
 * `config.embedding.provider` setting) and return a different `Embedder`
 * implementation — an in-process ONNX model (transformers.js) or an
 * Ollama-backed client. A real model can lazily load its weights on the first
 * `embed()` call, so this factory can stay synchronous. Nothing else changes.
 */
export function createEmbedder(config: AppConfig): Embedder {
  return new HashingEmbedder(config.embedding.dimension);
}
