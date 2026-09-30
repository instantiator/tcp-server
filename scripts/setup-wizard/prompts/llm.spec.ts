import inquirer from 'inquirer';
import { validateModel } from '../utils/model-validator';
import { lookupContextWindow } from '../utils/context-lookup';
import { promptLlm } from './llm';

jest.mock('inquirer', () => ({
  __esModule: true,
  default: {
    prompt: jest.fn(),
    Separator: class Separator {
      constructor(public line?: string) {}
    },
  },
}));

jest.mock('../utils/model-validator', () => ({
  __esModule: true,
  validateModel: jest.fn(),
}));

jest.mock('../utils/context-lookup', () => ({
  __esModule: true,
  lookupContextWindow: jest.fn(),
}));

const mockedPrompt = jest.mocked(inquirer.prompt);
const mockedValidateModel = jest.mocked(validateModel);
const mockedLookupContextWindow = jest.mocked(lookupContextWindow);

/**
 * Every question this wizard asks — `promptWithHelp`'s `input`/`number`/
 * `confirm` wrapper, and llm.ts's own direct `select`/`password` calls — is
 * answered by destructuring `{ value }` from `inquirer.prompt`. So a flat
 * list of answers, one per call, drives the whole flow regardless of
 * question type.
 */
function queueAnswers(...values: string[]): void {
  for (const value of values) {
    mockedPrompt.mockResolvedValueOnce({ value });
  }
}

describe('promptLlm', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('declines both models when the user says no to each', async () => {
    queueAnswers('n', 'n');

    const answers = await promptLlm();

    expect(answers).toEqual({
      configureInference: false,
      inferenceModel: undefined,
      configureEmbedding: false,
      embeddingModel: undefined,
    });
  });

  it('probes the original localhost URL but writes the Docker-converted one', async () => {
    mockedValidateModel.mockResolvedValueOnce({ success: true });
    mockedLookupContextWindow.mockResolvedValueOnce(undefined);

    queueAnswers(
      'y', // configure a chat model
      'lm-studio', // provider select
      'test-key', // API key
      'y', // "is LM Studio running?"
      'google/gemma-4-e4b', // model name
      'http://localhost:1234/v1', // base URL
      'y', // use the host.docker.internal conversion
      '200000', // context window fallback
      'n', // decline the embedding model
    );

    const answers = await promptLlm();

    expect(answers.inferenceModel).toEqual({
      provider: 'lm-studio',
      model: 'google/gemma-4-e4b',
      baseUrl: 'http://host.docker.internal:1234/v1',
      apiKey: 'test-key',
      contextWindow: 200000,
    });
    // The connectivity test used the address the wizard itself can reach —
    // host.docker.internal only resolves inside a container.
    expect(mockedValidateModel).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'http://localhost:1234/v1' }),
      'chat',
    );
  });

  it('rejects a probed dimension over the ivfflat limit and restarts the provider choice', async () => {
    mockedValidateModel
      .mockResolvedValueOnce({ success: true, dimension: 3072 })
      .mockResolvedValueOnce({ success: true, dimension: 1536 });

    queueAnswers(
      'n', // decline the chat model
      'y', // configure an embedding model
      'openai', // provider select (1st attempt)
      'sk-test-1', // API key
      'text-embedding-3-small', // model name
      'openai', // provider select (2nd attempt, after the rejection)
      'sk-test-2', // API key
      'text-embedding-3-small', // model name
    );

    const answers = await promptLlm();

    expect(answers.embeddingModel).toEqual({
      provider: 'openai',
      model: 'text-embedding-3-small',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test-2',
      dimension: 1536,
    });
    expect(mockedValidateModel).toHaveBeenCalledTimes(2);
  });
});
