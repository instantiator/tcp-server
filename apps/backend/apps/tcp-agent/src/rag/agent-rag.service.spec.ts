import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { AgentRagService } from './agent-rag.service';

const ROLE_ID = randomUUID();
const COMPANY_ID = randomUUID();

function makeDataSource(rows: unknown[] = []): jest.Mocked<DataSource> {
  return {
    query: jest.fn().mockResolvedValue(rows),
  } as unknown as jest.Mocked<DataSource>;
}

describe('AgentRagService', () => {
  describe('hasKnowledge', () => {
    it('is true when the existence query returns exists=true', async () => {
      const svc = new AgentRagService(makeDataSource([{ exists: true }]));
      await expect(svc.hasKnowledge(ROLE_ID, COMPANY_ID)).resolves.toBe(true);
    });

    it('is false when the role and its shared scope have no chunks', async () => {
      const svc = new AgentRagService(makeDataSource([{ exists: false }]));
      await expect(svc.hasKnowledge(ROLE_ID, COMPANY_ID)).resolves.toBe(false);
    });

    it('is false when the query returns no row at all', async () => {
      const svc = new AgentRagService(makeDataSource([]));
      await expect(svc.hasKnowledge(ROLE_ID, COMPANY_ID)).resolves.toBe(false);
    });

    // The check exists to avoid an embedding call for roles with no knowledge,
    // so it must stay a single indexed existence query.
    it('searches the role scope and the company shared scope', async () => {
      const dataSource = makeDataSource([{ exists: true }]);
      await new AgentRagService(dataSource).hasKnowledge(ROLE_ID, COMPANY_ID);

      const [sql, params] = dataSource.query.mock.calls[0] as [
        string,
        unknown[],
      ];
      expect(sql).toContain('EXISTS');
      expect(sql).toContain(
        '("roleId" = $1) OR ("roleId" IS NULL AND "companyId" = $2)',
      );
      expect(params).toEqual([ROLE_ID, COMPANY_ID]);
    });
  });
});
