import { TcpCompany, TokenUsage } from '@tcp/shared';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AppModule } from '../../../apps/tcp-server/src/app.module';
import { makeTestJwt } from '../helpers/test-jwt';

/**
 * Exercises the spend reporting routes over real HTTP and Postgres:
 * application-wide totals and caps (`GET /api/spend`), and one company's
 * totals, per-task breakdown and recent series (`GET /api/company/:id/spend`).
 *
 * `.env.testing` sets no `SPEND_CAPS`, so `caps` is always `[]` here — cap
 * evaluation itself is covered by the spend-caps e2e spec and unit specs.
 */
describe('Spend reporting (e2e)', () => {
  let app: INestApplication<App>;
  let companyRepo: Repository<TcpCompany>;
  let usageRepo: Repository<TokenUsage>;
  let member: { Authorization: string };
  let stranger: { Authorization: string };
  let company: TcpCompany;
  let rowIds: string[];

  const task1 = randomUUID();
  const task2 = randomUUID();

  /** Inserts a usage row, optionally backdated past its `@CreateDateColumn` default. */
  async function recordUsage(
    fields: Partial<TokenUsage>,
    createdAt?: Date,
  ): Promise<void> {
    const saved = await usageRepo.save(
      usageRepo.create({
        companyId: company.id,
        provider: 'anthropic',
        model: 'claude',
        inputTokens: 1,
        outputTokens: 1,
        ...fields,
      }),
    );
    rowIds.push(saved.id);
    if (createdAt) {
      await usageRepo.update(saved.id, { createdAt });
    }
  }

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.listen(0);
    companyRepo = module.get(getRepositoryToken(TcpCompany));
    usageRepo = module.get(getRepositoryToken(TokenUsage));

    member = { Authorization: `Bearer ${makeTestJwt()}` };
    stranger = {
      Authorization: `Bearer ${makeTestJwt({ sub: 'spend-report-stranger' })}`,
    };

    company = (
      await request(app.getHttpServer())
        .post('/api/company')
        .set(member)
        .send({
          slug: `spend-report-${Date.now()}`,
          name: 'Spend Report Co',
          description: 'test',
        })
        .expect(201)
    ).body as TcpCompany;

    rowIds = [];
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);

    // task1: two providers, the larger total of the two tasks.
    await recordUsage({
      provider: 'anthropic',
      taskId: task1,
      inputTokens: 100,
      outputTokens: 20,
    });
    // task2: smaller total.
    await recordUsage({
      provider: 'anthropic',
      taskId: task2,
      inputTokens: 50,
      outputTokens: 5,
    });
    // A task-less row (a chat) — only in providers, never in per-task totals.
    await recordUsage({
      provider: 'openai',
      taskId: undefined,
      inputTokens: 10,
      outputTokens: 1,
    });
    // A row older than 24h: counted in totals, excluded from the series.
    await recordUsage(
      {
        provider: 'anthropic',
        taskId: task1,
        inputTokens: 1000,
        outputTokens: 100,
      },
      old,
    );
  });

  afterAll(async () => {
    await usageRepo
      .createQueryBuilder()
      .delete()
      .where('id IN (:...ids)', { ids: rowIds })
      .execute();
    await companyRepo.delete({ id: company.id });
    await app.close();
  });

  describe('GET /api/spend', () => {
    it('401s when unauthenticated', async () => {
      await request(app.getHttpServer()).get('/api/spend').expect(401);
    });

    it('returns application-wide totals, with no caps configured', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/spend')
        .set(member)
        .expect(200);

      const overview = res.body as {
        trackingSince: string | null;
        providers: {
          provider: string;
          inputTokens: number;
          outputTokens: number;
        }[];
        caps: unknown[];
      };

      expect(overview.trackingSince).not.toBeNull();
      expect(overview.caps).toEqual([]);

      const anthropic = overview.providers.find(
        (p) => p.provider === 'anthropic',
      );
      const openai = overview.providers.find((p) => p.provider === 'openai');
      // anthropic: 100+20 + 50+5 + 1000+100 across input/output.
      expect(anthropic).toEqual({
        provider: 'anthropic',
        inputTokens: 1150,
        outputTokens: 125,
      });
      expect(openai).toEqual({
        provider: 'openai',
        inputTokens: 10,
        outputTokens: 1,
      });
    });
  });

  describe('GET /api/company/:id/spend', () => {
    it('401s when unauthenticated', async () => {
      await request(app.getHttpServer())
        .get(`/api/company/${company.id}/spend`)
        .expect(401);
    });

    it('403s for someone outside the company', async () => {
      await request(app.getHttpServer())
        .get(`/api/company/${company.id}/spend`)
        .set(stranger)
        .expect(403);
    });

    it('returns per-task totals ordered largest first, with the task-less row only in providers', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/company/${company.id}/spend`)
        .set(member)
        .expect(200);

      const spend = res.body as {
        trackingSince: string | null;
        providers: {
          provider: string;
          inputTokens: number;
          outputTokens: number;
        }[];
        tasks: { taskId: string; inputTokens: number; outputTokens: number }[];
        series: {
          bucketStart: string;
          inputTokens: number;
          outputTokens: number;
        }[];
      };

      expect(spend.trackingSince).not.toBeNull();
      expect(spend.tasks).toEqual([
        { taskId: task1, inputTokens: 1100, outputTokens: 120 },
        { taskId: task2, inputTokens: 50, outputTokens: 5 },
      ]);
      // The task-less chat row counts in providers but was never a task.
      expect(spend.tasks.some((t) => t.taskId === undefined)).toBe(false);
      const openai = spend.providers.find((p) => p.provider === 'openai');
      expect(openai).toEqual({
        provider: 'openai',
        inputTokens: 10,
        outputTokens: 1,
      });

      // The >24h-old row (1000/100 on task1) must not appear in the series.
      const totalInSeries = spend.series.reduce(
        (sum, bucket) => sum + bucket.inputTokens,
        0,
      );
      expect(totalInSeries).toBe(160); // 100 + 50 + 10, excluding the old 1000
    });
  });
});
