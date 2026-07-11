import { AuditEvent, LcpAgent, LcpCompany, LcpRole } from '@lcp/shared';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AppModule } from '../../../apps/lcp-server/src/app.module';

describe('KnowledgeController (e2e)', () => {
  let app: INestApplication<App>;
  let companyRepo: Repository<LcpCompany>;
  let roleRepo: Repository<LcpRole>;
  let agentRepo: Repository<LcpAgent>;
  let auditRepo: Repository<AuditEvent>;
  let roleId: string;
  let companyId: string;

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
        slug: 'knowledge-co',
        name: 'KnowledgeCo',
        description: 'Test',
      }),
    );
    companyId = company.id;
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

  // Knowledge endpoints require MinIO for storage — only auth gating is tested here.
  // Full document round-trips are covered by integration tests (scripts/run-integration-tests.sh).

  describe('role scope', () => {
    it('GET /api/role/:roleId/knowledge returns 401 without a token', () =>
      request(app.getHttpServer())
        .get(`/api/role/${roleId}/knowledge`)
        .expect(401));

    it('GET /api/role/:roleId/knowledge/:filename returns 401 without a token', () =>
      request(app.getHttpServer())
        .get(`/api/role/${roleId}/knowledge/report.md`)
        .expect(401));

    it('POST /api/role/:roleId/knowledge returns 401 without a token', () =>
      request(app.getHttpServer())
        .post(`/api/role/${roleId}/knowledge`)
        .expect(401));

    it('DELETE /api/role/:roleId/knowledge/:filename returns 401 without a token', () =>
      request(app.getHttpServer())
        .delete(`/api/role/${roleId}/knowledge/report.md`)
        .expect(401));
  });

  describe('company scope', () => {
    it('GET /api/company/:companyId/knowledge returns 401 without a token', () =>
      request(app.getHttpServer())
        .get(`/api/company/${companyId}/knowledge`)
        .expect(401));

    it('GET /api/company/:companyId/knowledge/:filename returns 401 without a token', () =>
      request(app.getHttpServer())
        .get(`/api/company/${companyId}/knowledge/policy.md`)
        .expect(401));

    it('POST /api/company/:companyId/knowledge returns 401 without a token', () =>
      request(app.getHttpServer())
        .post(`/api/company/${companyId}/knowledge`)
        .expect(401));

    it('DELETE /api/company/:companyId/knowledge/:filename returns 401 without a token', () =>
      request(app.getHttpServer())
        .delete(`/api/company/${companyId}/knowledge/policy.md`)
        .expect(401));
  });
});
