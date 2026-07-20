import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveConfig, type StubLlmConfig } from '../../src/config.ts';
import { MatcherState, pickResponse } from '../../src/matcher.ts';

function resolved(config: StubLlmConfig) {
  return resolveConfig(config);
}

test('matches the first rule whose regex tests true against the prompt', () => {
  const config = resolved({
    prompts: [
      { match: 'capital of France', responses: [{ text: 'Paris' }] },
      { match: 'capital of', responses: [{ text: 'somewhere' }] },
    ],
  });
  const outcome = pickResponse(
    'what is the capital of France?',
    config,
    new MatcherState(),
  );
  assert.deepEqual(outcome, { ok: true, response: { text: 'Paris' } });
});

test('falls back to defaults when no prompt rule matches', () => {
  const config = resolved({
    prompts: [{ match: 'unrelated', responses: [{ text: 'x' }] }],
    defaults: { responses: [{ text: 'default' }] },
  });
  const outcome = pickResponse(
    'totally different prompt',
    config,
    new MatcherState(),
  );
  assert.deepEqual(outcome, { ok: true, response: { text: 'default' } });
});

test('reports no-match when nothing matches and there are no defaults', () => {
  const config = resolved({
    prompts: [{ match: 'unrelated', responses: [{ text: 'x' }] }],
  });
  const outcome = pickResponse(
    'totally different prompt',
    config,
    new MatcherState(),
  );
  assert.deepEqual(outcome, { ok: false, reason: 'no-match' });
});

test('sequence mode (the default) advances then errors once exhausted', () => {
  const config = resolved({
    defaults: { responses: [{ text: 'a' }, { text: 'b' }] },
  });
  const state = new MatcherState();
  const first = pickResponse('x', config, state);
  assert.deepEqual(first, { ok: true, response: { text: 'a' } });
  const second = pickResponse('x', config, state);
  assert.deepEqual(second, { ok: true, response: { text: 'b' } });
  const third = pickResponse('x', config, state);
  assert.deepEqual(third, { ok: false, reason: 'exhausted' });
});

test('loop mode wraps around instead of exhausting', () => {
  const config = resolved({
    defaults: { mode: 'loop', responses: [{ text: 'a' }, { text: 'b' }] },
  });
  const state = new MatcherState();
  const texts = [0, 1, 2, 3].map(() => {
    const outcome = pickResponse('x', config, state);
    assert.equal(outcome.ok, true);
    return outcome.ok ? outcome.response.text : undefined;
  });
  assert.deepEqual(texts, ['a', 'b', 'a', 'b']);
});

test('random mode always returns one of the configured responses', () => {
  const config = resolved({
    defaults: {
      mode: 'random',
      responses: [{ text: 'a' }, { text: 'b' }, { text: 'c' }],
    },
  });
  const state = new MatcherState();
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const outcome = pickResponse('x', config, state);
    assert.equal(outcome.ok, true);
    if (outcome.ok) seen.add(outcome.response.text);
  }
  for (const text of seen) {
    assert.ok(['a', 'b', 'c'].includes(text));
  }
});

test('per-rule cursors are independent, keyed by rule position', () => {
  const config = resolved({
    prompts: [
      { match: 'first', responses: [{ text: 'f1' }, { text: 'f2' }] },
      { match: 'second', responses: [{ text: 's1' }, { text: 's2' }] },
    ],
  });
  const state = new MatcherState();
  assert.deepEqual(pickResponse('first', config, state), {
    ok: true,
    response: { text: 'f1' },
  });
  assert.deepEqual(pickResponse('second', config, state), {
    ok: true,
    response: { text: 's1' },
  });
  assert.deepEqual(pickResponse('first', config, state), {
    ok: true,
    response: { text: 'f2' },
  });
});

test('reset() clears cursors so sequences restart', () => {
  const config = resolved({
    defaults: { responses: [{ text: 'a' }, { text: 'b' }] },
  });
  const state = new MatcherState();
  pickResponse('x', config, state);
  state.reset();
  assert.deepEqual(pickResponse('x', config, state), {
    ok: true,
    response: { text: 'a' },
  });
});
