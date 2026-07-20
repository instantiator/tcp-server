/** Dimension of the pgvector `embedding` column this suite's RAG pipeline expects. */
export const EMBEDDING_DIM = 1536;

function fnv1aHash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * A deterministic, unit-norm embedding for `text`: identical text always
 * yields the same vector (so a query matches the chunk it came from at
 * cosine ~1.0), different text yields a different one. Not semantically
 * meaningful — just stable and well-formed, which is all a RAG pipeline under
 * test needs.
 */
export function embed(text: string): number[] {
  let s = fnv1aHash(text);
  const values: number[] = [];
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    values.push((s / 4294967295) * 2 - 1);
  }
  const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0)) || 1;
  return values.map((v) => v / norm);
}

/** Encodes an embedding as the client asked (`base64` — the `@langchain/openai` default — or a plain array). */
export function encodeEmbedding(
  vector: number[],
  format: string | undefined,
): string | number[] {
  if (format !== 'base64') return vector;
  return Buffer.from(Float32Array.from(vector).buffer).toString('base64');
}
