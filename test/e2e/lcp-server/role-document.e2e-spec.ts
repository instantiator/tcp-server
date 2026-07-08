import { AuditEvent, LcpAgent, LcpCompany, LcpRole } from '@lcp/shared';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AppModule } from '../../../apps/lcp-server/src/app.module';

describe('RoleDocumentController (e2e)', () => {
  let app: INestApplication<App>;
  let companyRepo: Repository<LcpCompany>;
  let roleRepo: Repository<LcpRole>;
  let agentRepo: Repository<LcpAgent>;
  let auditRepo: Repository<AuditEvent>;
  let roleId: string;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    companyRepo = module.get(getRepositoryToken(LcpCompany));
    roleRepo = module.get(getRepositoryToken(LcpRole));
    agentRepo = module.get(getRepositoryToken(LcpAgent));
    auditRepo = module.get(getRepositoryToken(AuditEvent));
    const company = await companyRepo.save(
      companyRepo.create({
        slug: 'doc-co',
        name: 'DocCo',
        description: 'Test',
      }),
    );
    const role = await roleRepo.save(
      roleRepo.create({
        slug: 'writer',
        name: 'Writer',
        description: 'Test role',
        systemPromptTemplate: 'Write.',
        knowledgeDomains: [],
        mcpServerList: [],
        company,
        companyId: company.id,
      }),
    );
    roleId = role.id;
  });

  afterEach(async () => {
    await auditRepo.createQueryBuilder().delete().execute();
    await agentRepo.createQueryBuilder().delete().execute();
  });

  afterAll(async () => {
    await roleRepo.createQueryBuilder().delete().execute();
    await companyRepo.createQueryBuilder().delete().execute();
    await app.close();
  });

  // Document endpoints require MinIO for storage — only auth gating is tested here.
  // Full document round-trips are covered by integration tests (scripts/run-integration-tests.sh).

  it('GET /api/role/:roleId/documents returns 401 without a token', () =>
    request(app.getHttpServer())
      .get(`/api/role/${roleId}/documents`)
      .expect(401));

  it('POST /api/role/:roleId/documents returns 401 without a token', () =>
    request(app.getHttpServer())
      .post(`/api/role/${roleId}/documents`)
      .expect(401));

  it('DELETE /api/role/:roleId/documents returns 401 without a token', () =>
    request(app.getHttpServer())
      .delete(`/api/role/${roleId}/documents`)
      .expect(401));
});
