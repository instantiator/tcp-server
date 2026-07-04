import { FakeListChatModel } from '@langchain/core/utils/testing';
import {
  AgentStatus,
  AuditEventType,
  CONTEXT_AUDIT_SINK,
  CONTEXT_EVENT_SINK,
  ContextBudgetService,
  ContextCompactorService,
  ContextManagerService,
  IncomingDataGuardService,
  LcpAgent,
  LcpCompany,
  LcpRole,
} from '@lcp/shared';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentEventPublisherService } from '../../../apps/lcp-agent/src/agent/agent-event-publisher.service';
import { AgentLoopService } from '../../../apps/lcp-agent/src/agent/agent-loop.service';
import { AuditClientService } from '@lcp/shared';
import * as factory from '../../../apps/lcp-agent/src/llm/llm-factory';
import { McpClientService } from '../../../apps/lcp-agent/src/mcp/mcp-client.service';
import { AgentRagService } from '../../../apps/lcp-agent/src/rag/agent-rag.service';
import { StorageTrackingClientService } from '../../../apps/lcp-agent/src/storage-tracking/storage-tracking-client.service';

// Requires DOCKER services: PostgreSQL (DATABASE_URL).
// Run via: ./scripts/run-integration-tests.sh

const ALL_ENTITIES = [LcpCompany, LcpRole, LcpAgent];

const dbUrl = process.env.DATABASE_URL;

const describeIf = dbUrl ? describe : describe.skip;

