/**
 * Providers TCP can be pointed at, and what it takes to connect to each.
 *
 * TCP talks to every provider through its OpenAI-compatible API (ChatOpenAI and
 * OpenAIEmbeddings), so a provider here is a base URL, the fields that fill it,
 * and a sensible model to start with. `id` is what `LLM_PROVIDER`,
 * `EMBEDDING_PROVIDER` and an `LlmConfig`'s `provider` hold.
 *
 * Plain data with no imports, so the setup wizard, CLI, TUI and web client can
 * all read it. Model lists and context sizes are not kept here: they change too
 * often, and models.dev (`modelsDevId`) or the local server's own API has them.
 *
 * Base URLs and starter models were checked against each provider's docs and
 * models.dev on 2026-09-30.
 */

/** A value the user supplies to connect to a provider. */
export type ProviderField = 'apiKey' | 'region' | 'resource';

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
  apiKeyUrl?: string;
  /** This provider's key in https://models.dev/api.json. */
  modelsDevId?: string;
  chat?: { starterModel: string };
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
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    modelsDevId: 'openai',
    chat: { starterModel: 'gpt-5-mini' },
    embeddings: { starterModel: 'text-embedding-3-small', dimension: 1536 },
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    kind: 'remote',
    // https://docs.anthropic.com/en/api/openai-sdk
    baseUrl: 'https://api.anthropic.com/v1',
    fields: ['apiKey'],
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
    modelsDevId: 'anthropic',
    chat: { starterModel: 'claude-haiku-4-5' },
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
    apiKeyUrl: 'https://aistudio.google.com/apikey',
    modelsDevId: 'google',
    chat: { starterModel: 'gemini-flash-latest' },
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
    apiKeyUrl: 'https://portal.azure.com',
    modelsDevId: 'azure',
    chat: { starterModel: 'gpt-5-mini' },
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
    apiKeyUrl: 'https://console.aws.amazon.com/bedrock/home#/api-keys',
    modelsDevId: 'amazon-bedrock',
    chat: { starterModel: 'openai.gpt-oss-20b-1:0' },
    notes:
      "Needs a Bedrock API key, not AWS access keys. Bedrock's OpenAI-compatible API serves only some models, and no embedding models.",
  },
  {
    id: 'mistral',
    name: 'Mistral',
    kind: 'remote',
    baseUrl: 'https://api.mistral.ai/v1',
    fields: ['apiKey'],
    apiKeyUrl: 'https://console.mistral.ai/api-keys',
    modelsDevId: 'mistral',
    chat: { starterModel: 'mistral-small-latest' },
    embeddings: { starterModel: 'mistral-embed', dimension: 1024 },
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'remote',
    baseUrl: 'https://openrouter.ai/api/v1',
    fields: ['apiKey'],
    apiKeyUrl: 'https://openrouter.ai/settings/keys',
    modelsDevId: 'openrouter',
    chat: { starterModel: 'openai/gpt-5-mini' },
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
    chat: { starterModel: 'google/gemma-4-e4b' },
    embeddings: {
      starterModel: 'text-embedding-nomic-embed-text-v1.5',
      dimension: 768,
    },
    localSetup: {
      install: 'https://lmstudio.ai/download',
      steps: [
        'Install LM Studio and open it.',
        'In the Discover tab, download the model below.',
        'In the Developer tab, load the model, then switch the server on (Status: Running).',
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
    chat: { starterModel: 'gemma4:e4b' },
    embeddings: { starterModel: 'nomic-embed-text', dimension: 768 },
    localSetup: {
      install: 'https://ollama.com/download',
      steps: [
        'Install Ollama and start it (it runs in the background).',
        'Download the model below: ollama pull <model>',
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
