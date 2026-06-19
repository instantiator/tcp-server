import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import {
  AgentStatus,
  AuditEvent,
  LcpAgent,
  LcpCompany,
  LcpRole,
} from '@lcp/shared';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { AgentLoopService } from '../../src/agent/agent-loop.service';
import { AgentRegistryService } from '../../src/registry/agent-registry.service';
import { AgentWorkerService } from '../../src/worker/agent-worker.service';
import * as factory from '../../src/llm/llm-factory';

// Requires DOCKER services: PostgreSQL (DATABASE_URL) and Redis (REDIS_URL).
// Run via: ./scripts/run-integration-tests.sh

const ALL_ENTITIES = [LcpCompany, LcpRole, LcpAgent, AuditEvent];

const dbUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;

const describeIf = dbUrl && redisUrl ? describe : describe.skip;

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

describeIf('AgentWorkerService (integration)', () => {
  let module: TestingModule;
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
        AgentWorkerService,
        AgentLoopService,
        AgentRegistryService,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: (key: string) => {
              if (key === 'DATABASE_URL') return dbUrl;
              if (key === 'REDIS_URL') return redisUrl;
              throw new Error(`Unknown config key in test: ${key}`);
            },
          },
        },
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

  it('worker picks up a queued job and runs the agent to Completed', async () => {
    const company = await companyRepo.save(
      companyRepo.create({ slug: 'test-co', name: 'Test Co' }),
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
          apiKeyEnvVar: 'LM_STUDIO_API_KEY',
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
});
