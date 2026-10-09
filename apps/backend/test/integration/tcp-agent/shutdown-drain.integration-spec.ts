import { FakeListChatModel } from '@langchain/core/utils/testing';
import {
  AgentStatus,
  AuditClientService,
  CONTEXT_AUDIT_SINK,
  ContextBudgetService,
  ContextCompactorService,
  ContextManagerService,
  IncomingDataGuardService,
  KnowledgeRetrievalService,
  McpClientService,
  TcpAgent,
  TcpAssignment,
  TcpCompany,
  TcpRole,
  TcpTask,
  SpendCapState,
} from '@tcp/shared';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { UUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { AgentEventPublisherService } from '../../../apps/tcp-agent/src/agent/agent-event-publisher.service';
import { AgentLoopService } from '../../../apps/tcp-agent/src/agent/agent-loop.service';
import { InitialStateService } from '../../../apps/tcp-agent/src/agent/initial-state.service';
import { AgentLoopEventRecorder } from '../../../apps/tcp-agent/src/agent/loop-events.service';
import { AgentRunEnvironmentService } from '../../../apps/tcp-agent/src/agent/run-environment.service';
import { AgentRunStatusService } from '../../../apps/tcp-agent/src/agent/run-status.service';
import { SupervisedTurnService } from '../../../apps/tcp-agent/src/agent/supervised-turn.service';
import { SpendGateService } from '../../../apps/tcp-agent/src/agent/spend-gate.service';
import { AgentRagService } from '../../../apps/tcp-agent/src/rag/agent-rag.service';
import { StorageTrackingClientService } from '../../../apps/tcp-agent/src/storage-tracking/storage-tracking-client.service';
import * as factory from '@tcp/shared/llm/llm-factory';
import { requireEnv } from '../../support/require-env';

// PostgreSQL is provisioned by the integration global setup; DATABASE_URL is
// always present. Run via: ./scripts/run-integration-tests.sh

const ALL_ENTITIES = [
  TcpCompany,
  TcpRole,
  TcpAgent,
  TcpTask,
  TcpAssignment,
  // Read by SpendGateService before every LLM call; no cap state means no hold.
  SpendCapState,
];

const SHARED_DATABASE_URL = requireEnv('DATABASE_URL');

/**
 * This spec's own throwaway database, built with `synchronize: true`.
 *
 * Unlike its siblings, this spec cannot share the tier's migration-built
 * database: its `beforeEach`/`afterEach` truncate the agent, assignment, role
 * and company tables wholesale, which would take any other spec's fixtures
 * with them. Because the database is its own, `synchronize` is safe here —
 * nothing else ever runs migrations against it.
 */
const ISOLATED_DATABASE_URL = (() => {
  const url = new URL(SHARED_DATABASE_URL);
  url.pathname = `/shutdown_drain_${process.pid}`;
  return url.toString();
})();

/**
 * Runs one statement against the shared database.
 * `CREATE`/`DROP DATABASE` cannot run from inside the database they target.
 */
async function withAdminConnection(sql: string): Promise<void> {
  const admin = new DataSource({ type: 'postgres', url: SHARED_DATABASE_URL });
  await admin.initialize();
  try {
    await admin.query(sql);
  } finally {
    await admin.destroy();
  }
}

/** How long the stub LLM takes per streamed chunk. */
const CHUNK_DELAY_MS = 60;

/**
 * A response long enough that the run is unmistakably still mid-LLM-call when
 * the test pauses or aborts it — one chunk per character, at
 * {@link CHUNK_DELAY_MS} each.
 */
const SLOW_RESPONSE = 'A deliberately long stub response, streamed slowly.';

describe('Shutdown drain of a running agent loop (integration)', () => {
  let module: TestingModule;
  let service: AgentLoopService;
  let initialState: InitialStateService;
  let dataSource: DataSource;
  let companyRepo: Repository<TcpCompany>;
  let roleRepo: Repository<TcpRole>;
  let agentRepo: Repository<TcpAgent>;
  let assignmentRepo: Repository<TcpAssignment>;

  beforeAll(async () => {
    const dbName = new URL(ISOLATED_DATABASE_URL).pathname.slice(1);
    await withAdminConnection(
      `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`,
    );
    await withAdminConnection(`CREATE DATABASE "${dbName}"`);

    module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'postgres',
          url: ISOLATED_DATABASE_URL,
          entities: ALL_ENTITIES,
          synchronize: true,
        }),
        TypeOrmModule.forFeature(ALL_ENTITIES),
      ],
      providers: [
        AgentLoopService,
        AgentRunEnvironmentService,
        InitialStateService,
        AgentRunStatusService,
        AgentLoopEventRecorder,
        SupervisedTurnService,
        SpendGateService,
        {
          provide: AuditClientService,
          useValue: {
            record: jest.fn(),
            notifyComplete: jest.fn(),
            notifyFailed: jest.fn(),
          },
        },
        {
          provide: AgentRagService,
          useValue: { hasKnowledge: jest.fn().mockResolvedValue(false) },
        },
        {
          provide: KnowledgeRetrievalService,
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
            // The LangGraph checkpointer must land in the same throwaway
            // database as the entities it checkpoints.
            getOrThrow: () => ISOLATED_DATABASE_URL,
          },
        },
        ContextBudgetService,
        ContextCompactorService,
        IncomingDataGuardService,
        { provide: CONTEXT_AUDIT_SINK, useExisting: AuditClientService },
        ContextManagerService,
      ],
    }).compile();

    jest.spyOn(factory, 'buildChatModel').mockReturnValue(
      new FakeListChatModel({
        responses: [SLOW_RESPONSE, SLOW_RESPONSE],
        sleep: CHUNK_DELAY_MS,
      }),
    );

    service = module.get(AgentLoopService);
    initialState = module.get(InitialStateService);
    dataSource = module.get(DataSource);
    companyRepo = module.get(getRepositoryToken(TcpCompany));
    roleRepo = module.get(getRepositoryToken(TcpRole));
    agentRepo = module.get(getRepositoryToken(TcpAgent));
    assignmentRepo = module.get(getRepositoryToken(TcpAssignment));
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await module.close();
    const dbName = new URL(ISOLATED_DATABASE_URL).pathname.slice(1);
    await withAdminConnection(
      `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`,
    );
  });

  async function cleanDb() {
    await agentRepo.createQueryBuilder().delete().execute();
    await assignmentRepo.createQueryBuilder().delete().execute();
    await roleRepo.createQueryBuilder().delete().execute();
    await companyRepo.createQueryBuilder().delete().execute();
  }

  beforeEach(cleanDb);
  afterEach(cleanDb);

  async function seedAgent(): Promise<TcpAgent> {
    const company = await companyRepo.save(
      companyRepo.create({
        slug: 'drain-co',
        name: 'Drain Co',
        description: 'Shutdown integration company',
      }),
    );
    const role = await roleRepo.save(
      roleRepo.create({
        companyId: company.id,
        slug: 'drainee',
        name: 'Drainee',
        description: 'Runs until told to stop.',
        llmConfig: {
          provider: 'lm-studio',
          model: 'test-model',
          baseUrl: 'http://127.0.0.1:1/v1',
        },
        systemPromptTemplate: 'You are {{name}}.',
      }),
    );
    const assignment = await assignmentRepo.save(
      assignmentRepo.create({
        taskId: null,
        companyId: company.id,
        roleId: role.id,
        mode: 'implement',
        prompt: 'Keep working until told to stop.',
        status: 'in-progress',
      }),
    );
    return agentRepo.save(
      agentRepo.create({
        companyId: company.id,
        roleId: role.id,
        assignmentId: assignment.id,
        initialPrompt: 'Keep working until told to stop.',
        // Agents with no required tool calls end on narrated text, which keeps
        // this spec about the shutdown path rather than the reminder ladder.
        requiredToolCalls: [],
      }),
    );
  }

  /** Waits until the loop has recorded itself as running, so it is genuinely mid-call. */
  async function waitUntilRunning(agentId: UUID): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const agent = await agentRepo.findOneByOrFail({ id: agentId });
      if (agent.status === AgentStatus.Running) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Agent ${agentId} never reached Running`);
  }

  /** Applies the same write tcp-server's drain makes against a running agent. */
  async function markPausedForShutdown(agentId: UUID): Promise<void> {
    await agentRepo.update(agentId, {
      status: AgentStatus.Paused,
      pausedAt: new Date(),
      pauseReason: 'shutdown',
    });
  }

  /** Counts LangGraph checkpoint rows written for this agent's thread. */
  async function countCheckpoints(threadId: string): Promise<number> {
    const rows = await dataSource.query<{ count: number }[]>(
      'SELECT count(*)::int AS count FROM checkpoints WHERE thread_id = $1',
      [threadId],
    );
    return rows[0].count;
  }

  it('exits at the next boundary when the drain pauses it mid-run, leaving the checkpoint intact', async () => {
    const agent = await seedAgent();

    const run = service.run(agent.id, undefined, new AbortController());
    await waitUntilRunning(agent.id);
    await markPausedForShutdown(agent.id);
    await run;

    const settled = await agentRepo.findOneByOrFail({ id: agent.id });
    // The loop must accept the pause, not overwrite it with a completion or
    // report the interruption as a failure.
    expect(settled.status).toBe(AgentStatus.Paused);
    expect(settled.pauseReason).toBe('shutdown');
    expect(await countCheckpoints(agent.id)).toBeGreaterThan(0);
  }, 30_000);

  it('continues from the checkpoint on resume rather than rebuilding the opening prompt', async () => {
    const agent = await seedAgent();

    const run = service.run(agent.id, undefined, new AbortController());
    await waitUntilRunning(agent.id);
    await markPausedForShutdown(agent.id);
    await run;

    const checkpointsAfterPause = await countCheckpoints(agent.id);
    const build = jest.spyOn(initialState, 'build');

    // tcp-server's resume claims the pause (clears pausedAt) before it queues
    // the job; the loop won't start an agent whose pause is still live.
    await agentRepo.update(agent.id, {
      pausedAt: () => 'NULL',
      pauseReason: null,
    });
    // tcp-server resumes a shutdown-paused agent with a continuation message,
    // which is what tells the loop this is a resume and not a fresh run.
    await service.run(
      agent.id,
      'The system was shut down while you were working, and has now restarted. Continue from where you left off.',
      new AbortController(),
    );

    expect(build).not.toHaveBeenCalled();
    expect(await countCheckpoints(agent.id)).toBeGreaterThan(
      checkpointsAfterPause,
    );

    const resumed = await agentRepo.findOneByOrFail({ id: agent.id });
    expect(resumed.status).toBe(AgentStatus.Completed);
    build.mockRestore();
  }, 30_000);

  it('stops promptly on a forced abort, and leaves the agent resumable rather than failed', async () => {
    const agent = await seedAgent();
    const abortController = new AbortController();

    const startedAt = Date.now();
    const run = service.run(agent.id, undefined, abortController);
    await waitUntilRunning(agent.id);

    // Exactly what a forced drain does: tcp-server pauses the row, then
    // tcp-agent aborts the in-flight call rather than waiting for it.
    await markPausedForShutdown(agent.id);
    abortController.abort('forced shutdown');
    await run;
    const elapsed = Date.now() - startedAt;

    // The full response would take one chunk delay per character.
    expect(elapsed).toBeLessThan(SLOW_RESPONSE.length * CHUNK_DELAY_MS);

    const settled = await agentRepo.findOneByOrFail({ id: agent.id });
    expect(settled.status).toBe(AgentStatus.Paused);
    expect(settled.pauseReason).toBe('shutdown');
  }, 30_000);
});
