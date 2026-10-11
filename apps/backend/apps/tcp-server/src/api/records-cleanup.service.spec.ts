import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { RecordsCleanupService } from './records-cleanup.service';

describe('RecordsCleanupService', () => {
  const companyId = randomUUID();
  let fetchMock: jest.SpyInstance<Promise<Response>, Parameters<typeof fetch>>;

  const build = (config: Record<string, string>) =>
    new RecordsCleanupService(new ConfigService(config));

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => fetchMock.mockRestore());

  it('calls the records server at the origin of its URL, with the internal key', async () => {
    fetchMock.mockResolvedValue(Response.json({ tables: 2 }));
    await build({
      MCP_RECORDS_URL: 'http://tcp-mcp-records:3015/mcp',
      INTERNAL_API_KEY: 'k',
    }).companyDeleted(companyId);
    expect(fetchMock).toHaveBeenCalledWith(
      `http://tcp-mcp-records:3015/internal/companies/${companyId}/records`,
      expect.objectContaining({
        method: 'DELETE',
        headers: { 'X-Internal-Api-Key': 'k' },
      }),
    );
  });

  it('does nothing when no records server is configured', async () => {
    await build({ INTERNAL_API_KEY: 'k' }).companyDeleted(companyId);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      'refuses the call',
      () => Promise.resolve(new Response(null, { status: 500 })),
    ],
    ['is unreachable', () => Promise.reject(new Error('ECONNREFUSED'))],
  ])('never throws when the records server %s', async (_label, answer) => {
    fetchMock.mockImplementation(answer);
    await expect(
      build({
        MCP_RECORDS_URL: 'http://tcp-mcp-records:3015',
        INTERNAL_API_KEY: 'k',
      }).companyDeleted(companyId),
    ).resolves.toBeUndefined();
  });
});
