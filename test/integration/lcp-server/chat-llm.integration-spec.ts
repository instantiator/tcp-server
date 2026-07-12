import {
  AgentEvent,
  AgentStatus,
  AuditEvent,
  AuditEventType,
  LcpAgent,
  LcpAssignment,
  LcpCompany,
  LcpRole,
  LcpTask,
  McpClientService,
} from '@lcp/shared';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { UUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { ChatService } from '../../../apps/lcp-server/src/api/chat.service';
import { AuditService } from '../../../apps/lcp-server/src/audit/audit.service';
import { ContextModule } from '../../../apps/lcp-server/src/context/context.module';
import { AgentEventService } from '../../../apps/lcp-server/src/events/agent-event.service';
import { RagRetrievalService } from '../../../apps/lcp-server/src/rag/rag-retrieval.service';
import { requireEnv } from '../../support/require-env';

/**
 * Integration tests for {@link ChatService} against a live PostgreSQL instance
 * and a stub LLM service. Both are provisioned by the integration global setup,
 * so DATABASE_URL and STUB_LLM_URL are always present.
 *
 * Run via: ./scripts/run-integration-tests.sh
 */

const STUB_LLM_URL = requireEnv('STUB_LLM_URL');
const DATABASE_URL = requireEnv('DATABASE_URL');

async function setStubResponse(response: string): Promise<void> {
  await fetch(`${STUB_LLM_URL.replace('/v1', '')}/stub/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ response }),
  });
}

describe('ChatService integration (stub LLM)', () => {
  let service: ChatService;
  let agentEvents: AgentEventService;
  let agentRepo: Repository<LcpAgent>;
  let assignmentRepo: Repository<LcpAssignment>;
  let roleRepo: Repository<LcpRole>;
  let companyRepo: Repository<LcpCompany>;
  let auditRepo: Repository<AuditEvent>;
  let dataSource: DataSource;
  let testCompanyId: UUID;
  let testRoleId: UUID;

  /**
   * Resolves with the agent's terminal event. The turn now runs detached and
   * delivers its outcome over the event stream rather than a return value.
   */
  function waitForTerminal(agentId: UUID): Promise<AgentEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timed out waiting for terminal event')),
        30_000,
      );
      const sub = agentEvents.observe(agentId).subscribe((event) => {
        if (event.kind === 'completed' || event.kind === 'failed') {
          clearTimeout(timer);
          sub.unsubscribe();
          resolve(event);
        }
      });
    });
  }

  /** Orphan implement-mode assignment for a chat agent's mandatory FK. */
  function seedAssignment() {
    return assignmentRepo.save(
      assignmentRepo.create({
        taskId: null,
        companyId: testCompanyId,
        roleId: testRoleId,
        mode: 'implement',
        prompt: '',
        status: 'in-progress',
      }),
    );
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        TypeOrmModule.forRoot({
          type: 'postgres',
          url: DATABASE_URL,
          entities: [
            LcpAgent,
            LcpRole,
            LcpCompany,
            LcpTask,
            LcpAssignment,
            AuditEvent,
          ],
          synchronize: true,
        }),
        TypeOrmModule.forFeature([
          LcpAgent,
          LcpRole,
          LcpCompany,
          LcpTask,
          LcpAssignment,
          AuditEvent,
        ]),
        ContextModule,
      ],
      providers: [
        ChatService,
        AuditService,
        // AgentEventService comes from ContextModule (imported + exported) so
        // ChatService and this test share one instance — the event stream is
        // how the detached turn reports completion.
        {
          provide: RagRetrievalService,
          useValue: { retrieve: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: McpClientService,
          useValue: { loadTools: jest.fn().mockResolvedValue([]) },
        },
      ],
    }).compile();

    service = moduleRef.get(ChatService);
    agentEvents = moduleRef.get(AgentEventService);
    agentRepo = moduleRef.get(getRepositoryToken(LcpAgent));
    assignmentRepo = moduleRef.get(getRepositoryToken(LcpAssignment));
    roleRepo = moduleRef.get(getRepositoryToken(LcpRole));
    companyRepo = moduleRef.get(getRepositoryToken(LcpCompany));
    auditRepo = moduleRef.get(getRepositoryToken(AuditEvent));
    dataSource = moduleRef.get(DataSource);

    // Seed a company and role pointing to the stub LLM
    const company = await companyRepo.save(
      companyRepo.create({
        name: 'Integration Test Co',
        slug: 'test-co',
        description: 'For integration tests',
        llmConfig: {
          provider: 'lm-studio',
          model: 'stub',
          baseUrl: STUB_LLM_URL,
        },
      }),
    );
    testCompanyId = company.id;

    const role = await roleRepo.save(
      roleRepo.create({
        companyId: testCompanyId,
        slug: 'stub-analyst',
        name: 'stub-analyst',
        description: 'Stub test role',
        systemPromptTemplate: 'You are {{name}}, an analyst.',
      }),
    );
    testRoleId = role.id;
  });

  afterAll(async () => {
    if (!dataSource?.isInitialized) return;
    // Clean up test fixtures
    await auditRepo.delete({ companyId: testCompanyId });
    await agentRepo.delete({ companyId: testCompanyId });
    await assignmentRepo.delete({ companyId: testCompanyId });
    await roleRepo.delete({ companyId: testCompanyId });
    await companyRepo.delete({ id: testCompanyId });
    await agentEvents.onModuleDestroy();
    await dataSource.destroy();
  });

  it('streams a message end-to-end and completes with the stub response', async () => {
    await setStubResponse('Hello from stub LLM!');

    const assignment = await seedAssignment();
    const agent = await agentRepo.save(
      agentRepo.create({
        companyId: testCompanyId,
        roleId: testRoleId,
        assignmentId: assignment.id,
        status: AgentStatus.Idle,
        initialPrompt: '',
      }),
    );

    try {
      const terminal = waitForTerminal(agent.id);
      await service.sendMessage(agent.id, 'Hi there');
      const event = await terminal;

      expect(event.kind).toBe('completed');
      if (event.kind === 'completed') {
        expect(event.data.response).toBe('Hello from stub LLM!');
      }

      // The response is also persisted for the recovery/replay path.
      const updated = await agentRepo.findOneBy({ id: agent.id });
      expect(updated?.status).toBe(AgentStatus.Idle);
      expect(updated?.output).toBe('Hello from stub LLM!');
    } finally {
      await agentRepo.delete({ id: agent.id });
    }
  });

  it('writes LlmRequest and LlmResponse audit events', async () => {
    await setStubResponse('Audit test response');

    const assignment = await seedAssignment();
    const agent = await agentRepo.save(
      agentRepo.create({
        companyId: testCompanyId,
        roleId: testRoleId,
        assignmentId: assignment.id,
        status: AgentStatus.Idle,
        initialPrompt: '',
      }),
    );

    try {
      const terminal = waitForTerminal(agent.id);
      await service.sendMessage(agent.id, 'Audit test');
      await terminal;

      const events = await auditRepo.find({
        where: { agentId: agent.id },
        order: { timestamp: 'ASC' },
      });

      const types = events.map((e) => e.eventType);
      expect(types).toContain(AuditEventType.LlmRequest);
      expect(types).toContain(AuditEventType.LlmResponse);
    } finally {
      await auditRepo.delete({ agentId: agent.id });
      await agentRepo.delete({ id: agent.id });
    }
  });
});
