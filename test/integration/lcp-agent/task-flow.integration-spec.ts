import type { UUID } from 'crypto';
import { createServer, type AddressInfo } from 'node:net';
import {
  AgentStatus,
  AuditClientService,
  LcpAgent,
  LcpAssignment,
  LcpCompany,
  LcpRole,
  LcpTask,
  McpClientService,
} from '@lcp/shared';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import axios from 'axios';
import { DataSource, Repository } from 'typeorm';
import { z } from 'zod';
import { AgentLoopService } from '../../../apps/lcp-agent/src/agent/agent-loop.service';
import { AppModule as LcpAgentAppModule } from '../../../apps/lcp-agent/src/app.module';
import { AppModule as LcpServerAppModule } from '../../../apps/lcp-server/src/app.module';
import { requireEnv } from '../../support/require-env';

const STUB_LLM_URL = requireEnv('STUB_LLM_URL');
const INTERNAL_API_KEY = requireEnv('INTERNAL_API_KEY');

/**
 * End-to-end coverage of a task/assignment run driven by the real agent loop
 * (`AgentLoopService`) against a stub LLM, exercising the real state machine:
 * the LangGraph `ToolNode` really dispatches the `complete_assignment` tool
 * call, and that tool really calls lcp-server's internal API (the same
 * `POST /internal/assignment/:id/complete` a live `lcp-mcp-tasks` container
 * would call) — only the MCP hop itself is faked, via a mocked
 * `McpClientService.loadTools`, to avoid standing up live MCP-server
 * containers. Both lcp-server and lcp-agent's real `AppModule`s run in this
 * process, against the integration tier's Postgres/Redis/MinIO/stub-llm.
 *
 * Run via: ./scripts/run-integration-tests.sh
 */
