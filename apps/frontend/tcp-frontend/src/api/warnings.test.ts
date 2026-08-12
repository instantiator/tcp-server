import { describe, expect, it } from 'vitest';

import { readWarnings } from './warnings';

/** A response carrying only the header under test. */
const withHeader = (value: string | null): Response =>
  new Response(null, {
    headers: value === null ? {} : { 'X-Tcp-Warnings': value },
  });

describe('readWarnings', () => {
  it('is empty when the header is absent', () => {
    expect(readWarnings(withHeader(null))).toEqual([]);
  });

  it('is empty when the header is blank', () => {
    expect(readWarnings(withHeader(''))).toEqual([]);
  });

  it('reads a list of warnings', () => {
    const header = JSON.stringify(['no planner role', 'no timezone']);

    expect(readWarnings(withHeader(header))).toEqual([
      'no planner role',
      'no timezone',
    ]);
  });

  it('decodes the percent-encoding the server applies', () => {
    const header = JSON.stringify([encodeURIComponent('café — 100% sure')]);

    expect(readWarnings(withHeader(header))).toEqual(['café — 100% sure']);
  });

  // A warning is worth less than the request that carried it. None of these
  // may throw: the server accepted the work either way, and turning that into
  // a failure the user sees would be the worse outcome.
  it('is empty when the header is not JSON', () => {
    expect(readWarnings(withHeader('not json at all'))).toEqual([]);
  });

  it('is empty when the header is JSON but not an array', () => {
    expect(readWarnings(withHeader('{"warning":"one"}'))).toEqual([]);
  });

  it('skips entries that are not strings', () => {
    const header = JSON.stringify(['kept', 42, null, { a: 1 }]);

    expect(readWarnings(withHeader(header))).toEqual(['kept']);
  });

  it('keeps an undecodable entry in its raw form rather than dropping the batch', () => {
    // A lone `%` is not a valid percent-escape, so `decodeURIComponent` throws.
    const header = JSON.stringify(['100%', encodeURIComponent('fine')]);

    expect(readWarnings(withHeader(header))).toEqual(['100%', 'fine']);
  });
});
