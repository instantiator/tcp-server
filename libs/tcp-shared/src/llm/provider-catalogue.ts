/**
 * Providers TCP can be pointed at, and what it takes to connect to each.
 *
 * TCP talks to every provider through its OpenAI-compatible API (ChatOpenAI and
 * OpenAIEmbeddings), so a provider here is a base URL, the fields that fill it,
 * and a sensible model to start with. `id` is what `LLM_PROVIDER`,
 * `EMBEDDING_PROVIDER` and an `LlmConfig`'s `provider` hold.
 *
 * Plain data, importing only the import-free config defaults, so the setup
 * wizard, CLI, TUI and web client can all read it. Full model lists are not
 * kept here: they change too often, and models.dev (`modelsDevId`) or the
 * local server's own API has them. Each provider lists a few suggestions
 * instead, for the web picker to offer.
 *
 * Base URLs and starter models were checked against each provider's docs and
 * models.dev on 2026-09-30, and the suggestions against models.dev on
 * 2026-10-17.
 */

import { RECOMMENDED_LOCAL_CONTEXT_WINDOW } from '../config/defaults';

/** A value the user supplies to connect to a provider. */
export type ProviderField = 'apiKey' | 'region' | 'resource';

/** A chat model worth suggesting, with what it's good for. */
export interface SuggestedModel {
  id: string;
  /** Tokens. For a local model, the window to load it with. */
  contextWindow?: number;
  note?: string;
}

/** One provider TCP can be pointed at through its OpenAI-compatible API. */
export interface ProviderTemplate {
  /** Written to `LLM_PROVIDER` / `EMBEDDING_PROVIDER`. */
  id: string;
  name: string;
  kind: 'remote' | 'local' | 'custom';
  /** Includes the `/v1` part. May contain `{region}` or `{resource}`. */
  baseUrl: string;
  /** What to ask the user for, in order. */
  fields: readonly ProviderField[];
  /** Where to create an API key. */
  keysPageUrl?: string;
  /** This provider's key in https://models.dev/api.json. */
  modelsDevId?: string;
  /** `models` starts with `starterModel`. */
  chat?: { starterModel: string; models: readonly SuggestedModel[] };
  /** Absent when the provider offers no embedding model TCP can use. */
  embeddings?: { starterModel: string; dimension: number };
  localSetup?: { install: string; steps: readonly string[] };
  /** Anything the user should know before choosing it. */
  notes?: string;
}

/**
 * Embedding vectors are indexed with pgvector's ivfflat, which can't index more
 * than this many dimensions. Wider models (text-embedding-3-large, Gemini's
 * 3072-wide default) would break the migration, so none are listed here.
 */
export const MAX_EMBEDDING_DIMENSION = 2000;

