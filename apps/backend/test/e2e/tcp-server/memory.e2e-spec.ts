import { CompanyUser, EpisodicMemory, TcpCompany, TcpRole } from '@tcp/shared';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { UUID } from 'crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AppModule } from '../../../apps/tcp-server/src/app.module';
import { makeTestJwt } from '../helpers/test-jwt';
import { seedMembership } from '../helpers/seed-membership';
import { requireEnv } from '../../support/require-env';

const STUB_LLM_URL = requireEnv('STUB_LLM_URL');

interface Memory {
  id: string;
  content: string;
  tags: string[];
  agentId: string | null;
  version: number;
}
interface MemoryList {
  memories: Memory[];
  truncated: boolean;
  canWrite: boolean;
}

describe('MemoryController (e2e)', () => {
  let app: INestApplication<App>;
  let companyRepo: Repository<TcpCompany>;
  let roleRepo: Repository<TcpRole>;
  let companyUserRepo: Repository<CompanyUser>;
  let memoryRepo: Repository<EpisodicMemory>;
  const jwt = makeTestJwt();
  const companyIds: UUID[] = [];

  /** A company (with or without an embedding model) and one role in it. */
  async function makeRole(slug: string, embedded = true): Promise<UUID> {
    const company = await companyRepo.save(
      companyRepo.create({
        slug: `memory-${slug}-${Date.now()}`,
        name: `Memory ${slug}`,
        description: 'Test',
        embeddingConfig: embedded
          ? {
              provider: 'openai-compatible',
              model: 'stub-embed',
              baseUrl: STUB_LLM_URL,
              apiKey: 'test',
            }
          : undefined,
      }),
    );
    companyIds.push(company.id);
    await seedMembership(companyUserRepo, company.id);
    const role = await roleRepo.save(
      roleRepo.create({
        slug,
        name: slug,
        description: 'Test role',
        knowledgeDomains: [],
        mcpServerList: [],
        company,
        companyId: company.id,
      }),
    );
    return role.id;
  }

  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    // Listening, not just init() — see agent.e2e-spec.ts for why.
    await app.listen(0);
    companyRepo = module.get(getRepositoryToken(TcpCompany));
    roleRepo = module.get(getRepositoryToken(TcpRole));
    companyUserRepo = module.get(getRepositoryToken(CompanyUser));
    memoryRepo = module.get(getRepositoryToken(EpisodicMemory));
  });

  afterAll(async () => {
    // Roles and memories go with their company (ON DELETE CASCADE).
    for (const id of companyIds) await companyRepo.delete({ id });
    await app.close();
  });

  describe('a role with an embedding model', () => {
    let roleId: UUID;

    beforeAll(async () => {
      roleId = await makeRole('clerk');
    });

    it('adds, lists newest first, rewords and deletes a memory', async () => {
      const empty = await api()
        .get(`/api/role/${roleId}/memory`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);
      expect(empty.body).toEqual({
        memories: [],
        truncated: false,
        canWrite: true,
      });

      const first = await api()
        .post(`/api/role/${roleId}/memory`)
        .set('Authorization', `Bearer ${jwt}`)
        .send({ content: '  Tea is £3  ', tags: ['prices'] })
        .expect(201);
      const added = first.body as Memory;
      expect(added).toMatchObject({
        content: 'Tea is £3',
        tags: ['prices'],
        agentId: null,
        version: 1,
      });
      await api()
        .post(`/api/role/${roleId}/memory`)
        .set('Authorization', `Bearer ${jwt}`)
        .send({ content: 'Shop shuts at five' })
        .expect(201);

      const listed = await api()
        .get(`/api/role/${roleId}/memory`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);
      expect(
        (listed.body as MemoryList).memories.map((m) => m.content),
      ).toEqual(['Shop shuts at five', 'Tea is £3']);

      const patched = await api()
        .patch(`/api/role/${roleId}/memory/${added.id}`)
        .set('Authorization', `Bearer ${jwt}`)
        .send({ content: 'Tea is £4' })
        .expect(200);
      expect(patched.body).toMatchObject({
        content: 'Tea is £4',
        tags: ['prices'],
        version: 2,
      });
      // Rewording re-embeds, so recall finds the memory by its new words.
      const [{ embedded }] = await memoryRepo.query<{ embedded: boolean }[]>(
        `SELECT embedding IS NOT NULL AS embedded FROM episodic_memory WHERE id = $1`,
        [added.id],
      );
      expect(embedded).toBe(true);

      await api()
        .delete(`/api/role/${roleId}/memory/${added.id}`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(204);
      const after = await api()
        .get(`/api/role/${roleId}/memory`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);
      expect((after.body as MemoryList).memories).toHaveLength(1);
    });

    it('refuses content over 2,000 characters, and blank content', async () => {
      for (const content of ['x'.repeat(2001), '   ']) {
        await api()
          .post(`/api/role/${roleId}/memory`)
          .set('Authorization', `Bearer ${jwt}`)
          .send({ content })
          .expect(400);
      }
    });

    describe("another role's memory", () => {
      let otherRoleId: UUID;
      let otherMemoryId: string;

      beforeAll(async () => {
        otherRoleId = await makeRole('baker');
        const res = await api()
          .post(`/api/role/${otherRoleId}/memory`)
          .set('Authorization', `Bearer ${jwt}`)
          .send({ content: 'Bread proves overnight' })
          .expect(201);
        otherMemoryId = (res.body as Memory).id;
      });

      it('is not found through this role', async () => {
        await api()
          .patch(`/api/role/${roleId}/memory/${otherMemoryId}`)
          .set('Authorization', `Bearer ${jwt}`)
          .send({ content: 'hijacked' })
          .expect(404);
        await api()
          .delete(`/api/role/${roleId}/memory/${otherMemoryId}`)
          .set('Authorization', `Bearer ${jwt}`)
          .expect(404);
        const kept = await memoryRepo.findOneByOrFail({
          id: otherMemoryId as UUID,
        });
        expect(kept.content).toBe('Bread proves overnight');
      });
    });

    describe('a non-member', () => {
      const outsider = makeTestJwt({ sub: 'outsider' });
      const memoryId = '00000000-0000-4000-8000-000000000000';

      it.each([
        ['get', ''],
        ['post', ''],
        ['patch', `/${memoryId}`],
        ['delete', `/${memoryId}`],
      ] as const)('is refused: %s', async (method, suffix) => {
        await api()
          [method](`/api/role/${roleId}/memory${suffix}`)
          .set('Authorization', `Bearer ${outsider}`)
          .send({ content: 'x' })
          .expect(403);
      });
    });
  });

  describe('a role whose company has no embedding model', () => {
    let roleId: UUID;

    beforeAll(async () => {
      roleId = await makeRole('unembedded', false);
    });

    it('lists with canWrite false, and refuses a new memory with 422', async () => {
      const list = await api()
        .get(`/api/role/${roleId}/memory`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);
      expect((list.body as MemoryList).canWrite).toBe(false);

      const refused = await api()
        .post(`/api/role/${roleId}/memory`)
        .set('Authorization', `Bearer ${jwt}`)
        .send({ content: 'x' })
        .expect(422);
      expect((refused.body as { message: string }).message).toContain(
        'no embedding model',
      );
    });
  });
});
