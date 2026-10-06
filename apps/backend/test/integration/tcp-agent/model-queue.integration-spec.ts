import type { UUID } from 'crypto';
import { createServer, type AddressInfo } from 'node:net';
import {
  AgentStatus,
  AuditClientService,
  McpClientService,
  TcpAgent,
  TcpAssignment,
  TcpCompany,
  TcpRole,
  TcpTask,
  type McpToolContext,
} from '@tcp/shared';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import axios from 'axios';
import { Repository } from 'typeorm';
import { z } from 'zod';
import { InitialStateService } from '../../../apps/tcp-agent/src/agent/initial-state.service';
import { AgentRegistryService } from '../../../apps/tcp-agent/src/registry/agent-registry.service';
import { AppModule as TcpServerAppModule } from '../../../apps/tcp-server/src/app.module';
import { RateLimitResumeService } from '../../../apps/tcp-server/src/api/rate-limit-resume.service';
import { TaskService } from '../../../apps/tcp-server/src/api/task.service';
import { requireEnv } from '../../support/require-env';

const STUB_LLM_URL = requireEnv('STUB_LLM_URL');
const INTERNAL_API_KEY = requireEnv('INTERNAL_API_KEY');

/** The prompt every follow-on implement assignment carries. */
const IMPLEMENT_MARKER = 'IMPLEMENT-STEP-MODEL-QUEUE-MARKER';

/**
 * Whole-scenario coverage of 000.03's model-queue and rate-limit behaviour
 * with the real tcp-server and tcp-agent apps, the real BullMQ queue,
 * Postgres, and the stub LLM: a single local pool slot (`MODEL_CONCURRENCY`)
 * forces a second task's planner to wait its turn, and a hint-less 429 pauses
 * a run instead of failing it, auto-resuming it from its checkpoint once
 * `RateLimitResumeService.sweep()` finds it due.
 *
 * Modelled on `spend-cap.integration-spec.ts` (two real apps, real queue, fake
 * MCP tools calling the real internal endpoints) and `consultation-cycle
 * .integration-spec.ts` (nested `describe`s, each with its own fixtures,
 * under one shared app setup).
 *
 * Run via: ./scripts/run-integration-tests.sh
 */
