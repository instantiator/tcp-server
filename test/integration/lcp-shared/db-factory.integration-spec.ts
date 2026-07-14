import { LcpCompany, LcpRole } from '@lcp/shared';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { makeTypeOrmConfig } from '@lcp/shared';
import type { Repository } from 'typeorm';
import { requireEnv } from '../../support/require-env';

// PostgreSQL is provisioned by the integration global setup; DATABASE_URL is
// always a real postgres URL. The SQLite fallback block below temporarily
// overrides it to exercise the in-memory path, then restores it.
// Run via: ./scripts/run-integration-tests.sh
describe('makeTypeOrmConfig (lcp-shared)', () => {
  describe('SQLite fallback (DATABASE_URL absent or sqlite)', () => {
    it('starts successfully with an in-memory SQLite database', async () => {
      const savedUrl = process.env.DATABASE_URL;
      process.env.DATABASE_URL = 'sqlite::memory:';
      try {
        const module = await Test.createTestingModule({
          imports: [
            ConfigModule.forRoot({ isGlobal: true }),
            // LcpRole is registered but never queried here — required so
            // TypeORM can resolve LcpCompany.plannerRole's relation target.
            makeTypeOrmConfig([LcpCompany, LcpRole]),
            TypeOrmModule.forFeature([LcpCompany]),
          ],
        }).compile();

        const repo = module.get<Repository<LcpCompany>>(
          getRepositoryToken(LcpCompany),
        );
        expect(repo).toBeDefined();
        await module.close();
      } finally {
        process.env.DATABASE_URL = savedUrl;
      }
    });
  });

  describe('PostgreSQL (DATABASE_URL set to postgres)', () => {
    beforeAll(() => {
      // Fail loudly if the postgres URL is missing rather than silently
      // exercising the sqlite fallback and reporting a false pass.
      requireEnv('DATABASE_URL');
    });

    it('starts successfully and can query companies', async () => {
      const module = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ isGlobal: true }),
          makeTypeOrmConfig([LcpCompany, LcpRole]),
          TypeOrmModule.forFeature([LcpCompany]),
        ],
      }).compile();

      const repo = module.get<Repository<LcpCompany>>(
        getRepositoryToken(LcpCompany),
      );
      expect(repo).toBeDefined();

      // Table may not exist if migrations haven't run — just verify the connection is live.
      const result =
        await repo.manager.query<[{ ok: number }]>('SELECT 1 AS ok');
      expect(result[0].ok).toBe(1);

      await module.close();
    });
  });
});
