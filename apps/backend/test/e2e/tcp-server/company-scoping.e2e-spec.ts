import { CompanyUser, TcpCompany, TcpRole } from '@tcp/shared';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { UUID } from 'crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AppModule } from '../../../apps/tcp-server/src/app.module';
import { makeTestJwt } from '../helpers/test-jwt';

/** A `GET /api/company` row: the company record plus its statistics. */
interface CompanyRow {
  id: string;
  slug: string;
  stats: {
    activeAgents: number;
    tasksByStatus: Record<string, number>;
    openEnquiries: number;
  };
}

/**
 * Exercises the membership scoping of `GET /api/company` (ADR-023): the
 * default list is what the signed-in user may see, `?all=true` is the
 * unscoped administrative view — restricted to `TCP_ADMIN_IDENTIFIERS` since
 * 002.05 — and a membership keyed by email is found as readily as one keyed
 * by the OIDC `sub`.
 */
describe('GET /api/company scoping (e2e)', () => {
  let app: INestApplication<App>;
  let companyRepo: Repository<TcpCompany>;
  let roleRepo: Repository<TcpRole>;
  let userRepo: Repository<CompanyUser>;

  /** Alice creates her own company; Bob's is created under a second identity. */
  const aliceJwt = makeTestJwt({ sub: 'alice', email: 'alice@example.com' });
  const bobJwt = makeTestJwt({ sub: 'bob', email: 'bob@example.com' });
  /** Named in `.env.testing`'s TCP_ADMIN_IDENTIFIERS — the only `?all=true` caller. */
  const adminJwt = makeTestJwt({ sub: 'e2e-admin' });

  let aliceCompanyId: string;
  let bobCompanyId: string;
  let emailOnlyCompanyId: string;

  const list = async (jwt: string, all = false): Promise<CompanyRow[]> => {
    const res = await request(app.getHttpServer())
      .get(all ? '/api/company?all=true' : '/api/company')
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);
    return res.body as CompanyRow[];
  };

  const createCompany = async (jwt: string, slug: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/company')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ slug, name: slug, description: 'test' })
      .expect(201);
    return (res.body as { id: string }).id;
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();

    companyRepo = moduleFixture.get(getRepositoryToken(TcpCompany));
    roleRepo = moduleFixture.get(getRepositoryToken(TcpRole));
    userRepo = moduleFixture.get(getRepositoryToken(CompanyUser));

    const stamp = Date.now();
    aliceCompanyId = await createCompany(aliceJwt, `scope-alice-${stamp}`);
    bobCompanyId = await createCompany(bobJwt, `scope-bob-${stamp}`);
    emailOnlyCompanyId = await createCompany(bobJwt, `scope-email-${stamp}`);

    // Alice reaches the third company only through an email-keyed membership
    // row — the silent failure that `sub`-only matching would produce.
    await request(app.getHttpServer())
      .post(`/api/company/${emailOnlyCompanyId}/users`)
      .set('Authorization', `Bearer ${bobJwt}`)
      .send({ identifier: 'alice@example.com', memberType: 'member' })
      .expect(201);
  });

  afterAll(async () => {
    // Only this suite's own companies — a blanket delete would take out
    // fixtures other e2e suites share the database with. The company delete
    // cascades to its roles and CompanyUser rows.
    for (const id of [aliceCompanyId, bobCompanyId, emailOnlyCompanyId]) {
      await userRepo.delete({ companyId: id as UUID });
      await roleRepo.delete({ companyId: id as UUID });
      await companyRepo.delete({ id: id as UUID });
    }
    await app.close();
  });

  it('excludes a company the caller is not a member of', async () => {
    const ids = (await list(aliceJwt)).map((c) => c.id);
    expect(ids).toContain(aliceCompanyId);
    expect(ids).not.toContain(bobCompanyId);
  });

  it('includes every company under ?all=true, for an administrator', async () => {
    const ids = (await list(adminJwt, true)).map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        aliceCompanyId,
        bobCompanyId,
        emailOnlyCompanyId,
      ]),
    );
  });

  // Refused rather than silently narrowed to her own companies: a caller who
  // may not see everything should be told so, not handed a different answer.
  it('refuses ?all=true to a caller who is not an administrator', () =>
    request(app.getHttpServer())
      .get('/api/company?all=true')
      .set('Authorization', `Bearer ${aliceJwt}`)
      .expect(403));

  it('finds a company reachable only through an email-keyed membership', async () => {
    const ids = (await list(aliceJwt)).map((c) => c.id);
    expect(ids).toContain(emailOnlyCompanyId);
  });

  it('carries the full stat set on every row, in both modes', async () => {
    const mine = new Set([aliceCompanyId, bobCompanyId, emailOnlyCompanyId]);
    // Filtered to this suite's own companies: `?all=true` also returns
    // whatever other e2e suites have in the shared database.
    for (const rows of [await list(aliceJwt), await list(adminJwt, true)]) {
      for (const row of rows.filter((r) => mine.has(r.id))) {
        expect(row.stats).toMatchObject({
          activeAgents: 0,
          openEnquiries: 0,
        });
        // Zero-filled: every status key present, not just the ones in use.
        expect(Object.keys(row.stats.tasksByStatus).sort()).toEqual([
          'cancelled',
          'failed',
          'finalising',
          'in-progress',
          'planning',
          'ready',
          'succeeded',
        ]);
      }
    }
  });
});
