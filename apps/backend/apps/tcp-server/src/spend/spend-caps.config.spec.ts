import { spendCapsSchema, SpendCaps } from './spend-caps.config';

describe('spendCapsSchema', () => {
  it('defaults to no caps when unset', () => {
    expect(spendCapsSchema.validate(undefined)).toEqual({ value: {} });
  });

  // docker-compose passes an unset variable as '' (`${VAR:-}`).
  it('treats an empty value as unset', () => {
    expect(spendCapsSchema.validate('')).toEqual({ value: {} });
  });

  it('parses a valid example and applies defaults', () => {
    const raw = JSON.stringify({
      anthropic: {
        limits: [
          { tokens: 2000000, per: '5h' },
          { tokens: 20000000, per: 'week' },
        ],
        notifyAt: [50, 80],
        action: 'pause',
      },
    });
    const result = spendCapsSchema.validate(raw);
    expect(result.error).toBeUndefined();
    const value = result.value as SpendCaps;
    expect(value.anthropic).toEqual({
      limits: [
        { tokens: 2000000, per: '5h' },
        { tokens: 20000000, per: 'week' },
      ],
      notifyAt: [50, 80],
      action: 'pause',
    });
  });

  it('fills in notifyAt and action defaults when omitted', () => {
    const raw = JSON.stringify({
      'lm-studio': { limits: [{ tokens: 1000, per: 'day' }] },
    });
    const result = spendCapsSchema.validate(raw);
    expect(result.error).toBeUndefined();
    const value = result.value as SpendCaps;
    expect(value['lm-studio'].notifyAt).toEqual([80]);
    expect(value['lm-studio'].action).toBe('pause');
  });

  it('rejects invalid JSON', () => {
    const result = spendCapsSchema.validate('{not json');
    expect(result.error?.message).toContain('SPEND_CAPS is not valid JSON');
  });

  it('rejects an unknown provider id', () => {
    const raw = JSON.stringify({
      'not-a-real-provider': { limits: [{ tokens: 1000, per: 'day' }] },
    });
    const result = spendCapsSchema.validate(raw);
    expect(result.error).toBeDefined();
  });

  it('rejects a notifyAt of 100 or more', () => {
    const raw = JSON.stringify({
      openai: { limits: [{ tokens: 1000, per: 'day' }], notifyAt: [100] },
    });
    const result = spendCapsSchema.validate(raw);
    expect(result.error).toBeDefined();
  });

  it('rejects tokens: 0', () => {
    const raw = JSON.stringify({
      openai: { limits: [{ tokens: 0, per: 'day' }] },
    });
    const result = spendCapsSchema.validate(raw);
    expect(result.error).toBeDefined();
  });

  it.each(['0h', '5d', 'h'])('rejects a malformed per value %s', (per) => {
    const raw = JSON.stringify({
      openai: { limits: [{ tokens: 1000, per }] },
    });
    const result = spendCapsSchema.validate(raw);
    expect(result.error).toBeDefined();
  });

  it('rejects an unknown key inside a cap', () => {
    const raw = JSON.stringify({
      openai: {
        limits: [{ tokens: 1000, per: 'day' }],
        unexpected: true,
      },
    });
    const result = spendCapsSchema.validate(raw);
    expect(result.error).toBeDefined();
  });
});
