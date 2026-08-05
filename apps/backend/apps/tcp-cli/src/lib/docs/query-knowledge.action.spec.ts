import { apiRequest } from '../core/api';
import { resolveToken } from '../auth/token';
import { queryKnowledgeAction } from './query-knowledge.action';

jest.mock('../core/api');
jest.mock('../auth/token');

const mockedApiRequest = apiRequest as jest.Mock;
const mockedResolveToken = resolveToken as jest.Mock;

const opts = { tcpServer: 'http://localhost:3000' };
const roleId = '11111111-2222-3333-4444-555555555555';

const chunks = [
  {
    id: 'chunk-1',
    documentPath: 'acme/knowledge/analyst/report.md',
    chunkIndex: 0,
    content: 'Some chunk text.',
    similarity: 0.92,
  },
];

describe('queryKnowledgeAction', () => {
  let stdoutSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedResolveToken.mockResolvedValue('token');
    stdoutSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => stdoutSpy.mockRestore());

  it('queries a --role-id and prints the ranked chunks', async () => {
    mockedApiRequest.mockResolvedValueOnce(chunks);

    await queryKnowledgeAction(opts, { roleId, query: 'remote work policy' });

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'GET',
      `/api/role/${roleId}/knowledge/query?q=remote+work+policy`,
    );
    expect(stdoutSpy).toHaveBeenCalledWith(
      JSON.stringify(chunks, null, 2) + '\n',
    );
  });

  it('includes topK/threshold when given', async () => {
    mockedApiRequest.mockResolvedValueOnce(chunks);

    await queryKnowledgeAction(opts, {
      roleId,
      query: 'remote work policy',
      topK: '3',
      threshold: '0.5',
    });

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'GET',
      `/api/role/${roleId}/knowledge/query?q=remote+work+policy&topK=3&threshold=0.5`,
    );
  });

  it('omits topK/threshold when not given', async () => {
    mockedApiRequest.mockResolvedValueOnce([]);

    await queryKnowledgeAction(opts, { roleId, query: 'x' });

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'GET',
      `/api/role/${roleId}/knowledge/query?q=x`,
    );
  });
});
