import {
  AgentStatus,
  AuditEvent,
  AuditEventType,
  LcpAgent,
  LcpCompany,
  LcpRole,
} from '@lcp/shared';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { UUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { ChatService } from '../../../apps/lcp-server/src/api/chat.service';
import { ContextModule } from '../../../apps/lcp-server/src/context/context.module';
import { AgentEventService } from '../../../apps/lcp-server/src/events/agent-event.service';
import { RagRetrievalService } from '../../../apps/lcp-server/src/rag/rag-retrieval.service';

/**
 * Integration tests for {@link ChatService} against a live PostgreSQL instance
 * and a stub LLM service.
 *
 * Requires:
 *  - DATABASE_URL pointing to a running PostgreSQL instance
 *  - STUB_LLM_URL pointing to the stub-llm service (docker/stub-llm)
 *
 * Run via: ./scripts/run-integration-tests.sh
 */

const STUB_LLM_URL = process.env.STUB_LLM_URL ?? 'http://localhost:3002/v1';
const DATABASE_URL = process.env.DATABASE_URL ?? '';

async function setStubResponse(response: string): Promise<void> {
  await fetch(`${STUB_LLM_URL.replace('/v1', '')}/stub/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ response }),
  });
}

describe('ChatService integration (stub LLM)', () => {
  let service: ChatService;
  let agentRepo: Repository<LcpAgent>;
  let roleRepo: Repository<LcpRole>;
  let companyRepo: Repository<LcpCompany>;
  let auditRepo: Repository<AuditEvent>;
  let dataSource: DataSource;
  let testCompanyId: UUID;
  let testRoleId: UUID;

  const skip =
    !DATABASE_URL || DATABASE_URL.startsWith('sqlite') || !STUB_LLM_URL;

  beforeAll(async () => {
    if (skip) return;

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        TypeOrmModule.forRoot({
          type: 'postgres',
          url: DATABASE_URL,
          entities: [LcpAgent, LcpRole, LcpCompany, AuditEvent],
          synchronize: true,
        }),
        TypeOrmModule.forFeature([LcpAgent, LcpRole, LcpCompany, AuditEvent]),
        ContextModule,
      ],
      providers: [
        ChatService,
        AgentEventService,
        {
          provide: RagRetrievalService,
          useValue: { retrieve: jest.fn().mockResolvedValue([]) },
        },
      ],
    }).compile();

    service = moduleRef.get(ChatService);
    agentRepo = moduleRef.get(getRepositoryToken(LcpAgent));
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
        llmDefault: {
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
        name: 'stub-analyst',
        description: 'Stub test role',
        systemPromptTemplate: 'You are {{name}}, an analyst.',
      }),
    );
    testRoleId = role.id;
  });

  afterAll(async () => {
    if (skip || !dataSource?.isInitialized) return;
    // Clean up test fixtures
    await auditRepo.delete({ companyId: testCompanyId });
    await agentRepo.delete({ companyId: testCompanyId });
    await roleRepo.delete({ companyId: testCompanyId });
    await companyRepo.delete({ id: testCompanyId });
    await dataSource.destroy();
  });

  it('skips when DATABASE_URL or STUB_LLM_URL is not set', () => {
    if (skip) {
      console.log(
        'Skipping integration tests — DATABASE_URL or STUB_LLM_URL not set',
      );
    }
    expect(true).toBe(true);
  });

  it('sends a message end-to-end and returns the stub response', async () => {
    if (skip) return;

    await setStubResponse('Hello from stub LLM!');

    const agent = await agentRepo.save(
      agentRepo.create({
        companyId: testCompanyId,
        roleId: testRoleId,
        status: AgentStatus.Idle,
        initialPrompt: '',
      }),
    );

    try {
      const result = await service.sendMessage(agent.id, 'Hi there');
      expect(result.response).toBe('Hello from stub LLM!');
    } finally {
      await agentRepo.delete({ id: agent.id });
    }
  });

  it('writes LlmRequest and LlmResponse audit events', async () => {
    if (skip) return;

    await setStubResponse('Audit test response');

    const agent = await agentRepo.save(
      agentRepo.create({
        companyId: testCompanyId,
        roleId: testRoleId,
        status: AgentStatus.Idle,
        initialPrompt: '',
      }),
    );

    try {
      await service.sendMessage(agent.id, 'Audit test');

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

  it('returns agent to Idle status after cancellation', async () => {
    if (skip) return;

    const agent = await agentRepo.save(
      agentRepo.create({
        companyId: testCompanyId,
        roleId: testRoleId,
        status: AgentStatus.Idle,
        initialPrompt: '',
      }),
    );

    try {
      const controller = new AbortController();
      // Abort immediately to simulate client disconnect
      controller.abort();

      const result = await service.sendMessage(
        agent.id,
        'Cancel me',
        controller.signal,
      );

      expect(result.response).toBe('');

      const updated = await agentRepo.findOneBy({ id: agent.id });
      expect(updated?.status).toBe(AgentStatus.Idle);
    } finally {
      await auditRepo.delete({ agentId: agent.id });
      await agentRepo.delete({ id: agent.id });
    }
  });
});
