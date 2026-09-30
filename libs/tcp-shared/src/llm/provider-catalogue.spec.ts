import {
  MAX_EMBEDDING_DIMENSION,
  PROVIDER_CATALOGUE,
  fillBaseUrl,
  findProvider,
} from './provider-catalogue';

describe('PROVIDER_CATALOGUE', () => {
  it('has unique ids', () => {
    const ids = PROVIDER_CATALOGUE.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('lists only embedding models TCP can index', () => {
    for (const p of PROVIDER_CATALOGUE) {
      if (p.embeddings) {
        expect(p.embeddings.dimension).toBeLessThanOrEqual(
          MAX_EMBEDDING_DIMENSION,
        );
      }
    }
  });

  it('asks for every field its base URL needs', () => {
    for (const p of PROVIDER_CATALOGUE) {
      for (const [, field] of p.baseUrl.matchAll(/\{(\w+)\}/g)) {
        expect(p.fields).toContain(field);
      }
    }
  });

  it('gives local providers setup steps', () => {
    for (const p of PROVIDER_CATALOGUE.filter((t) => t.kind === 'local')) {
      expect(p.localSetup?.steps.length).toBeGreaterThan(0);
    }
  });

  it('keeps the legacy lm-studio and openai ids', () => {
    expect(findProvider('lm-studio')).toBeDefined();
    expect(findProvider('openai')).toBeDefined();
  });
});

describe('fillBaseUrl', () => {
  it('fills region and resource placeholders', () => {
    expect(
      fillBaseUrl(findProvider('amazon-bedrock')!, { region: 'eu-west-2' }),
    ).toBe('https://bedrock-runtime.eu-west-2.amazonaws.com/openai/v1');
    expect(fillBaseUrl(findProvider('azure')!, { resource: 'acme' })).toBe(
      'https://acme.openai.azure.com/openai/v1',
    );
  });

  it('leaves a URL without placeholders alone', () => {
    expect(fillBaseUrl(findProvider('openai')!, {})).toBe(
      'https://api.openai.com/v1',
    );
  });
});
