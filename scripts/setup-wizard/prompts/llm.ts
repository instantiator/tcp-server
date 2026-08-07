import { promptWithHelp } from '../utils/prompt-with-help';
import type { LlmProviderConfig } from '../types';
import { validateModel } from '../utils/model-validator';

export interface LlmAnswers {
  configureEmbedding: boolean;
  embeddingModel?: LlmProviderConfig;
  configureInference: boolean;
  inferenceModel?: LlmProviderConfig;
}

/** Prompts for embedding and inference model configuration. */
export async function promptLlm(): Promise<LlmAnswers> {
  const answers = await promptWithHelp<LlmAnswers>([
    {
      type: 'confirm',
      name: 'configureEmbedding',
      message: 'Configure an embedding model at application level?',
      default: false,
      help: `The embedding model converts text into vectors for semantic search (RAG).
Set this at application level to use the same model for all companies/roles.
You can also set it per-role or per-company later.`,
    },
  ]);

  if (answers.configureEmbedding) {
    answers.embeddingModel = await promptEmbeddingModel();
  }

  const inferenceAnswers = await promptWithHelp<
    Pick<LlmAnswers, 'configureInference'>
  >([
    {
      type: 'confirm',
      name: 'configureInference',
      message: 'Configure an inference (chat) model at application level?',
      default: false,
      help: `The inference model powers chat completions and agent reasoning.
Set this at application level to use the same model for all companies/roles.
You can also set it per-role or per-company later.`,
    },
  ]);

  answers.configureInference = inferenceAnswers.configureInference;

  if (answers.configureInference) {
    answers.inferenceModel = await promptInferenceModel();
  }

  return answers;
}

async function promptEmbeddingModel(): Promise<LlmProviderConfig> {
  const base = await promptWithHelp<Omit<LlmProviderConfig, 'dimension'>>([
    {
      type: 'input',
      name: 'provider',
      message: 'Embedding provider name:',
      default: 'openai',
      help: `The provider is the company/platform hosting the model.
Examples: openai, ollama, mistral, voyage`,
    },
    {
      type: 'input',
      name: 'model',
      message: 'Embedding model name:',
      default: 'text-embedding-3-small',
      help: `The specific model to use for generating embeddings.
Examples: text-embedding-3-small, nomic-embed-text, voyage-3`,
    },
    {
      type: 'input',
      name: 'baseUrl',
      message: 'Embedding base URL:',
      default: 'https://api.openai.com/v1',
      help: `The API endpoint for the embedding provider.
  - OpenAI: https://api.openai.com/v1
  - Ollama (local): http://localhost:11434/v1
  - Mistral: https://api.mistral.ai/v1`,
    },
    {
      type: 'input',
      name: 'apiKey',
      message: 'Embedding API key:',
      help: `The API key for authenticating with the provider.
  - For local providers (Ollama), any value works
  - For cloud providers, use the key from their dashboard`,
      validate: (input: string) =>
        input.trim().length > 0 || 'API key cannot be empty',
    },
  ]);

  const skipValidation = await promptWithHelp<{ skip: boolean }>([
    {
      type: 'confirm',
      name: 'skip',
      message: 'Skip connectivity validation?',
      default: false,
      help: `Validation sends a test request to verify the endpoint is reachable and the model exists.
Skip if you don't have network access or are using a local provider that isn't running yet.`,
    },
  ]);

  if (!skipValidation.skip) {
    const result = await validateModel(base, 'embedding');
    if (result.success && result.dimension) {
      console.log(`  Embedding dimension: ${result.dimension}`);
      return { ...base, dimension: result.dimension };
    }
    if (!result.success) {
      console.log(`  Validation failed: ${result.error}`);
    }
  }

  const dimAnswers = await promptWithHelp<{ dimension: number }>([
    {
      type: 'number',
      name: 'dimension',
      message: 'Embedding vector dimension:',
      default: 768,
      validate: (input: number) =>
        (Number.isInteger(input) && input > 0) || 'Must be a positive integer',
      help: `The vector width of the embedding output.
  - Must match the dimension used in your existing database
  - Common values: 384, 768, 1024, 1536, 3072
  - Check your model's documentation for the correct value`,
    },
  ]);

  return { ...base, dimension: dimAnswers.dimension };
}

async function promptInferenceModel(): Promise<LlmProviderConfig> {
  const base = await promptWithHelp<Omit<LlmProviderConfig, 'contextWindow'>>([
    {
      type: 'input',
      name: 'provider',
      message: 'Inference provider name:',
      default: 'openai',
      help: `The provider is the company/platform hosting the model.
Examples: openai, anthropic, ollama, mistral`,
    },
    {
      type: 'input',
      name: 'model',
      message: 'Inference model name:',
      default: 'gpt-4o-mini',
      help: `The specific model to use for chat completions.
Examples: gpt-4o-mini, claude-3-haiku, llama3.1`,
    },
    {
      type: 'input',
      name: 'baseUrl',
      message: 'Inference base URL:',
      default: 'https://api.openai.com/v1',
      help: `The API endpoint for the inference provider.
  - OpenAI: https://api.openai.com/v1
  - Anthropic: https://api.anthropic.com/v1
  - Ollama (local): http://localhost:11434/v1`,
    },
    {
      type: 'input',
      name: 'apiKey',
      message: 'Inference API key:',
      help: `The API key for authenticating with the provider.
  - For local providers (Ollama), any value works
  - For cloud providers, use the key from their dashboard`,
      validate: (input: string) =>
        input.trim().length > 0 || 'API key cannot be empty',
    },
  ]);

  const skipValidation = await promptWithHelp<{ skip: boolean }>([
    {
      type: 'confirm',
      name: 'skip',
      message: 'Skip connectivity validation?',
      default: false,
      help: `Validation sends a test chat completion to verify the endpoint works.
Skip if you don't have network access or are using a local provider that isn't running yet.`,
    },
  ]);

  if (!skipValidation.skip) {
    const result = await validateModel(base, 'chat');
    if (result.success) {
      console.log('  Model validated successfully');
    } else {
      console.log(`  Validation failed: ${result.error}`);
    }
  }

  const cwAnswers = await promptWithHelp<{ contextWindow: number }>([
    {
      type: 'number',
      name: 'contextWindow',
      message: 'Context window size (tokens):',
      default: 128000,
      validate: (input: number) =>
        (Number.isInteger(input) && input > 0) || 'Must be a positive integer',
      help: `The maximum number of tokens the model can process in a single request.
  - Check your model's documentation for the limit
  - Common values: 4096, 8192, 32000, 128000
  - Larger windows allow more context but cost more`,
    },
  ]);

  return { ...base, contextWindow: cwAnswers.contextWindow };
}
