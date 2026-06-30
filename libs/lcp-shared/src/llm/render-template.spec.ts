import { renderTemplate } from './render-template';

describe('renderTemplate', () => {
  it('substitutes placeholders with provided values', () => {
    expect(renderTemplate('Hello {{name}}.', { name: 'Cat assistant' })).toBe(
      'Hello Cat assistant.',
    );
  });

  it('substitutes multiple placeholders', () => {
    expect(renderTemplate('{{a}} and {{b}}', { a: 'one', b: 'two' })).toBe(
      'one and two',
    );
  });

  it('replaces a missing key with an empty string', () => {
    expect(renderTemplate('Hello {{name}}.', {})).toBe('Hello .');
  });

  it('returns the template unchanged when it has no placeholders', () => {
    expect(renderTemplate('No placeholders here.', { name: 'x' })).toBe(
      'No placeholders here.',
    );
  });
});
