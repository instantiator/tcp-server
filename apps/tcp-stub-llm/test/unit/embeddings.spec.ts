import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMBEDDING_DIM, embed, encodeEmbedding } from '../../src/embeddings.ts';

test('embed is deterministic for identical text', () => {
  assert.deepEqual(embed('hello world'), embed('hello world'));
});

test('embed differs for different text', () => {
  assert.notDeepEqual(embed('hello'), embed('world'));
});

test('embed returns a unit-norm vector of the expected dimension', () => {
  const vector = embed('some knowledge chunk');
  assert.equal(vector.length, EMBEDDING_DIM);
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  assert.ok(Math.abs(norm - 1) < 1e-6, `expected unit norm, got ${norm}`);
});

test('encodeEmbedding returns a plain array by default', () => {
  const vector = embed('x');
  const encoded = encodeEmbedding(vector, undefined);
  assert.deepEqual(encoded, vector);
});

test('encodeEmbedding base64-encodes when asked', () => {
  const vector = embed('x');
  const encoded = encodeEmbedding(vector, 'base64');
  if (typeof encoded !== 'string') throw new Error('expected a base64 string');
  const decoded = new Float32Array(Buffer.from(encoded, 'base64').buffer);
  assert.equal(decoded.length, EMBEDDING_DIM);
});