describe('Model queue and rate-limit pause/resume across a task run (stub LLM, real queue)', () => {
  let serverApp: INestApplication;
  let agentModuleRef: TestingModule;
  let tcpServerUrl: string;
  let loadToolsMock: jest.Mock;

  let companyRepo: Repository<TcpCompany>;
  let roleRepo: Repository<TcpRole>;
  let taskRepo: Repository<TcpTask>;
  let assignmentRepo: Repository<TcpAssignment>;
  let agentRepo: Repository<TcpAgent>;
  let taskService: TaskService;
  let rateLimitResume: RateLimitResumeService;
  let initialState: InitialStateService;

  const internalHeaders = {
    headers: { 'X-Internal-Api-Key': INTERNAL_API_KEY },
  };

  /** Polls `check` until it returns a truthy value, or throws after `timeoutMs`. */
  async function waitFor<T>(
    check: () => Promise<T | null | undefined | false>,
    timeoutMs = 20_000,
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

  /** Waits for `agentId` to settle on `expected`, failing fast on another terminal status. */
  async function waitForAgentStatus(
    agentId: UUID,
    expected: AgentStatus,
    timeoutMs = 20_000,
  ): Promise<TcpAgent> {
    const settledElsewhere = [
      AgentStatus.Completed,
      AgentStatus.Failed,
      AgentStatus.Cancelled,
    ].filter((status) => status !== expected);

    return waitFor(async () => {
      const found = await agentRepo.findOneBy({ id: agentId });
      if (!found) return null;
      if (settledElsewhere.includes(found.status)) {
        throw new Error(
          `agent ${agentId} settled on ${found.status}, expected ${expected}. ` +
            `output: ${found.output ?? '(none)'}`,
        );
      }
      return found.status === expected ? found : null;
    }, timeoutMs);
  }

  /**
   * Resolves once the worker has no agent loop in flight. The database is not
   * enough: a cancelled agent's row says `cancelled` straight away, but its
   * loop runs on until its next status check — and deleting fixtures under a
   * live loop leaves it writing orphaned audit rows and holds Jest open.
   */
  async function waitForNoRunningLoops(): Promise<void> {
    const registry = agentModuleRef.get(AgentRegistryService);
    await waitFor(() => Promise.resolve(registry.activeCount === 0));
  }

  /**
   * Cancels `taskId` and waits for every agent it ever dispatched to settle.
   *
   * Each planner's `create_plan` call dispatches a follow-on implement agent
   * before this spec gets a chance to intervene — scripted here only to
   * finish quickly via {@link IMPLEMENT_MARKER}, not asserted on — so each
   * task is cancelled right after this spec's own assertions on it are done,
   * rather than left to finish on its own past the end of the test.
   */
  async function cancelTaskAndSettle(taskId: UUID): Promise<void> {
    await taskService.cancel(taskId);
    await waitForNoRunningLoops();
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
   * A fake `tasks__create_plan`. Its handler is what the live tcp-mcp-tasks
   * server's handler does: resolve the caller's own task (never an id the
   * model supplies) and `POST /internal/task/:taskId/plan` — a real plan
   * submission, creating one implement assignment carrying
   * {@link IMPLEMENT_MARKER}.
   */
  function createPlanTool(agentId: UUID): DynamicStructuredTool {
    return new DynamicStructuredTool({
      name: 'tasks__create_plan',
      description: 'Submits the plan for the task.',
      schema: z.object({}),
      func: async (): Promise<string> => {
        const { data } = await axios.get<{
          assignment: { taskId: UUID; roleId: UUID };
        }>(
          `${tcpServerUrl}/internal/agent/${agentId}/assignment`,
          internalHeaders,
        );
        await axios.post(
          `${tcpServerUrl}/internal/task/${data.assignment.taskId}/plan`,
          {
            agentId,
            assignments: [
              {
                prompt: IMPLEMENT_MARKER,
                role: data.assignment.roleId,
                expected: [],
              },
            ],
          },
          internalHeaders,
        );
        return 'Plan created.';
      },
    });
  }

  /**
   * A fake `tasks__complete_assignment`, resolving the caller's own
   * assignment the same way the real MCP tool does rather than being handed
   * an id the model never sees.
   */
  function completeAssignmentTool(agentId: UUID): DynamicStructuredTool {
    return new DynamicStructuredTool({
      name: 'tasks__complete_assignment',
      description: "Submits the agent's finished assignment.",
      schema: z.object({ summary: z.string() }),
      func: async ({ summary }: { summary: string }): Promise<string> => {
        const { data } = await axios.get<{ assignment: { id: UUID } }>(
          `${tcpServerUrl}/internal/agent/${agentId}/assignment`,
          internalHeaders,
        );
        await axios.post(
          `${tcpServerUrl}/internal/assignment/${data.assignment.id}/complete`,
          { agentId, summary, prepared: [] },
          internalHeaders,
        );
        return 'Assignment completed.';
      },
    });
  }

  /**
   * Grabs a free port synchronously so `TCP_SERVER_URL` is correct before any
   * Nest module compiles — see task-flow/consultation-cycle for why.
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

  beforeAll(async () => {
    const port = await getFreePort();
    tcpServerUrl = `http://127.0.0.1:${port}`;
    process.env.TCP_SERVER_URL = tcpServerUrl;
    // One local-pool slot, so a second concurrent run must queue. A short
    // retry so the rate-limit scenario doesn't wait out the real default.
    process.env.MODEL_CONCURRENCY = JSON.stringify({ local: 1 });
    process.env.RATE_LIMIT_RETRY_MS = '1000';
    // `ConfigModule.forRoot`'s Joi validation runs synchronously the moment
    // tcp-agent's `app.module` is evaluated — which a hoisted top-of-file
    // `import` would trigger before these lines ever ran. So both env vars
    // are set here first, and the module required afterwards (mirrors how
    // `spend-cap.integration-spec.ts` defers tcp-server's own import for
    // SPEND_CAPS; here it's tcp-agent's turn instead, since tcp-server reads
    // neither variable).
    /* eslint-disable @typescript-eslint/no-require-imports -- MODEL_CONCURRENCY/RATE_LIMIT_RETRY_MS must be set before app.module is evaluated, which a hoisted import would not allow */
    const { AppModule: TcpAgentAppModule } =
      require('../../../apps/tcp-agent/src/app.module') as typeof import('../../../apps/tcp-agent/src/app.module');
    /* eslint-enable @typescript-eslint/no-require-imports */

    const serverModuleRef = await Test.createTestingModule({
      imports: [TcpServerAppModule],
    }).compile();
    serverApp = serverModuleRef.createNestApplication();
    await serverApp.init();
    await serverApp.listen(port);

    companyRepo = serverModuleRef.get(getRepositoryToken(TcpCompany));
    roleRepo = serverModuleRef.get(getRepositoryToken(TcpRole));
    taskRepo = serverModuleRef.get(getRepositoryToken(TcpTask));
    assignmentRepo = serverModuleRef.get(getRepositoryToken(TcpAssignment));
    agentRepo = serverModuleRef.get(getRepositoryToken(TcpAgent));
    taskService = serverModuleRef.get(TaskService);
    rateLimitResume = serverModuleRef.get(RateLimitResumeService);

    loadToolsMock = jest.fn(
      (
        _names: string[],
        _urls: Record<string, string>,
        context: McpToolContext,
      ) => {
        const agentId = context.agentId as UUID;
        return Promise.resolve([
          {
            serverName: 'tasks',
            toolName: 'create_plan',
            tool: createPlanTool(agentId),
          },
          {
            serverName: 'tasks',
            toolName: 'complete_assignment',
            tool: completeAssignmentTool(agentId),
          },
        ]);
      },
    );

    agentModuleRef = await Test.createTestingModule({
      imports: [TcpAgentAppModule],
    })
      .overrideProvider(McpClientService)
      .useValue({ loadTools: loadToolsMock })
      .overrideProvider(AuditClientService)
      .useValue({
        notifyComplete: () => {},
        notifyFailed: (agentId: UUID, reason: string) => {
          axios
            .post(
              `${tcpServerUrl}/internal/agent/${agentId}/fail`,
              { reason },
              internalHeaders,
            )
            .catch(() => {});
        },
        record: () => {},
      })
      .compile();
    // Lifecycle hooks only fire on init — without it AgentWorkerService never
    // creates the BullMQ worker this spec depends on.
    await agentModuleRef.init();
    initialState = agentModuleRef.get(InitialStateService);
  }, 60_000);

  afterAll(async () => {
    // Backstop: nothing may still be running when the fixtures go.
    agentModuleRef.get(AgentRegistryService).abortAll('test teardown');
    await waitForNoRunningLoops();
    // Both modules hold their own DB/Redis/BullMQ connections; closing one
    // leaves the other's open and stalls Jest's exit.
    await agentModuleRef.close();
    await serverApp.close();
    delete process.env.MODEL_CONCURRENCY;
    delete process.env.RATE_LIMIT_RETRY_MS;
  });

  describe('a full local pool queues a second task, which runs once the first frees it', () => {
    let companyId: UUID;
    let roleId: UUID;

    /** Marks the prompt that starts task A's planner (stays in its history). */
    const TASK_A_MARKER = 'TASK-A-QUEUE-MARKER';
    /** Marks the prompt that starts task B's planner. */
    const TASK_B_MARKER = 'TASK-B-QUEUE-MARKER';

    beforeAll(async () => {
      const company = await companyRepo.save(
        companyRepo.create({
          name: 'Model Queue Integration Co',
          slug: `model-queue-co-${Date.now()}`,
          description: 'For model-queue integration tests',
          llmConfig: {
            provider: 'openai-compatible',
            model: 'stub',
            baseUrl: STUB_LLM_URL,
            apiKey: 'test',
          },
        }),
      );
      companyId = company.id;

      const role = await roleRepo.save(
        roleRepo.create({
          companyId,
          slug: 'queue-role',
          name: 'Planner',
          description: 'Plans for the model-queue scenario',
          systemPromptTemplate: 'You are {{name}}.',
        }),
      );
      roleId = role.id;

      // A fixed per-word delay gives each real (non-refusal) response a
      // predictable, observable duration — long enough to see task B queue
      // and task A still running, short enough to keep the test quick.
      await putStubConfig({
        minDelay: 2500,
        maxDelay: 2500,
        prompts: [
          {
            match: IMPLEMENT_MARKER,
            mode: 'loop',
            responses: [
              {
                text: 'Implementing.',
                tools: [
                  {
                    tool: 'tasks__complete_assignment',
                    data: { summary: 'Implemented.' },
                  },
                ],
              },
            ],
          },
          {
            match: TASK_B_MARKER,
            mode: 'loop',
            responses: [
              {
                text: 'Planning now.',
                tools: [{ tool: 'tasks__create_plan', data: {} }],
              },
            ],
          },
          {
            match: TASK_A_MARKER,
            mode: 'loop',
            responses: [
              {
                text: 'Working on it.',
                tools: [{ tool: 'tasks__create_plan', data: {} }],
              },
            ],
          },
        ],
        defaults: {
          mode: 'loop',
          responses: [
            { text: 'stub-llm fallback: no rule matched this prompt' },
          ],
        },
      });
    }, 60_000);

    afterAll(async () => {
      await agentRepo.createQueryBuilder().delete().execute();
      await assignmentRepo.createQueryBuilder().delete().execute();
      await taskRepo.delete({ companyId });
      await roleRepo.delete({ id: roleId });
      await companyRepo.delete({ id: companyId });
    });

    it('queues task B’s planner while task A holds the only local slot, then runs it without waiting the 30s fallback', async () => {
      const taskA = await taskRepo.save(
        taskRepo.create({
          companyId,
          request: `${TASK_A_MARKER}: do the thing.`,
          shortcode: `model-queue-a-${Date.now()}`,
          plannerRoleId: roleId,
          status: 'ready',
        }),
      );
      await taskService.start(taskA.id);
      const plannerA = await assignmentRepo.findOneByOrFail({
        taskId: taskA.id,
        mode: 'plan',
      });
      const plannerAId = plannerA.agentId as UUID;

      // Gate task B's start on task A having actually claimed the pool's one
      // slot, so B is guaranteed to find it full rather than racing for it.
      await waitForAgentStatus(plannerAId, AgentStatus.Running);

      const taskB = await taskRepo.save(
        taskRepo.create({
          companyId,
          request: `${TASK_B_MARKER}: do another thing.`,
          shortcode: `model-queue-b-${Date.now()}`,
          plannerRoleId: roleId,
          status: 'ready',
        }),
      );
      await taskService.start(taskB.id);
      const plannerB = await assignmentRepo.findOneByOrFail({
        taskId: taskB.id,
        mode: 'plan',
      });
      const plannerBId = plannerB.agentId as UUID;

      // --- B queues behind the full pool, A keeps running ----------------
      await waitForAgentStatus(plannerBId, AgentStatus.Queued, 5_000);
      const stillA = await agentRepo.findOneByOrFail({ id: plannerAId });
      expect(stillA.status).toBe(AgentStatus.Running);

      // --- A finishes and frees the slot -----------------------------------
      await waitForAgentStatus(plannerAId, AgentStatus.Completed);

      // --- B is promoted straight away, not after the 30s recheck ---------
      // Cancelling A here would wait on the registry's *global* active
      // count, which B's own run also holds — racing this assertion against
      // that wait instead of against B's actual promotion. So both tasks are
      // only cancelled once B's run has been observed directly, below.
      await waitForAgentStatus(plannerBId, AgentStatus.Running, 10_000);
      await waitForAgentStatus(plannerBId, AgentStatus.Completed);

      // Both plans' own assertions are done — cancel their create_plan-
      // spawned implement agents so neither is still running when the suite
      // tears down.
      await cancelTaskAndSettle(taskA.id);
      await cancelTaskAndSettle(taskB.id);
    }, 90_000);
  });

  describe('a hint-less rate limit pauses the run, which resumes from its checkpoint once due', () => {
    let companyId: UUID;
    let roleId: UUID;

    /** Marks the task's opening prompt — matches only the refused first call. */
    const RATE_MARKER = 'RATE-LIMIT-TASK-MARKER';
    /**
     * Only ever appears in `AgentOrchestrationService`'s
     * `RATE_LIMIT_RESUME_PROMPT` — matching on it proves the planner's
     * completion was seen *after* a real resume, not on its refused first
     * attempt. Listed ahead of {@link RATE_MARKER} below: a resumed call's
     * history still carries the original marker text too.
     */
    const RESUME_MARKER = 'temporarily refusing requests';

    beforeAll(async () => {
      const company = await companyRepo.save(
        companyRepo.create({
          name: 'Rate Limit Integration Co',
          slug: `rate-limit-co-${Date.now()}`,
          description: 'For rate-limit integration tests',
          llmConfig: {
            provider: 'openai-compatible',
            model: 'stub',
            baseUrl: STUB_LLM_URL,
            apiKey: 'test',
          },
        }),
      );
      companyId = company.id;

      const role = await roleRepo.save(
        roleRepo.create({
          companyId,
          slug: 'rate-limit-role',
          name: 'Planner',
          description: 'Plans for the rate-limit scenario',
          systemPromptTemplate: 'You are {{name}}.',
        }),
      );
      roleId = role.id;

      await putStubConfig({
        prompts: [
          {
            match: RESUME_MARKER,
            mode: 'loop',
            responses: [
              {
                text: 'Continuing after the pause.',
                tools: [{ tool: 'tasks__create_plan', data: {} }],
              },
            ],
          },
          {
            match: IMPLEMENT_MARKER,
            mode: 'loop',
            responses: [
              {
                text: 'Implementing.',
                tools: [
                  {
                    tool: 'tasks__complete_assignment',
                    data: { summary: 'Implemented.' },
                  },
                ],
              },
            ],
          },
          {
            match: RATE_MARKER,
            mode: 'loop',
            responses: [
              // No `retryAfter`: LangChain throws this 429 immediately
              // instead of retrying it itself, so it reaches the pause.
              { text: '', refusal: { status: 429 } },
            ],
          },
        ],
        defaults: {
          mode: 'loop',
          responses: [
            { text: 'stub-llm fallback: no rule matched this prompt' },
          ],
        },
      });
    }, 60_000);

    afterAll(async () => {
      await agentRepo.createQueryBuilder().delete().execute();
      await assignmentRepo.createQueryBuilder().delete().execute();
      await taskRepo.delete({ companyId });
      await roleRepo.delete({ id: roleId });
      await companyRepo.delete({ id: companyId });
    });

    it('pauses rate_limited instead of failing, then resumes and completes without rebuilding the initial state', async () => {
      const initialStateBuildSpy = jest.spyOn(initialState, 'build');

      const task = await taskRepo.save(
        taskRepo.create({
          companyId,
          request: `${RATE_MARKER}: do the thing.`,
          shortcode: `rate-limit-${Date.now()}`,
          plannerRoleId: roleId,
          status: 'ready',
        }),
      );
      await taskService.start(task.id);
      const planner = await assignmentRepo.findOneByOrFail({
        taskId: task.id,
        mode: 'plan',
      });
      const plannerId = planner.agentId as UUID;

      // --- the refused first call pauses the run, rather than failing it --
      const paused = await waitForAgentStatus(plannerId, AgentStatus.Paused);
      expect(paused.pauseReason).toBe('rate_limited');
      expect(paused.rateLimitRetries).toBe(1);
      expect(paused.status).not.toBe(AgentStatus.Failed);
      const pausedTask = await taskRepo.findOneByOrFail({ id: task.id });
      expect(pausedTask.status).not.toBe('failed');

      expect(paused.resumeAfter).toBeTruthy();
      const resumeAfter = new Date(paused.resumeAfter as Date).getTime();
      const pausedAt = new Date(paused.pausedAt as Date).getTime();
      // RATE_LIMIT_RETRY_MS=1000, first attempt: no doubling yet.
      expect(resumeAfter - pausedAt).toBeGreaterThan(500);
      expect(resumeAfter - pausedAt).toBeLessThan(5_000);

      // --- wait for resumeAfter, then resume via the real sweep -----------
      await waitFor(() => Promise.resolve(Date.now() >= resumeAfter), 10_000);
      await rateLimitResume.sweep();

      // --- the run continues from its checkpoint and completes -----------
      await waitForAgentStatus(plannerId, AgentStatus.Completed);

      // `build` assembles the full initial-state message list — only ever
      // needed for a fresh run. A resume injects the reply into the existing
      // checkpoint instead, so if this run truly continued rather than
      // restarted, `build` was never called a second time for this agent
      // (filtering by id, since the implement assignment `create_plan` just
      // dispatched is itself a fresh agent and legitimately calls `build`
      // once).
      const buildCallsForPlanner = initialStateBuildSpy.mock.calls.filter(
        (call) => call[0].id === plannerId,
      );
      expect(buildCallsForPlanner).toHaveLength(1);

      await cancelTaskAndSettle(task.id);
    }, 60_000);
  });
});
