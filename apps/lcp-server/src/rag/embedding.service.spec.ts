import { LlmConfig } from '@lcp/shared';

jest.mock('@langchain/openai', () => ({
  OpenAIEmbeddings: jest.fn().mockImplementation(() => ({
    embedDocuments: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    embedQuery: jest.fn().mockResolvedValue([0.4, 0.5, 0.6]),
  })),
}));

import { OpenAIEmbeddings } from '@langchain/openai';
import { EmbeddingService } from './embedding.service';

const config: LlmConfig = {
  provider: 'lm-studio',
  model: 'nomic-embed-text',
  baseUrl: 'http://localhost:1234/v1',
  apiKey: 'test-key',
};

describe('EmbeddingService', () => {
  let service: EmbeddingService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new EmbeddingService();
  });

  it('builds OpenAIEmbeddings with baseURL when provided', async () => {
    await service.embedQuery(config, 'hello');
    expect(OpenAIEmbeddings).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'nomic-embed-text',
        apiKey: 'test-key',
        configuration: { baseURL: 'http://localhost:1234/v1' },
      }),
    );
  });

  it('omits configuration when no baseUrl', async () => {
    await service.embedQuery(
      { provider: 'openai', model: 'text-embedding-3-small' },
      'hello',
    );
    expect(OpenAIEmbeddings).toHaveBeenCalledWith(
      expect.objectContaining({ configuration: undefined }),
    );
  });

  it('falls back to "lcp" apiKey when none provided', async () => {
    await service.embedQuery(
      { provider: 'lm-studio', model: 'nomic' },
      'hello',
    );
    expect(OpenAIEmbeddings).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'lcp' }),
    );
  });

  it('embedTexts returns an array of vectors', async () => {
    const result = await service.embedTexts(config, ['a', 'b']);
    expect(result).toEqual([[0.1, 0.2, 0.3]]);
  });

  it('embedQuery returns a single vector', async () => {
    const result = await service.embedQuery(config, 'query');
    expect(result).toEqual([0.4, 0.5, 0.6]);
  });
});
