import {
  clearValidators,
  registerValidator,
  validateDocument,
} from './registry';
import { registerDefaultValidators } from './index';

describe('validateDocument', () => {
  afterEach(() => clearValidators());

  it('returns valid:true for a format with no registered matcher', async () => {
    const result = await validateDocument('a.unknown', 'anything');
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it('uses the first matcher registered, in registration order', async () => {
    registerValidator(
      () => true,
      () => ({
        valid: false,
        errors: [{ message: 'first', llmHint: 'first' }],
      }),
    );
    registerValidator(
      () => true,
      () => ({
        valid: false,
        errors: [{ message: 'second', llmHint: 'second' }],
      }),
    );
    const result = await validateDocument('a.txt', 'content');
    expect(result.errors[0].message).toBe('first');
  });

  it('passes the path and resolveRef through to the matched validator', async () => {
    const validate = jest.fn().mockReturnValue({ valid: true, errors: [] });
    registerValidator(() => true, validate);
    const resolveRef = jest.fn();
    await validateDocument('a.txt', 'content', resolveRef);
    expect(validate).toHaveBeenCalledWith('content', {
      path: 'a.txt',
      resolveRef,
    });
  });

  describe('with the default validators registered', () => {
    beforeEach(() => registerDefaultValidators());

    it('dispatches an OKF path (knowledge/{role}/*.md) to the OKF validator, not plain Markdown', async () => {
      const result = await validateDocument(
        'acme/knowledge/analyst/report.md',
        '# no front-matter',
      );
      expect(result.valid).toBe(false);
    });

    it('dispatches a plain .md path elsewhere to the permissive Markdown validator', async () => {
      const result = await validateDocument(
        'acme/tasks/xyz/output/notes.md',
        '# no front-matter needed here',
      );
      expect(result.valid).toBe(true);
    });
  });
});
