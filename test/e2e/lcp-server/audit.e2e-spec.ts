import {
  AuditEvent,
  AuditEventType,
  LcpAgent,
  LcpCompany,
  LcpRole,
} from '@lcp/shared';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { UUID } from 'crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AuditService } from '../../../apps/lcp-server/src/audit/audit.service';
import { AppModule } from '../../../apps/lcp-server/src/app.module';
import { makeTestJwt } from '../helpers/test-jwt';

describe('AuditController (e2e)', () => {
  let app: INestApplication<App>;
  let companyRepo: Repository<LcpCompany>;
  let roleRepo: Repository<LcpRole>;
  let agentRepo: Repository<LcpAgent>;
  let auditRepo: Repository<AuditEvent>;
  let auditService: AuditService;
  let jwt: string;
  let companyId: UUID;
  let agentId: UUID;

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
    auditService = module.get(AuditService);
    jwt = makeTestJwt();

    const company = await companyRepo.save(
      companyRepo.create({
        slug: 'audit-co',
        name: 'AuditCo',
        description: 'Test',
      }),
    );
    companyId = company.id;
    const role = await roleRepo.save(
      roleRepo.create({
        name: 'Auditor',
        description: 'Test role',
        systemPromptTemplate: 'Audit.',
        knowledgeDomains: [],
        mcpServerList: [],
        company,
        companyId: company.id,
      }),
    );

    agentId = (
      (
        await request(app.getHttpServer())
          .post('/api/agent/chat/start')
          .set('Authorization', `Bearer ${jwt}`)
          .send({ companyId, roleId: role.id })
          .expect(201)
      ).body as LcpAgent
    ).id;
  });

  afterEach(async () => {
    await auditRepo.createQueryBuilder().delete().execute();
  });

  afterAll(async () => {
    await agentRepo.createQueryBuilder().delete().execute();
    await roleRepo.createQueryBuilder().delete().execute();
    await companyRepo.createQueryBuilder().delete().execute();
    await app.close();
  });

  describe('POST /internal/audit', () => {
    it('returns 401 without the internal API key', () =>
      request(app.getHttpServer())
        .post('/internal/audit')
        .send({
          agentId,
          companyId,
          role: 'Auditor',
          eventType: AuditEventType.LlmResponse,
          payload: {},
        })
        .expect(401));

    it('persists an audit event written via AuditService.record()', async () => {
      await auditService.record(
        companyId,
        'Auditor',
        agentId,
        AuditEventType.LlmResponse,
        { tokens: 42 },
      );

      const events = await auditRepo.find({ where: { agentId } });
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe(AuditEventType.LlmResponse);
    });
  });
});
