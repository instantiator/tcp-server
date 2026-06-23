import { FakeListChatModel } from '@langchain/core/utils/testing';
import {
  AgentStatus,
  AuditEvent,
  AuditEventType,
  LcpAgent,
  LcpCompany,
  LcpRole,
} from '@lcp/shared';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentLoopService } from '../../../apps/lcp-agent/src/agent/agent-loop.service';
import * as factory from '../../../apps/lcp-agent/src/llm/llm-factory';
import { AgentRegistryService } from '../../../apps/lcp-agent/src/registry/agent-registry.service';

// Requires DOCKER services: PostgreSQL (DATABASE_URL).
// Run via: ./scripts/run-integration-tests.sh

const ALL_ENTITIES = [LcpCompany, LcpRole, LcpAgent, AuditEvent];

const dbUrl = process.env.DATABASE_URL;

const describeIf = dbUrl ? describe : describe.skip;

describeIf('AgentLoopService (integration)', () => {
  let module: TestingModule;
  let service: AgentLoopService;
  let companyRepo: Repository<LcpCompany>;
  let roleRepo: Repository<LcpRole>;
  let agentRepo: Repository<LcpAgent>;
  let auditRepo: Repository<AuditEvent>;

  beforeAll(async () => {
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
        AgentRegistryService,
        {
          provide: ConfigService,
          useValue: { getOrThrow: () => dbUrl },
        },
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
    auditRepo = module.get(getRepositoryToken(AuditEvent));
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await module.close();
  });

  // Use DELETE (not TRUNCATE) to avoid PostgreSQL FK constraint errors.
  // beforeEach ensures a clean slate even when a previous run failed mid-cleanup.
  async function cleanDb() {
    await auditRepo.createQueryBuilder().delete().execute();
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

  it('runs to Completed and writes an LlmResponse audit event', async () => {
    const { company, role, agent } = await seedAgentAndRole();

    await service.run(agent.id);

    const updated = await agentRepo.findOneByOrFail({ id: agent.id });
    expect(updated.status).toBe(AgentStatus.Completed);
    expect(updated.threadId).toBe(agent.id);

    const allEvents = await auditRepo.findBy({ agentId: agent.id });

    const requestEvent = allEvents.find(
      (e) => e.eventType === AuditEventType.LlmRequest,
    );
    const responseEvent = allEvents.find(
      (e) => e.eventType === AuditEventType.LlmResponse,
    );

    expect(requestEvent).not.toBeNull();
    expect(responseEvent).not.toBeNull();

    for (const event of [requestEvent!, responseEvent!]) {
      expect(event.companyId).toBe(company.id);
      expect(event.agentId).toBe(agent.id);
      expect(event.role).toBe(role.name);
    }
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

    await service.run(agent.id);

    const updated = await agentRepo.findOneByOrFail({ id: agent.id });
    expect(updated.status).toBe(AgentStatus.Completed);
  }, 30_000);

  it('resumes from a Paused state, restoring the LangGraph checkpoint', async () => {
    const { agent } = await seedAgentAndRole();

    // First run: creates checkpoint and completes
    await service.run(agent.id);
    const afterFirst = await agentRepo.findOneByOrFail({ id: agent.id });
    expect(afterFirst.status).toBe(AgentStatus.Completed);
    const threadIdAfterFirst = afterFirst.threadId;

    // Simulate a resume scenario
    await agentRepo.update(agent.id, { status: AgentStatus.Paused });

    // Second run: LangGraph restores the checkpoint for the same thread_id
    await service.run(agent.id);

    const afterSecond = await agentRepo.findOneByOrFail({ id: agent.id });
    expect(afterSecond.status).toBe(AgentStatus.Completed);
    expect(afterSecond.threadId).toBe(threadIdAfterFirst);
  }, 30_000);
});