export const PROVIDER_CATALOGUE: readonly ProviderTemplate[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'remote',
    baseUrl: 'https://api.openai.com/v1',
    fields: ['apiKey'],
    keysPageUrl: 'https://platform.openai.com/api-keys',
    modelsDevId: 'openai',
    chat: {
      starterModel: 'gpt-5-mini',
      models: [
        {
          id: 'gpt-5-mini',
          contextWindow: 400000,
          note: 'Cheap and good with tools.',
        },
        {
          id: 'gpt-5.4-mini',
          contextWindow: 400000,
          note: 'Newer, a little dearer.',
        },
        {
          id: 'gpt-5.4-nano',
          contextWindow: 400000,
          note: 'Cheapest. Weaker at multi-step work.',
        },
        {
          id: 'gpt-5.5',
          contextWindow: 1050000,
          note: 'Strongest. Costs much more.',
        },
      ],
    },
    embeddings: { starterModel: 'text-embedding-3-small', dimension: 1536 },
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    kind: 'remote',
    // https://docs.anthropic.com/en/api/openai-sdk
    baseUrl: 'https://api.anthropic.com/v1',
    fields: ['apiKey'],
    keysPageUrl: 'https://console.anthropic.com/settings/keys',
    modelsDevId: 'anthropic',
    chat: {
      starterModel: 'claude-haiku-4-5',
      models: [
        {
          id: 'claude-haiku-4-5',
          contextWindow: 200000,
          note: 'Fast and cheap.',
        },
        {
          id: 'claude-haiku-5-5',
          contextWindow: 1000000,
          note: 'Newer and faster, a little dearer.',
        },
        {
          id: 'claude-sonnet-5-5',
          contextWindow: 1000000,
          note: 'Stronger. Costs more.',
        },
      ],
    },
    notes:
      "Uses Anthropic's OpenAI-compatible API, which Anthropic describes as meant for testing rather than production. Anthropic offers no embedding models.",
  },
  {
    id: 'google',
    name: 'Google Gemini',
    kind: 'remote',
    // https://ai.google.dev/gemini-api/docs/openai
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    fields: ['apiKey'],
    keysPageUrl: 'https://aistudio.google.com/apikey',
    modelsDevId: 'google',
    chat: {
      starterModel: 'gemini-flash-latest',
      models: [
        {
          id: 'gemini-flash-latest',
          contextWindow: 1048576,
          note: 'Always the current Flash model.',
        },
        {
          id: 'gemini-flash-lite-latest',
          contextWindow: 1048576,
          note: 'Cheaper and faster, less capable.',
        },
      ],
    },
    notes:
      "Gemini's embedding models are 3072 dimensions wide by default, more than TCP can index, so choose another provider for embeddings.",
  },
  {
    id: 'azure',
    name: 'Azure OpenAI (Microsoft Foundry)',
    kind: 'remote',
    // https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle
    baseUrl: 'https://{resource}.openai.azure.com/openai/v1',
    fields: ['resource', 'apiKey'],
    keysPageUrl: 'https://portal.azure.com',
    modelsDevId: 'azure',
    chat: {
      starterModel: 'gpt-5-mini',
      models: [
        {
          id: 'gpt-5-mini',
          contextWindow: 400000,
          note: 'Use your deployment name if it differs.',
        },
        { id: 'gpt-5.4-mini', contextWindow: 400000 },
      ],
    },
    embeddings: { starterModel: 'text-embedding-3-small', dimension: 1536 },
    notes:
      'The model name is your deployment name, which may differ from the model it deploys.',
  },
  {
    id: 'amazon-bedrock',
    name: 'Amazon Bedrock',
    kind: 'remote',
    // https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions.html
    baseUrl: 'https://bedrock-runtime.{region}.amazonaws.com/openai/v1',
    fields: ['region', 'apiKey'],
    keysPageUrl: 'https://console.aws.amazon.com/bedrock/home#/api-keys',
    modelsDevId: 'amazon-bedrock',
    chat: {
      starterModel: 'openai.gpt-oss-20b-1:0',
      models: [
        {
          id: 'openai.gpt-oss-20b-1:0',
          contextWindow: 131072,
          note: 'Cheap open-weight model.',
        },
        {
          id: 'openai.gpt-oss-120b-1:0',
          contextWindow: 131072,
          note: 'Larger and stronger.',
        },
      ],
    },
    notes:
      "Needs a Bedrock API key, not AWS access keys. Bedrock's OpenAI-compatible API serves only some models, and no embedding models.",
  },
  {
    id: 'mistral',
    name: 'Mistral',
    kind: 'remote',
    baseUrl: 'https://api.mistral.ai/v1',
    fields: ['apiKey'],
    keysPageUrl: 'https://console.mistral.ai/api-keys',
    modelsDevId: 'mistral',
    chat: {
      starterModel: 'mistral-small-latest',
      models: [
        {
          id: 'mistral-small-latest',
          contextWindow: 262144,
          note: 'Cheap and good with tools.',
        },
        {
          id: 'mistral-medium-latest',
          contextWindow: 262144,
          note: 'Stronger. Costs more.',
        },
      ],
    },
    embeddings: { starterModel: 'mistral-embed', dimension: 1024 },
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'remote',
    baseUrl: 'https://openrouter.ai/api/v1',
    fields: ['apiKey'],
    keysPageUrl: 'https://openrouter.ai/settings/keys',
    modelsDevId: 'openrouter',
    chat: {
      starterModel: 'openai/gpt-5-mini',
      models: [
        { id: 'openai/gpt-5-mini', contextWindow: 400000 },
        { id: 'anthropic/claude-haiku-5.5', contextWindow: 1000000 },
      ],
    },
    notes:
      'One key for models from many providers. OpenRouter offers no embedding models.',
  },
  {
    id: 'lm-studio',
    name: 'LM Studio',
    kind: 'local',
    baseUrl: 'http://localhost:1234/v1',
    fields: ['apiKey'],
    modelsDevId: 'lmstudio',
    chat: {
      starterModel: 'google/gemma-4-e4b',
      models: [
        {
          id: 'google/gemma-4-e4b',
          contextWindow: RECOMMENDED_LOCAL_CONTEXT_WINDOW,
          note: 'Small. Runs on a 16 GB laptop.',
        },
        {
          id: 'openai/gpt-oss-20b',
          contextWindow: RECOMMENDED_LOCAL_CONTEXT_WINDOW,
          note: 'Better at tools. Needs about 16 GB free.',
        },
        {
          id: 'qwen/qwen3-30b-a3b-2507',
          contextWindow: RECOMMENDED_LOCAL_CONTEXT_WINDOW,
          note: 'Stronger. Needs about 24 GB free.',
        },
      ],
    },
    embeddings: {
      starterModel: 'text-embedding-nomic-embed-text-v1.5',
      dimension: 768,
    },
    localSetup: {
      install: 'https://lmstudio.ai/download',
      steps: [
        'Install LM Studio and open it.',
        'In the Discover tab, download the model below.',
        "In the Developer tab, load the model with a Context Length of 32768, then switch the server on (Status: Running). Save 32768 as the model's default load setting too (or run: lms load <model> -c 32768), or a reload falls back to a smaller window.",
        'If you turn on "Require API key" in the server settings, create a key there. Otherwise any value works as the key.',
        'The Developer tab shows the server address — usually http://localhost:1234 (TCP adds /v1).',
      ],
    },
  },
  {
    id: 'ollama',
    name: 'Ollama',
    kind: 'local',
    baseUrl: 'http://localhost:11434/v1',
    fields: [],
    chat: {
      starterModel: 'gemma4:e4b',
      models: [
        {
          id: 'gemma4:e4b',
          contextWindow: RECOMMENDED_LOCAL_CONTEXT_WINDOW,
          note: 'Small. Runs on a 16 GB laptop.',
        },
        {
          id: 'gpt-oss:20b',
          contextWindow: RECOMMENDED_LOCAL_CONTEXT_WINDOW,
          note: 'Better at tools. Needs about 16 GB free.',
        },
        {
          id: 'qwen3:30b',
          contextWindow: RECOMMENDED_LOCAL_CONTEXT_WINDOW,
          note: 'Stronger. Needs about 24 GB free.',
        },
      ],
    },
    embeddings: { starterModel: 'nomic-embed-text', dimension: 768 },
    localSetup: {
      install: 'https://ollama.com/download',
      steps: [
        'Install Ollama and start it (it runs in the background).',
        'Download the model below: ollama pull <model>',
        'Give models a 32768-token context: set OLLAMA_CONTEXT_LENGTH=32768 in the environment Ollama starts with, then restart it.',
        'Ollama needs no API key, and serves on http://localhost:11434 (TCP adds /v1).',
      ],
    },
    notes:
      "TCP's agents stream their replies, and some Ollama versions drop streamed tool calls from Gemma 4. If an agent never uses its tools, try LM Studio.",
  },
  {
    id: 'openai-compatible',
    name: 'Other OpenAI-compatible server',
    kind: 'custom',
    baseUrl: '',
    fields: ['apiKey'],
    notes:
      'Any server with an OpenAI-style /chat/completions API, such as llama.cpp, vLLM or Jan. Enter its base URL, including /v1.',
  },
];

/** The template with this id, or `undefined`. */
export function findProvider(id: string): ProviderTemplate | undefined {
  return PROVIDER_CATALOGUE.find((p) => p.id === id);
}

/** The template's base URL with `{region}` / `{resource}` filled in. */
export function fillBaseUrl(
  template: ProviderTemplate,
  values: { region?: string; resource?: string },
): string {
  return template.baseUrl.replace(
    /\{(region|resource)\}/g,
    (_, key: 'region' | 'resource') => values[key] ?? `{${key}}`,
  );
}