describeIf('AgentLoopService (integration)', () => {
  let module: TestingModule;
  let service: AgentLoopService;
  let companyRepo: Repository<LcpCompany>;
  let roleRepo: Repository<LcpRole>;
  let agentRepo: Repository<LcpAgent>;
  let auditRecord: jest.Mock;

  beforeAll(async () => {
    auditRecord = jest.fn();

    module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'postgres',
          url: dbUrl,
          entities: ALL_ENTITIES,
          synchronize: true,
        }),
        TypeOrmModule.forFeature(ALL_ENTITIES),
      ],
      providers: [
        AgentLoopService,
        {
          provide: AuditClientService,
          useValue: { record: auditRecord, notifyComplete: jest.fn() },
        },
        {
          provide: AgentRagService,
          useValue: { retrieve: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: McpClientService,
          useValue: { loadTools: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: StorageTrackingClientService,
          useValue: { patch: jest.fn() },
        },
        {
          provide: AgentEventPublisherService,
          useValue: { publish: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue(undefined),
            getOrThrow: () => dbUrl,
          },
        },
        // Real context-management wiring (mirrors AgentWorkerModule) so this
        // integration spec exercises the actual budget-check/compaction path,
        // not a pass-through mock.
        ContextBudgetService,
        ContextCompactorService,
        IncomingDataGuardService,
        {
          provide: CONTEXT_EVENT_SINK,
          useFactory: (publisher: AgentEventPublisherService) => ({
            emit: (agentId: string, event: unknown) =>
              publisher.publish(agentId as never, event as never),
          }),
          inject: [AgentEventPublisherService],
        },
        { provide: CONTEXT_AUDIT_SINK, useExisting: AuditClientService },
        ContextManagerService,
      ],
    }).compile();

    jest.spyOn(factory, 'buildChatModel').mockReturnValue(
      new FakeListChatModel({
        responses: ['Integration test response from stub LLM.'],
      }),
    );

    service = module.get(AgentLoopService);
    companyRepo = module.get(getRepositoryToken(LcpCompany));
    roleRepo = module.get(getRepositoryToken(LcpRole));
    agentRepo = module.get(getRepositoryToken(LcpAgent));
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await module.close();
  });

  // Use DELETE (not TRUNCATE) to avoid PostgreSQL FK constraint errors.
  // beforeEach ensures a clean slate even when a previous run failed mid-cleanup.
  async function cleanDb() {
    await agentRepo.createQueryBuilder().delete().execute();
    await roleRepo.createQueryBuilder().delete().execute();
    await companyRepo.createQueryBuilder().delete().execute();
  }

  beforeEach(cleanDb);
  afterEach(cleanDb);

  async function seedAgentAndRole() {
    const company = await companyRepo.save(
      companyRepo.create({
        slug: 'test-co',
        name: 'Test Co',
        description: 'Test company',
      }),
    );
    const role = await roleRepo.save(
      roleRepo.create({
        companyId: company.id,
        name: 'Analyst',
        description: 'Analyses things.',
        llmConfig: {
          provider: 'lm-studio',
          model: 'test-model',
          baseUrl: 'http://127.0.0.1:1/v1',
          apiKey: process.env['LM_STUDIO_API_KEY'],
        },
        systemPromptTemplate: 'You are {{name}} as of {{date}}.',
      }),
    );
    const agent = await agentRepo.save(
      agentRepo.create({
        companyId: company.id,
        roleId: role.id,
        initialPrompt: 'Summarise what you can do.',
      }),
    );
    return { company, role, agent };
  }

  it('runs to Completed and fires LlmRequest + LlmResponse audit events', async () => {
    const { company, role, agent } = await seedAgentAndRole();

    await service.run(agent.id, undefined, new AbortController());

    const updated = await agentRepo.findOneByOrFail({ id: agent.id });
    expect(updated.status).toBe(AgentStatus.Completed);
    expect(updated.threadId).toBe(agent.id);

    expect(auditRecord).toHaveBeenCalledWith(
      company.id,
      role.name,
      agent.id,
      AuditEventType.LlmRequest,
      expect.any(Object),
    );
    expect(auditRecord).toHaveBeenCalledWith(
      company.id,
      role.name,
      agent.id,
      AuditEventType.LlmResponse,
      expect.any(Object),
    );
  }, 30_000);

  it('uses company llmDefault when role.llmConfig is absent', async () => {
    const company = await companyRepo.save(
      companyRepo.create({
        slug: 'default-llm',
        name: 'Default LLM Co',
        description: 'Default company',
        llmDefault: {
          provider: 'lm-studio',
          model: 'test-model',
          baseUrl: 'http://127.0.0.1:1/v1',
          apiKey: process.env['LM_STUDIO_API_KEY'],
        },
      }),
    );
    const role = await roleRepo.save(
      roleRepo.create({
        companyId: company.id,
        name: 'Inheritor',
        description: 'Uses company default.',
        systemPromptTemplate: 'You are {{name}}.',
      }),
    );
    const agent = await agentRepo.save(
      agentRepo.create({
        companyId: company.id,
        roleId: role.id,
        initialPrompt: 'Hello.',
      }),
    );

    await service.run(agent.id, undefined, new AbortController());

    const updated = await agentRepo.findOneByOrFail({ id: agent.id });
    expect(updated.status).toBe(AgentStatus.Completed);
  }, 30_000);

  it('compacts the checkpoint on resume when a tiny context window is exceeded, and still completes', async () => {
    const { company, role, agent } = await seedAgentAndRole();

    // First run: builds up real checkpoint history (system/role/task messages).
    await service.run(agent.id, undefined, new AbortController());
    const afterFirst = await agentRepo.findOneByOrFail({ id: agent.id });
    expect(afterFirst.status).toBe(AgentStatus.Completed);

    // Shrink the window so the existing checkpoint + a large reply now
    // exceeds the 80% trigger threshold, forcing Tier-1 trim on resume.
    await roleRepo.update(role.id, {
      llmConfig: { ...role.llmConfig, contextWindow: 50 },
    });
    await agentRepo.update(agent.id, { status: AgentStatus.Paused });

    await service.run(
      agent.id,
      'Consultation response: '.repeat(50),
      new AbortController(),
    );

    const afterResume = await agentRepo.findOneByOrFail({ id: agent.id });
    expect(afterResume.status).toBe(AgentStatus.Completed);

    expect(auditRecord).toHaveBeenCalledWith(
      company.id,
      role.name,
      agent.id,
      AuditEventType.Decision,
      expect.objectContaining({ event: 'compaction_triggered' }),
    );
    expect(auditRecord).toHaveBeenCalledWith(
      company.id,
      role.name,
      agent.id,
      AuditEventType.Decision,
      expect.objectContaining({ event: 'compaction_complete' }),
    );
  }, 30_000);

  it('resumes from a Paused state, restoring the LangGraph checkpoint', async () => {
    const { agent } = await seedAgentAndRole();

    // First run: creates checkpoint and completes
    await service.run(agent.id, undefined, new AbortController());
    const afterFirst = await agentRepo.findOneByOrFail({ id: agent.id });
    expect(afterFirst.status).toBe(AgentStatus.Completed);
    const threadIdAfterFirst = afterFirst.threadId;

    // Simulate a resume scenario
    await agentRepo.update(agent.id, { status: AgentStatus.Paused });

    // Second run: LangGraph restores the checkpoint for the same thread_id
    await service.run(agent.id, undefined, new AbortController());

    const afterSecond = await agentRepo.findOneByOrFail({ id: agent.id });
    expect(afterSecond.status).toBe(AgentStatus.Completed);
    expect(afterSecond.threadId).toBe(threadIdAfterFirst);
  }, 30_000);
});
