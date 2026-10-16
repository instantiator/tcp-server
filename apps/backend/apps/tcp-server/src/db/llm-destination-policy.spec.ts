import { embeddingModelChanged } from './llm-destination-policy';

const CONFIG = {
  provider: 'lm-studio',
  model: 'nomic',
  baseUrl: 'http://localhost:1234/v1',
};

describe('embeddingModelChanged', () => {
  it('is false for the same model, whatever the key', () => {
    expect(embeddingModelChanged(CONFIG, { ...CONFIG, apiKey: 'k' })).toBe(
      false,
    );
  });

  it.each([
    ['provider', { provider: 'ollama' }],
    ['model', { model: 'other' }],
    ['baseUrl', { baseUrl: 'http://127.0.0.1:1234/v1' }],
  ])('is true when the %s changes', (_field, patch) => {
    expect(embeddingModelChanged(CONFIG, { ...CONFIG, ...patch })).toBe(true);
  });

  it('is true for a first config, and false when it is cleared', () => {
    expect(embeddingModelChanged(null, CONFIG)).toBe(true);
    expect(embeddingModelChanged(CONFIG, null)).toBe(false);
  });
});
