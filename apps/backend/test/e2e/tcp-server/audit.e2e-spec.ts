import {
  AuditEvent,
  AuditEventType,
  CompanyUser,
  TcpAgent,
  TcpAssignment,
  TcpCompany,
  TcpRole,
  TcpTask,
} from '@tcp/shared';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { UUID } from 'crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AuditService } from '../../../apps/tcp-server/src/audit/audit.service';
import { AppModule } from '../../../apps/tcp-server/src/app.module';
import { makeTestJwt } from '../helpers/test-jwt';
import { seedMembership } from '../helpers/seed-membership';

const INTERNAL_KEY = process.env.INTERNAL_API_KEY ?? 'e2e-test-internal-key';

describe('AuditController (e2e)', () => {
  let app: INestApplication<App>;
  let companyRepo: Repository<TcpCompany>;
  let roleRepo: Repository<TcpRole>;
  let agentRepo: Repository<TcpAgent>;
  let assignmentRepo: Repository<TcpAssignment>;
  let taskRepo: Repository<TcpTask>;
  let auditRepo: Repository<AuditEvent>;
  let auditService: AuditService;
  let jwt: string;
  let companyId: UUID;
  let agentId: UUID;
  let roleId: UUID;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    // Listening, not just init() — see agent.e2e-spec.ts for why.
    await app.listen(0);
    companyRepo = module.get(getRepositoryToken(TcpCompany));
    roleRepo = module.get(getRepositoryToken(TcpRole));
    agentRepo = module.get(getRepositoryToken(TcpAgent));
    assignmentRepo = module.get(getRepositoryToken(TcpAssignment));
    taskRepo = module.get(getRepositoryToken(TcpTask));
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
    await seedMembership(
      module.get(getRepositoryToken(CompanyUser)),
      company.id,
    );
    const role = await roleRepo.save(
      roleRepo.create({
        slug: 'auditor',
        name: 'Auditor',
        description: 'Test role',
        systemPromptTemplate: 'Audit.',
        knowledgeDomains: [],
        mcpServerList: [],
        company,
        companyId: company.id,
      }),
    );
    roleId = role.id;

    agentId = (
      (
        await request(app.getHttpServer())
          .post('/api/agent/chat/start')
          .set('Authorization', `Bearer ${jwt}`)
          .send({ companyId, roleId: role.id })
          .expect(201)
      ).body as TcpAgent
    ).id;
  });

  afterEach(async () => {
    await auditRepo.createQueryBuilder().delete().execute();
  });

  afterAll(async () => {
    await agentRepo.createQueryBuilder().delete().execute();
    await assignmentRepo.createQueryBuilder().delete().execute();
    await taskRepo.createQueryBuilder().delete().execute();
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

    it('returns 403 with the wrong internal API key', () =>
      request(app.getHttpServer())
        .post('/internal/audit')
        .set('X-Internal-Api-Key', 'wrong-key')
        .send({
          agentId,
          companyId,
          role: 'Auditor',
          eventType: AuditEventType.LlmResponse,
          payload: {},
        })
        .expect(403));

    // Regression test: CreateAuditEventDto originally had no class-validator
    // decorators, so the app-wide `ValidationPipe({ whitelist: true })`
    // silently stripped every field, leaving companyId/role/eventType/payload
    // undefined and failing the entity's NOT NULL constraints with a generic
    // 500 — every real caller of this endpoint was broken. This drives the
    // actual HTTP path (not `AuditService.record()` directly), which is the
    // only way to catch a whitelist-stripping regression like this again.
    it('persists a full audit event through the real HTTP endpoint with the internal API key', async () => {
      await request(app.getHttpServer())
        .post('/internal/audit')
        .set('X-Internal-Api-Key', INTERNAL_KEY)
        .send({
          agentId,
          companyId,
          role: 'Auditor',
          eventType: AuditEventType.ToolCall,
          payload: { tool: 'describe_server' },
        })
        .expect(204);

      const events = await auditRepo.find({ where: { agentId } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        companyId,
        role: 'Auditor',
        agentId,
        eventType: AuditEventType.ToolCall,
        payload: { tool: 'describe_server' },
      });
    });

    it('persists an audit event with agentId omitted (system-level event)', async () => {
      await request(app.getHttpServer())
        .post('/internal/audit')
        .set('X-Internal-Api-Key', INTERNAL_KEY)
        .send({
          companyId,
          role: 'system',
          eventType: AuditEventType.Decision,
          payload: { note: 'no agent' },
        })
        .expect(204);

      const events = await auditRepo.find({
        where: { companyId, role: 'system' },
      });
      expect(events).toHaveLength(1);
      expect(events[0].agentId).toBeNull();
    });

    it('derives assignmentId and taskId server-side from the agent, ignoring caller-supplied ids', async () => {
      const task = await taskRepo.save(
        taskRepo.create({
          companyId,
          shortcode: '900',
          request: 'do it',
          materials: [],
          expected: [],
        }),
      );
      const assignment = await assignmentRepo.save(
        assignmentRepo.create({
          companyId,
          taskId: task.id,
          mode: 'plan',
          prompt: 'plan it',
          roleId,
        }),
      );
      const agent = await agentRepo.save(
        agentRepo.create({
          companyId,
          roleId,
          assignmentId: assignment.id,
          initialPrompt: 'plan it',
        }),
      );

      await request(app.getHttpServer())
        .post('/internal/audit')
        .set('X-Internal-Api-Key', INTERNAL_KEY)
        .send({
          agentId: agent.id,
          companyId,
          role: 'Planner',
          // Bogus ids a caller must never be able to override.
          assignmentId: '00000000-0000-0000-0000-000000000000',
          taskId: '00000000-0000-0000-0000-000000000000',
          eventType: AuditEventType.StateChange,
          payload: { entity: 'agent', newStatus: 'running' },
        })
        .expect(204);

      const events = await auditRepo.find({ where: { agentId: agent.id } });
      expect(events).toHaveLength(1);
      expect(events[0].assignmentId).toBe(assignment.id);
      expect(events[0].taskId).toBe(task.id);
    });

    it('accepts explicit assignmentId/taskId for an agent-less orchestrator row', async () => {
      const task = await taskRepo.save(
        taskRepo.create({
          companyId,
          shortcode: '901',
          request: 'orchestrate',
          materials: [],
          expected: [],
        }),
      );

      await request(app.getHttpServer())
        .post('/internal/audit')
        .set('X-Internal-Api-Key', INTERNAL_KEY)
        .send({
          companyId,
          role: 'orchestrator',
          taskId: task.id,
          eventType: AuditEventType.StateChange,
          payload: { entity: 'task', newStatus: 'planning' },
        })
        .expect(204);

      const events = await auditRepo.find({
        where: { companyId, role: 'orchestrator' },
      });
      expect(events).toHaveLength(1);
      expect(events[0].agentId).toBeNull();
      expect(events[0].taskId).toBe(task.id);
    });

    it('rejects a request missing required fields with a 400, not a 500', () =>
      request(app.getHttpServer())
        .post('/internal/audit')
        .set('X-Internal-Api-Key', INTERNAL_KEY)
        .send({ agentId })
        .expect(400));

    it('rejects an invalid eventType with a 400', () =>
      request(app.getHttpServer())
        .post('/internal/audit')
        .set('X-Internal-Api-Key', INTERNAL_KEY)
        .send({
          companyId,
          role: 'Auditor',
          eventType: 'not_a_real_event_type',
          payload: {},
        })
        .expect(400));

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
