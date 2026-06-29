import { LcpCompany } from '@lcp/shared';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { makeTypeOrmConfig } from '@lcp/shared';
import type { Repository } from 'typeorm';

// Requires DATABASE_URL pointing to a running PostgreSQL instance.
// Run via: ./scripts/run-integration-tests.sh
describe('makeTypeOrmConfig (lcp-shared)', () => {
  const hasPg =
    !!process.env.DATABASE_URL &&
    !process.env.DATABASE_URL.startsWith('sqlite');

  describe('SQLite fallback (DATABASE_URL absent or sqlite)', () => {
    it('starts successfully with an in-memory SQLite database', async () => {
      const savedUrl = process.env.DATABASE_URL;
      process.env.DATABASE_URL = 'sqlite::memory:';
      try {
        const module = await Test.createTestingModule({
          imports: [
            ConfigModule.forRoot({ isGlobal: true }),
            makeTypeOrmConfig([LcpCompany]),
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

  (hasPg ? describe : describe.skip)(
    'PostgreSQL (DATABASE_URL set to postgres)',
    () => {
      it('starts successfully and can query companies', async () => {
        const module = await Test.createTestingModule({
          imports: [
            ConfigModule.forRoot({ isGlobal: true }),
            makeTypeOrmConfig([LcpCompany]),
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
    },
  );
});