describe('Task/assignment flow via the agent loop (stub LLM)', () => {
  let serverApp: INestApplication;
  let agentModuleRef: TestingModule;
  let lcpServerUrl: string;
  let agentLoopService: AgentLoopService;
  let loadToolsMock: jest.Mock;

  let companyRepo: Repository<LcpCompany>;
  let roleRepo: Repository<LcpRole>;
  let taskRepo: Repository<LcpTask>;
  let assignmentRepo: Repository<LcpAssignment>;
  let agentRepo: Repository<LcpAgent>;

  let companyId: UUID;
  let roleId: UUID;

  // This is the only integration spec that boots lcp-server's real AppModule,
  // which runs migrations on startup (migrationsRun: true). The other specs
  // build their schema with `synchronize: true` on the shared tier database,
  // producing TypeORM's auto-generated constraint names rather than the
  // hand-named ones the migrations expect — so running migrations against that
  // shared, synchronize-built schema fails (e.g. dropping a constraint the
  // migration expects but synchronize never created). To stay order-independent
  // of those specs, this spec migrates its own throwaway database instead.
  let originalDatabaseUrl: string;
  let isolatedDbName: string;

  /** Polls `check` until it returns a truthy value, or throws after `timeoutMs`. */
  async function waitFor<T>(
    check: () => Promise<T | null | undefined | false>,
    timeoutMs = 10_000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = await check();
      if (result) return result;
      if (Date.now() >= deadline) {
        throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async function putStubConfig(config: unknown): Promise<void> {
    const res = await fetch(`${STUB_LLM_URL.replace('/v1', '')}/stub/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    if (!res.ok) {
      throw new Error(
        `PUT /stub/config failed: ${res.status} ${await res.text()}`,
      );
    }
  }

  /**
   * A fake `tasks__complete_assignment` MCP tool. Its `func` is what a live
   * `lcp-mcp-tasks` container's tool handler really does: call lcp-server's
   * internal completion endpoint — so calling it genuinely flips the
   * assignment/agent status in the database via the real `AssignmentService`.
   * `agentId` comes from the same `McpClientService.loadTools` context the
   * real client uses to inject identity (never from the model).
   */
  function completeAssignmentTool(
    assignmentId: UUID,
    agentId: UUID,
  ): DynamicStructuredTool {
    return new DynamicStructuredTool({
      name: 'tasks__complete_assignment',
      description: "Submits the agent's finished assignment.",
      schema: z.object({ summary: z.string() }),
      func: async ({ summary }: { summary: string }): Promise<string> => {
        await axios.post(
          `${lcpServerUrl}/internal/assignment/${assignmentId}/complete`,
          { agentId, summary, prepared: [] },
          { headers: { 'X-Internal-Api-Key': INTERNAL_API_KEY } },
        );
        return 'Assignment completed.';
      },
    });
  }

  /**
   * Grabs a free port synchronously (bind port 0, read it back, release it)
   * so `LCP_SERVER_URL` can be set correctly *before* any Nest module compiles.
   * `@nestjs/config`'s `ConfigService` resolves `.get()` from a Joi-validated
   * snapshot taken once at `ConfigModule.forRoot()` time, in preference to a
   * live `process.env` read — so overriding the env var only after lcp-server
   * (and its ephemeral port) already exists is too late for lcp-agent's own
   * `AuditClientService`/`StorageTrackingClientService`, which read it at
   * construction. Binding lcp-server to a pre-known port sidesteps that.
   */
  async function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const probe = createServer();
      probe.listen(0, () => {
        const { port } = probe.address() as AddressInfo;
        probe.close((err) => (err ? reject(err) : resolve(port)));
      });
      probe.on('error', reject);
    });
  }

  /**
   * Runs `sql` against the tier's shared database (the one in the ambient
   * `DATABASE_URL`), used to create and drop this spec's throwaway database —
   * `CREATE`/`DROP DATABASE` cannot run inside the target database itself.
   */
  async function withAdminConnection(
    databaseUrl: string,
    sql: string,
  ): Promise<void> {
    const admin = new DataSource({ type: 'postgres', url: databaseUrl });
    await admin.initialize();
    try {
      await admin.query(sql);
    } finally {
      await admin.destroy();
    }
  }

  beforeAll(async () => {
    const port = await getFreePort();
    lcpServerUrl = `http://127.0.0.1:${port}`;
    process.env.LCP_SERVER_URL = lcpServerUrl;

    // Point both AppModules at a freshly-created, empty database so lcp-server's
    // startup migrations run against a clean schema (see the note by
    // `isolatedDbName` above). Set DATABASE_URL before either module compiles —
    // @nestjs/config snapshots it once at ConfigModule.forRoot() time.
    originalDatabaseUrl = requireEnv('DATABASE_URL');
    isolatedDbName = `task_flow_${process.pid}`;
    await withAdminConnection(
      originalDatabaseUrl,
      `DROP DATABASE IF EXISTS "${isolatedDbName}" WITH (FORCE)`,
    );
    await withAdminConnection(
      originalDatabaseUrl,
      `CREATE DATABASE "${isolatedDbName}"`,
    );
    const isolatedUrl = new URL(originalDatabaseUrl);
    isolatedUrl.pathname = `/${isolatedDbName}`;
    process.env.DATABASE_URL = isolatedUrl.toString();

    // Boot lcp-server for real, listening on the port reserved above — the
    // fake MCP tool (and lcp-agent's own fire-and-forget audit/notify
    // clients) call it exactly as a live lcp-mcp-tasks/lcp-agent process would.
    const serverModuleRef = await Test.createTestingModule({
      imports: [LcpServerAppModule],
    }).compile();
    serverApp = serverModuleRef.createNestApplication();
    await serverApp.init();
    await serverApp.listen(port);

    companyRepo = serverModuleRef.get(getRepositoryToken(LcpCompany));
    roleRepo = serverModuleRef.get(getRepositoryToken(LcpRole));
    taskRepo = serverModuleRef.get(getRepositoryToken(LcpTask));
    assignmentRepo = serverModuleRef.get(getRepositoryToken(LcpAssignment));
    agentRepo = serverModuleRef.get(getRepositoryToken(LcpAgent));

    // lcp-agent's real AppModule (worker wiring, context management, the
    // agent loop itself) — only McpClientService is swapped for a mock, so
    // the "MCP round trip" is a direct call into the fake tool above instead
    // of a live MCP-server container. AuditClientService is also swapped: it
    // reads LCP_SERVER_URL from a Joi-validated env snapshot @nestjs/config
    // takes once at ConfigModule.forRoot() time, which doesn't reliably pick
    // up a same-process env override made after an earlier module (here,
    // lcp-server's own) already triggered that validation — so its
    // fire-and-forget calls are re-pointed at the real `lcpServerUrl` directly.
    loadToolsMock = jest.fn();
    agentModuleRef = await Test.createTestingModule({
      imports: [LcpAgentAppModule],
    })
      .overrideProvider(McpClientService)
      .useValue({ loadTools: loadToolsMock })
      .overrideProvider(AuditClientService)
      .useValue({
        notifyComplete: () => {},
        notifyFailed: (agentId: UUID, reason: string) => {
          void axios.post(
            `${lcpServerUrl}/internal/agent/${agentId}/fail`,
            { reason },
            { headers: { 'X-Internal-Api-Key': INTERNAL_API_KEY } },
          );
        },
        record: () => {},
      })
      .compile();
    // A bare .compile() never fires lifecycle hooks (unlike a full Nest
    // application) — without .init(), AgentWorkerService.onModuleInit never
    // creates its BullMQ worker, so its onModuleDestroy later crashes on
    // that still-undefined worker when the module closes.
    await agentModuleRef.init();
    agentLoopService = agentModuleRef.get(AgentLoopService, { strict: false });

    const company = await companyRepo.save(
      companyRepo.create({
        name: 'Task Flow Integration Co',
        slug: `task-flow-co-${Date.now()}`,
        description: 'For agent-loop integration tests',
        llmConfig: {
          provider: 'lm-studio',
          model: 'stub',
          baseUrl: STUB_LLM_URL,
        },
      }),
    );
    companyId = company.id;

    const role = await roleRepo.save(
      roleRepo.create({
        companyId,
        slug: 'implementer',
        name: 'implementer',
        description: 'Implements assignments',
        systemPromptTemplate: 'You are {{name}}, an implementer.',
      }),
    );
    roleId = role.id;
  });

  afterAll(async () => {
    await taskRepo.delete({ companyId });
    await assignmentRepo.delete({ companyId });
    await roleRepo.delete({ id: roleId });
    await companyRepo.delete({ id: companyId });
    // Both modules open their own DB/Redis/BullMQ connections — closing only
    // serverApp leaves lcp-agent's side open, which stalls Jest's exit.
    await agentModuleRef.close();
    await serverApp.close();

    // Restore the shared DATABASE_URL for any later spec in this worker, then
    // drop this spec's throwaway database now that both apps have released it.
    process.env.DATABASE_URL = originalDatabaseUrl;
    await withAdminConnection(
      originalDatabaseUrl,
      `DROP DATABASE IF EXISTS "${isolatedDbName}" WITH (FORCE)`,
    );
  });

  it('completes an orphan implement assignment when the agent calls complete_assignment', async () => {
    await putStubConfig({
      prompts: [
        {
          match: 'OK-TASK-DONE',
          mode: 'loop',
          responses: [
            {
              text: 'Completing now.',
              tools: [
                {
                  tool: 'tasks__complete_assignment',
                  data: { summary: 'Done: task complete.' },
                },
              ],
            },
          ],
        },
      ],
    });

    const assignment = await assignmentRepo.save(
      assignmentRepo.create({
        taskId: null,
        companyId,
        roleId,
        mode: 'implement',
        prompt: 'Return the exact text OK-TASK-DONE as your summary.',
        status: 'in-progress',
      }),
    );
    const agent = await agentRepo.save(
      agentRepo.create({
        companyId,
        roleId,
        assignmentId: assignment.id,
        status: AgentStatus.Idle,
        // Real dispatch (TaskOrchestrationService.dispatchAgentFor) copies the
        // assignment's prompt here — AgentLoopService's first turn reads
        // *this* field, not assignment.prompt, as the "already
        // context-prepared" prompt text (see its buildInitialState).
        initialPrompt: assignment.prompt,
      }),
    );
    await assignmentRepo.update(assignment.id, { agentId: agent.id });
    loadToolsMock.mockResolvedValue([
      {
        serverName: 'tasks',
        toolName: 'complete_assignment',
        tool: completeAssignmentTool(assignment.id, agent.id),
      },
    ]);

    try {
      await agentLoopService.run(agent.id, undefined, new AbortController());

      const finishedAgent = await agentRepo.findOneBy({ id: agent.id });
      expect(finishedAgent?.status).toBe(AgentStatus.Completed);

      const finishedAssignment = await assignmentRepo.findOneBy({
        id: assignment.id,
      });
      expect(finishedAssignment?.status).toBe('succeeded');
      expect(finishedAssignment?.summary).toBe('Done: task complete.');
    } finally {
      await agentRepo.delete({ id: agent.id });
      await assignmentRepo.delete({ id: assignment.id });
    }
  }, 30_000);

  it('fails a task-linked assignment when the agent never calls its required tool', async () => {
    await putStubConfig({
      defaults: {
        mode: 'loop',
        responses: [
          { text: "I'm thinking about it, no tool call yet.", tools: [] },
        ],
      },
    });

    const task = await taskRepo.save(
      taskRepo.create({
        companyId,
        request: 'A task whose implementer never finishes',
        shortcode: `flow-fail-${Date.now()}`,
        status: 'in-progress',
      }),
    );
    const assignment = await assignmentRepo.save(
      assignmentRepo.create({
        taskId: task.id,
        orderIndex: 0,
        companyId,
        roleId,
        mode: 'implement',
        prompt: 'This assignment is never actually completed by the agent.',
        status: 'in-progress',
      }),
    );
    const agent = await agentRepo.save(
      agentRepo.create({
        companyId,
        roleId,
        assignmentId: assignment.id,
        status: AgentStatus.Idle,
        initialPrompt: assignment.prompt,
      }),
    );
    await assignmentRepo.update(assignment.id, { agentId: agent.id });
    loadToolsMock.mockResolvedValue([
      {
        serverName: 'tasks',
        toolName: 'complete_assignment',
        tool: completeAssignmentTool(assignment.id, agent.id),
      },
    ]);

    try {
      await agentLoopService.run(agent.id, undefined, new AbortController());

      // failRun()'s server notification is fire-and-forget from lcp-agent's
      // side, so the assignment/task status flip can lag run() returning.
      // Poll the *task* specifically — handleAgentFailed transitions the
      // assignment (writing its own audit row) before failing the task, so
      // waiting for the task's status guarantees that whole chain has
      // settled — polling the assignment alone would race this test's own
      // cleanup below against the server's still-in-flight audit write.
      const failedTask = await waitFor(async () => {
        const found = await taskRepo.findOneBy({ id: task.id });
        return found?.status === 'failed' ? found : null;
      });
      expect(failedTask.status).toBe('failed');

      const failedAssignment = await assignmentRepo.findOneBy({
        id: assignment.id,
      });
      expect(failedAssignment?.status).toBe('failed');

      const failedAgent = await agentRepo.findOneBy({ id: agent.id });
      expect(failedAgent?.status).toBe(AgentStatus.Failed);
    } finally {
      await agentRepo.delete({ id: agent.id });
      await assignmentRepo.delete({ id: assignment.id });
      await taskRepo.delete({ id: task.id });
    }
  }, 30_000);
});
