import { FakeListChatModel } from '@langchain/core/utils/testing';
import {
  AgentStatus,
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
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { AgentEventPublisherService } from '../../../apps/lcp-agent/src/agent/agent-event-publisher.service';
import { AgentLoopService } from '../../../apps/lcp-agent/src/agent/agent-loop.service';
import { AuditClientService } from '@lcp/shared';
import * as factory from '../../../apps/lcp-agent/src/llm/llm-factory';
import { McpClientService } from '../../../apps/lcp-agent/src/mcp/mcp-client.service';
import { AgentRagService } from '../../../apps/lcp-agent/src/rag/agent-rag.service';
import { AgentRegistryService } from '../../../apps/lcp-agent/src/registry/agent-registry.service';
import { AgentWorkerService } from '../../../apps/lcp-agent/src/worker/agent-worker.service';
import { StorageTrackingClientService } from '../../../apps/lcp-agent/src/storage-tracking/storage-tracking-client.service';
import { requireEnv } from '../../support/require-env';

// PostgreSQL and Redis are provisioned by the integration global setup;
// DATABASE_URL and REDIS_URL are always present.
// Run via: ./scripts/run-integration-tests.sh

const ALL_ENTITIES = [LcpCompany, LcpRole, LcpAgent];

const dbUrl = requireEnv('DATABASE_URL');
const redisUrl = requireEnv('REDIS_URL');

async function pollUntil(
  check: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`pollUntil: timed out after ${timeoutMs}ms`);
}

describe('AgentWorkerService (integration)', () => {
  let module: TestingModule;
  let companyRepo: Repository<LcpCompany>;
  let roleRepo: Repository<LcpRole>;
  let agentRepo: Repository<LcpAgent>;

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
        AgentWorkerService,
        AgentLoopService,
        AgentRegistryService,
        {
          provide: AuditClientService,
          useValue: { record: jest.fn(), notifyComplete: jest.fn() },
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
            getOrThrow: (key: string) => {
              if (key === 'DATABASE_URL') return dbUrl;
              if (key === 'REDIS_URL') return redisUrl;
              throw new Error(`Unknown config key in test: ${key}`);
            },
          },
        },
        // Real context-management wiring (mirrors AgentWorkerModule).
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

    await module.init();

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

  it('worker picks up a queued job and runs the agent to Completed', async () => {
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
        slug: 'analyst',
        name: 'Analyst',
        description: 'Analyses things.',
        llmConfig: {
          provider: 'lm-studio',
          model: 'test-model',
          baseUrl: 'http://127.0.0.1:1/v1',
          apiKey: process.env['LM_STUDIO_API_KEY'],
        },
        systemPromptTemplate: 'You are {{name}}.',
      }),
    );
    const agent = await agentRepo.save(
      agentRepo.create({
        companyId: company.id,
        roleId: role.id,
        initialPrompt: 'Summarise what you can do.',
      }),
    );

    // Enqueue the job directly — the AgentWorkerService started by module.init() will pick it up
    const queue = new Queue('agent-jobs', { connection: { url: redisUrl } });
    await queue.add('agent-job', { agentId: agent.id, type: 'start' });
    await queue.close();

    await pollUntil(async () => {
      const a = await agentRepo.findOneBy({ id: agent.id });
      return a?.status === AgentStatus.Completed;
    }, 15_000);

    const updated = await agentRepo.findOneByOrFail({ id: agent.id });
    expect(updated.status).toBe(AgentStatus.Completed);
    expect(updated.threadId).toBe(agent.id);
  }, 20_000);

  it('two agents complete concurrently without cross-contaminating LangGraph state', async () => {
    const company = await companyRepo.save(
      companyRepo.create({
        slug: 'test-co-concurrent',
        name: 'Test Co (Concurrent)',
        description: 'Test company',
      }),
    );
    const role = await roleRepo.save(
      roleRepo.create({
        companyId: company.id,
        slug: 'analyst',
        name: 'Analyst',
        description: 'Analyses things.',
        llmConfig: {
          provider: 'lm-studio',
          model: 'test-model',
          baseUrl: 'http://127.0.0.1:1/v1',
          apiKey: process.env['LM_STUDIO_API_KEY'],
        },
        systemPromptTemplate: 'You are {{name}}.',
      }),
    );
    const [agentA, agentB] = await Promise.all([
      agentRepo.save(
        agentRepo.create({
          companyId: company.id,
          roleId: role.id,
          initialPrompt: 'Task A',
        }),
      ),
      agentRepo.save(
        agentRepo.create({
          companyId: company.id,
          roleId: role.id,
          initialPrompt: 'Task B',
        }),
      ),
    ]);

    const queue = new Queue('agent-jobs', { connection: { url: redisUrl } });
    await queue.add('agent-job', { agentId: agentA.id, type: 'start' });
    await queue.add('agent-job', { agentId: agentB.id, type: 'start' });
    await queue.close();

    await pollUntil(async () => {
      const [a, b] = await Promise.all([
        agentRepo.findOneBy({ id: agentA.id }),
        agentRepo.findOneBy({ id: agentB.id }),
      ]);
      return (
        a?.status === AgentStatus.Completed &&
        b?.status === AgentStatus.Completed
      );
    }, 20_000);

    const [updatedA, updatedB] = await Promise.all([
      agentRepo.findOneByOrFail({ id: agentA.id }),
      agentRepo.findOneByOrFail({ id: agentB.id }),
    ]);

    expect(updatedA.status).toBe(AgentStatus.Completed);
    expect(updatedB.status).toBe(AgentStatus.Completed);
    // Each agent must write to its own LangGraph thread, not the other's
    expect(updatedA.threadId).toBe(agentA.id);
    expect(updatedB.threadId).toBe(agentB.id);
  }, 30_000);
});
