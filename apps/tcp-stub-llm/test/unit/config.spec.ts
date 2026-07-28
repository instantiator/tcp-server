import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ConfigValidationError,
  maskConfig,
  resolveConfig,
  stripJsonComments,
  validateConfig,
} from '../../src/config.ts';

test('validateConfig accepts a full valid config', () => {
  const config = validateConfig({
    apiFormat: 'openai',
    key: 'secret',
    minDelay: 10,
    maxDelay: 20,
    prompts: [
      {
        match: 'hello',
        mode: 'loop',
        responses: [{ text: 'hi', tools: [{ tool: 'x', data: { a: 1 } }] }],
      },
    ],
    defaults: { responses: [{ text: 'default' }] },
  });
  assert.equal(config.apiFormat, 'openai');
  assert.equal(config.key, 'secret');
  assert.equal(config.minDelay, 10);
  assert.equal(config.maxDelay, 20);
  assert.equal(config.prompts?.[0]?.match, 'hello');
  assert.equal(config.prompts?.[0]?.mode, 'loop');
  assert.deepEqual(config.prompts?.[0]?.responses[0], {
    text: 'hi',
    tools: [{ tool: 'x', data: { a: 1 } }],
  });
  assert.equal(config.defaults?.responses[0]?.text, 'default');
});

test('validateConfig accepts an empty object (everything optional)', () => {
  assert.deepEqual(validateConfig({}), {
    apiFormat: undefined,
    key: undefined,
    minDelay: undefined,
    maxDelay: undefined,
    prompts: undefined,
    defaults: undefined,
  });
});

test('validateConfig rejects a non-object', () => {
  assert.throws(() => validateConfig('nope'), ConfigValidationError);
});

test('validateConfig rejects an unsupported apiFormat', () => {
  assert.throws(
    () => validateConfig({ apiFormat: 'anthropic' }),
    ConfigValidationError,
  );
});

test('validateConfig rejects a negative delay', () => {
  assert.throws(() => validateConfig({ minDelay: -1 }), ConfigValidationError);
});

test('validateConfig rejects an unknown response mode', () => {
  assert.throws(
    () =>
      validateConfig({
        defaults: { responses: [{ text: 'x' }], mode: 'shuffle' },
      }),
    ConfigValidationError,
  );
});

test('validateConfig rejects a prompt rule with an invalid regex', () => {
  assert.throws(
    () =>
      validateConfig({
        prompts: [{ match: '(unclosed', responses: [{ text: 'x' }] }],
      }),
    ConfigValidationError,
  );
});

test('validateConfig rejects a response missing text', () => {
  assert.throws(
    () => validateConfig({ defaults: { responses: [{ tools: [] }] } }),
    ConfigValidationError,
  );
});

test('resolveConfig fills in defaults for every optional field', () => {
  const resolved = resolveConfig({});
  assert.deepEqual(resolved, {
    apiFormat: 'openai',
    key: undefined,
    minDelay: 0,
    maxDelay: 0,
    prompts: [],
    defaults: undefined,
  });
});

test('maskConfig hides a configured key but leaves everything else intact', () => {
  const masked = maskConfig({ key: 'super-secret', minDelay: 5 });
  assert.equal(masked.key, '***');
  assert.equal(masked.minDelay, 5);
});

test('maskConfig leaves an unset key unset', () => {
  assert.equal(maskConfig({}).key, undefined);
});

test('stripJsonComments removes line and block comments outside strings', () => {
  const input = `{
    // a line comment
    "a": 1, /* a block
    comment */ "b": "// not a comment", "c": "/* also not a comment */"
  }`;
  const stripped = stripJsonComments(input);
  const parsed = JSON.parse(stripped) as Record<string, unknown>;
  assert.equal(parsed.a, 1);
  assert.equal(parsed.b, '// not a comment');
  assert.equal(parsed.c, '/* also not a comment */');
});

test('stripJsonComments preserves an escaped quote inside a string', () => {
  const input = String.raw`{"a": "he said \"//not a comment\""}`;
  const parsed = JSON.parse(stripJsonComments(input)) as Record<
    string,
    unknown
  >;
  assert.equal(parsed.a, 'he said "//not a comment"');
});
