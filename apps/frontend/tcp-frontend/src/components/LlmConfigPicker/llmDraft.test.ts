import type { LlmConfig } from '@tcp/shared/client';
import { describe, expect, it } from 'vitest';
import { t } from '../../strings';
import {
  INHERIT,
  baseUrlOf,
  chooseProvider,
  draftOf,
  keyState,
  patchOf,
  suggestionsFor,
  validate,
} from './llmDraft';
import { findProvider } from '@tcp/shared/client';

const LOCAL: LlmConfig = {
  provider: 'lm-studio',
  model: 'google/gemma-4-e4b',
  baseUrl: 'http://host.docker.internal:1234/v1',
  apiKey: '***',
  contextWindow: 32768,
  timeoutMs: 600000,
};

describe('draftOf and patchOf', () => {
  it('sends nothing for an untouched saved config', () => {
    expect(patchOf(draftOf(LOCAL), LOCAL)).toBeUndefined();
  });

  it('sends nothing for an untouched remote config saved without an address', () => {
    const saved: LlmConfig = { provider: 'openai', model: 'gpt-5-mini' };
    expect(patchOf(draftOf(saved), saved)).toBeUndefined();
  });

  it('sends null to inherit, and nothing when there was no config to clear', () => {
    const inherit = { ...draftOf(LOCAL), choice: INHERIT };
    expect(patchOf(inherit, LOCAL)).toBeNull();
    expect(patchOf(draftOf(null), null)).toBeUndefined();
  });

  it('sends the whole config when one field changes, without the masked key', () => {
    const patch = patchOf({ ...draftOf(LOCAL), model: 'qwen' }, LOCAL);
    expect(patch).toEqual({
      provider: 'lm-studio',
      model: 'qwen',
      baseUrl: 'http://host.docker.internal:1234/v1',
      contextWindow: 32768,
      timeoutMs: 600000,
    });
    expect(JSON.stringify(patch)).not.toContain('***');
  });

  it('sends a typed key, even with nothing else changed', () => {
    expect(patchOf({ ...draftOf(LOCAL), apiKey: 'new' }, LOCAL)).toMatchObject({
      apiKey: 'new',
    });
  });

  it('reads region and resource back out of a filled address', () => {
    const draft = draftOf({
      provider: 'amazon-bedrock',
      model: 'm',
      baseUrl: 'https://bedrock-runtime.eu-west-2.amazonaws.com/openai/v1',
    });
    expect(draft.region).toBe('eu-west-2');
  });
});

describe('chooseProvider', () => {
  it('fills the starter model, address and context window', () => {
    const draft = chooseProvider(draftOf(null), 'lm-studio', 'chat');
    expect(draft).toMatchObject({
      choice: 'lm-studio',
      model: 'google/gemma-4-e4b',
      baseUrl: 'http://localhost:1234/v1',
      contextWindow: '32768',
    });
  });

  it('keeps a model the person typed', () => {
    const typed = { ...draftOf(null), choice: 'lm-studio', model: 'my-model' };
    expect(chooseProvider(typed, 'ollama', 'chat').model).toBe('my-model');
  });

  it('replaces a starter model with the new provider’s', () => {
    const first = chooseProvider(draftOf(null), 'lm-studio', 'chat');
    expect(chooseProvider(first, 'ollama', 'chat').model).toBe('gemma4:e4b');
  });

  it('uses the embedding starter for embeddings', () => {
    expect(chooseProvider(draftOf(null), 'ollama', 'embedding').model).toBe(
      'nomic-embed-text',
    );
  });
});

describe('baseUrlOf', () => {
  it('builds a remote address from its region', () => {
    const draft = {
      ...chooseProvider(draftOf(null), 'amazon-bedrock', 'chat'),
      region: 'us-east-1',
    };
    expect(baseUrlOf(draft)).toBe(
      'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1',
    );
  });
});

describe('keyState', () => {
  it('keeps the saved key when the address stays', () => {
    expect(keyState({ ...draftOf(LOCAL), model: 'x' }, LOCAL)).toBe('saved');
  });

  it.each([
    ['provider', { choice: 'ollama' }],
    ['address', { baseUrl: 'http://gpu-box.lan:1234/v1' }],
  ])('drops it when the %s changes', (_what, change) => {
    expect(keyState({ ...draftOf(LOCAL), ...change }, LOCAL)).toBe('dropped');
  });

  it('says nothing when a key is typed or none is saved', () => {
    expect(keyState({ ...draftOf(LOCAL), apiKey: 'k' }, LOCAL)).toBe('none');
    const keyless = { ...LOCAL, apiKey: undefined };
    expect(keyState(draftOf(keyless), keyless)).toBe('none');
  });
});

describe('suggestionsFor', () => {
  it('puts the catalogue first and adds listed models once', () => {
    const ids = suggestionsFor(findProvider('lm-studio'), 'chat', [
      'google/gemma-4-e4b',
      'mine',
    ]).map((m) => m.id);
    expect(ids[0]).toBe('google/gemma-4-e4b');
    expect(ids.filter((id) => id === 'google/gemma-4-e4b')).toHaveLength(1);
    expect(ids.at(-1)).toBe('mine');
  });

  it('suggests the embedding model with its width', () => {
    expect(suggestionsFor(findProvider('ollama'), 'embedding')).toEqual([
      { id: 'nomic-embed-text', note: t('llm.model.width', { width: 768 }) },
    ]);
  });
});

describe('validate', () => {
  it('finds nothing wrong with inheriting', () => {
    expect(validate(draftOf(null), 'chat')).toEqual({});
  });

  it('needs a model, a region, and an address for local servers', () => {
    const bedrock = {
      ...chooseProvider(draftOf(null), 'amazon-bedrock', 'chat'),
      model: '',
    };
    expect(validate(bedrock, 'chat')).toEqual({
      model: t('llm.error.model'),
      region: t('llm.error.region'),
    });
    const local = {
      ...chooseProvider(draftOf(null), 'lm-studio', 'chat'),
      baseUrl: 'localhost',
    };
    expect(validate(local, 'chat').baseUrl).toBe(t('llm.error.baseUrl'));
  });

  it('refuses a context window or timeout that is not a positive number', () => {
    const draft = {
      ...draftOf(LOCAL),
      contextWindow: '32k',
      timeoutSeconds: '0',
    };
    expect(validate(draft, 'chat')).toEqual({
      contextWindow: t('llm.error.contextWindow'),
      timeoutSeconds: t('llm.error.timeout'),
    });
  });

  it('refuses an embedding model of another width', () => {
    const draft = chooseProvider(draftOf(null), 'openai', 'embedding');
    expect(validate(draft, 'embedding', 768).model).toBe(
      t('llm.error.dimension', { width: 1536, dimension: 768 }),
    );
    expect(validate(draft, 'embedding', 1536)).toEqual({});
  });
});
