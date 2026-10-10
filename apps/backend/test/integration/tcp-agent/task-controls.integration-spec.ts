import type { UUID } from 'crypto';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import {
  AgentStatus,
  AuditClientService,
  McpClientService,
  TcpAgent,
  TcpAssignment,
  TcpCompany,
  TcpNotification,
  TcpRole,
  TcpTask,
  type LlmConfig,
  type McpToolContext,
} from '@tcp/shared';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { ConflictException, INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import axios from 'axios';
import { Repository } from 'typeorm';
import { z } from 'zod';
import { AgentRegistryService } from '../../../apps/tcp-agent/src/registry/agent-registry.service';
import { AgentOrchestrationService } from '../../../apps/tcp-server/src/api/agent-orchestration.service';
import { AgentRecoveryService } from '../../../apps/tcp-server/src/api/agent-recovery.service';
import { SpendResumeService } from '../../../apps/tcp-server/src/api/spend-resume.service';
import { TaskControlService } from '../../../apps/tcp-server/src/api/task-control.service';
import { TaskService } from '../../../apps/tcp-server/src/api/task.service';
import { AppModule as TcpServerAppModule } from '../../../apps/tcp-server/src/app.module';
import { AppModule as TcpAgentAppModule } from '../../../apps/tcp-agent/src/app.module';
import { requireEnv } from '../../support/require-env';

const STUB_LLM_URL = requireEnv('STUB_LLM_URL');
const INTERNAL_API_KEY = requireEnv('INTERNAL_API_KEY');

/** Marks the planner prompt of the pause scenario (stays in its history). */
const PAUSE_MARKER = 'TASK-CONTROLS-PAUSE-MARKER';

/** Marks the planner prompt of the crash-recovery scenario. */
const RECOVER_MARKER = 'TASK-CONTROLS-RECOVER-MARKER';

/**
 * 000.04's task controls and failure reasons end to end, with the real
 * tcp-server and tcp-agent apps, the real BullMQ queue, Postgres and the stub
 * LLM:
 *
 * - a user pauses a running task: its agent stops after its current step,
 *   nothing but the task's resume restarts it, and the resumed agent carries
 *   on from its checkpoint;
 * - a provider that doesn't answer, and a local server that doesn't list the
 *   model, each fail the task within seconds with a plain reason — and tell
 *   its company with a notice;
 * - an agent a crash left `running` with no job is carried on by startup
 *   recovery, from its checkpoint (000.05).
 *
 * Modelled on `model-queue.integration-spec.ts`.
 *
 * Run via: ./scripts/run-integration-tests.sh
 */
describe('Task controls and failure reasons (stub LLM, real queue)', () => {
  let serverApp: INestApplication;
  let agentModuleRef: TestingModule;
  let tcpServerUrl: string;

  let companyRepo: Repository<TcpCompany>;
  let roleRepo: Repository<TcpRole>;
  let taskRepo: Repository<TcpTask>;
  let assignmentRepo: Repository<TcpAssignment>;
  let agentRepo: Repository<TcpAgent>;
  let notificationRepo: Repository<TcpNotification>;
  let taskService: TaskService;
  let controls: TaskControlService;
  let resumes: SpendResumeService;
  let orchestration: AgentOrchestrationService;
  let recovery: AgentRecoveryService;

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

  /** Resolves once the worker has no agent loop in flight (memory: integration teardown). */
  async function waitForNoRunningLoops(): Promise<void> {
    const registry = agentModuleRef.get(AgentRegistryService);
    await waitFor(() => Promise.resolve(registry.activeCount === 0), 60_000);
  }

  /** A free port, closed again: nothing will answer on it. */
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

  async function putStubConfig(config: unknown): Promise<void> {
    const res = await fetch(`${STUB_LLM_URL.replace('/v1', '')}/stub/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    if (!res.ok) {
      throw new Error(`PUT /stub/config failed: ${res.status}`);
    }
  }

  /** A harmless tool, so a turn can end without the planner finishing. */
  function noteTool(): DynamicStructuredTool {
    return new DynamicStructuredTool({
      name: 'tasks__note',
      description: 'Notes something down.',
      schema: z.object({}),
      func: () => Promise.resolve('Noted.'),
    });
  }

  /** A fake `tasks__create_plan` that plans nothing further: the planner just finishes. */
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
                prompt: 'never run',
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

  /** A company whose planner role uses `llmConfig`, and a started task for it. */
  async function startTask(
    llmConfig: LlmConfig,
    request: string,
  ): Promise<{ company: TcpCompany; task: TcpTask; plannerId: UUID }> {
    const company = await companyRepo.save(
      companyRepo.create({
        name: 'Task Controls Co',
        slug: `task-controls-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        description: 'For task-controls integration tests',
        llmConfig,
      }),
    );
    const role = await roleRepo.save(
      roleRepo.create({
        companyId: company.id,
        slug: 'planner',
        name: 'Planner',
        description: 'Plans',
        systemPromptTemplate: 'You are {{name}}.',
      }),
    );
    const task = await taskRepo.save(
      taskRepo.create({
        companyId: company.id,
        request,
        shortcode: `tc-${Date.now()}`,
        plannerRoleId: role.id,
        status: 'ready',
      }),
    );
    await taskService.start(task.id);
    const planner = await assignmentRepo.findOneByOrFail({
      taskId: task.id,
      mode: 'plan',
    });
    return { company, task, plannerId: planner.agentId as UUID };
  }

  beforeAll(async () => {
    const port = await getFreePort();
    tcpServerUrl = `http://127.0.0.1:${port}`;
    process.env.TCP_SERVER_URL = tcpServerUrl;

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
    notificationRepo = serverModuleRef.get(getRepositoryToken(TcpNotification));
    taskService = serverModuleRef.get(TaskService);
    controls = serverModuleRef.get(TaskControlService);
    resumes = serverModuleRef.get(SpendResumeService);
    orchestration = serverModuleRef.get(AgentOrchestrationService);
    recovery = serverModuleRef.get(AgentRecoveryService);

    agentModuleRef = await Test.createTestingModule({
      imports: [TcpAgentAppModule],
    })
      .overrideProvider(McpClientService)
      .useValue({
        loadTools: (
          _names: string[],
          _urls: Record<string, string>,
          context: McpToolContext,
        ) =>
          Promise.resolve([
            { serverName: 'tasks', toolName: 'note', tool: noteTool() },
            {
              serverName: 'tasks',
              toolName: 'create_plan',
              tool: createPlanTool(context.agentId as UUID),
            },
          ]),
      })
      .overrideProvider(AuditClientService)
      .useValue({
        notifyComplete: () => {},
        // The real failure path: tcp-server fails the assignment and task.
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
    await agentModuleRef.init();
  }, 60_000);

  afterAll(async () => {
    agentModuleRef.get(AgentRegistryService).abortAll('test teardown');
    await waitForNoRunningLoops();
    await agentModuleRef.close();
    await serverApp.close();
  });

  afterEach(async () => {
    await waitForNoRunningLoops();
    await notificationRepo.createQueryBuilder().delete().execute();
    await agentRepo.createQueryBuilder().delete().execute();
    await assignmentRepo.createQueryBuilder().delete().execute();
    await taskRepo.createQueryBuilder().delete().execute();
    await roleRepo.createQueryBuilder().delete().execute();
    await companyRepo.createQueryBuilder().delete().execute();
  });

  describe('a user pauses a running task', () => {
    beforeAll(async () => {
      // The planner's first turn only notes something down (slowly, so the
      // pause lands mid-call); its second makes the plan.
      await putStubConfig({
        minDelay: 300,
        maxDelay: 300,
        prompts: [
          {
            match: PAUSE_MARKER,
            mode: 'sequence',
            responses: [
              {
                text: 'Let me think about this carefully first.',
                tools: [{ tool: 'tasks__note', data: {} }],
              },
              {
                text: 'Planning now.',
                tools: [{ tool: 'tasks__create_plan', data: {} }],
              },
            ],
          },
        ],
        defaults: { mode: 'loop', responses: [{ text: 'fallback' }] },
      });
    });

    it('stops after the current step, refuses any other resume, and carries on when the task resumes', async () => {
      const { task, plannerId } = await startTask(
        {
          provider: 'openai-compatible',
          model: 'stub',
          baseUrl: STUB_LLM_URL,
          apiKey: 'test',
        },
        `${PAUSE_MARKER}: do the thing.`,
      );
      await waitFor(async () => {
        const agent = await agentRepo.findOneBy({ id: plannerId });
        return agent?.status === AgentStatus.Running;
      });

      await controls.pause(task.id, 'Ada');

      // The in-flight call finishes; the loop then stops at its next check.
      await waitFor(
        () =>
          Promise.resolve(
            agentModuleRef.get(AgentRegistryService).activeCount === 0,
          ),
        30_000,
      );
      const paused = await agentRepo.findOneByOrFail({ id: plannerId });
      expect(paused.status).toBe(AgentStatus.Paused);
      expect(paused.pauseReason).toBe('manual');
      expect((await taskRepo.findOneByOrFail({ id: task.id })).pausedBy).toBe(
        'Ada',
      );

      // A reply-style resume can't undo the user's pause.
      await expect(orchestration.resumeAgent(plannerId)).rejects.toBeInstanceOf(
        ConflictException,
      );

      await resumes.resumeTask(task.id);

      const planned = await waitFor(async () => {
        const fresh = await taskRepo.findOneByOrFail({ id: task.id });
        return fresh.status === 'in-progress' ? fresh : null;
      }, 30_000);
      expect(planned.pausedAt).toBeNull();
      await taskService.cancel(task.id);
    }, 90_000);
  });

  describe('a crash strands a running agent', () => {
    beforeAll(async () => {
      await putStubConfig({
        minDelay: 300,
        maxDelay: 300,
        prompts: [
          {
            match: RECOVER_MARKER,
            mode: 'sequence',
            responses: [
              {
                text: 'Let me think about this carefully first.',
                tools: [{ tool: 'tasks__note', data: {} }],
              },
              {
                text: 'Planning now.',
                tools: [{ tool: 'tasks__create_plan', data: {} }],
              },
            ],
          },
        ],
        defaults: { mode: 'loop', responses: [{ text: 'fallback' }] },
      });
    });

    it('carries the agent on from its checkpoint when recovery runs at boot', async () => {
      const { task, plannerId } = await startTask(
        {
          provider: 'openai-compatible',
          model: 'stub',
          baseUrl: STUB_LLM_URL,
          apiKey: 'test',
        },
        `${RECOVER_MARKER}: do the thing.`,
      );
      await waitFor(async () => {
        const agent = await agentRepo.findOneBy({ id: plannerId });
        return agent?.status === AgentStatus.Running;
      });

      // Stop the planner after its first step, so a checkpoint exists...
      await controls.pause(task.id, 'Ada');
      await waitForNoRunningLoops();

      // ...then leave the rows as a crash would: the agent believed running,
      // the task not paused, and no job left in the queue for either.
      await agentRepo.update(plannerId, {
        status: AgentStatus.Running,
        pauseReason: null,
        pausedAt: () => 'NULL',
      });
      await taskRepo.update(task.id, {
        pausedAt: () => 'NULL',
        pausedBy: () => 'NULL',
      });

      await recovery.recover();

      // The planner carries on, takes its second turn and makes the plan.
      await waitFor(async () => {
        const fresh = await taskRepo.findOneByOrFail({ id: task.id });
        return fresh.status === 'in-progress';
      }, 30_000);
      await taskService.cancel(task.id);
    }, 90_000);
  });

  describe('a model provider that cannot be used', () => {
    let listing: Server | undefined;

    afterEach(async () => {
      await new Promise<void>((resolve) =>
        listing ? listing.close(() => resolve()) : resolve(),
      );
      listing = undefined;
    });

    it('fails the task within seconds when nothing answers, and tells the company', async () => {
      const port = await getFreePort();
      const started = Date.now();
      const { company, task } = await startTask(
        {
          provider: 'lm-studio',
          model: 'qwen3',
          baseUrl: `http://127.0.0.1:${port}/v1`,
        },
        'Nothing is listening.',
      );

      const failed = await waitFor(async () => {
        const fresh = await taskRepo.findOneByOrFail({ id: task.id });
        return fresh.status === 'failed' ? fresh : null;
      }, 15_000);

      expect(Date.now() - started).toBeLessThan(15_000);
      expect(failed.failureReason).toBe(
        `The planner stopped. Couldn't connect to 127.0.0.1:${port}. Check it is running and the base URL is right, then start the task again.`,
      );
      const notices = await waitFor(async () => {
        const rows = await notificationRepo.findBy({ taskId: task.id });
        return rows.length > 0 ? rows : null;
      });
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({
        kind: 'task_failed',
        companyId: company.id,
      });
    }, 30_000);

    // LM Studio answers an unlisted model with whatever model is loaded.
    it('fails the task when the server does not list the model, before any LLM call', async () => {
      listing = createHttpServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'some-other-model' }] }));
      });
      await new Promise<void>((resolve) => listing!.listen(0, resolve));
      const { port } = listing.address() as AddressInfo;

      const { task } = await startTask(
        {
          provider: 'lm-studio',
          model: 'no-such-model',
          baseUrl: `http://127.0.0.1:${port}/v1`,
        },
        'Use a model the server does not have.',
      );

      const failed = await waitFor(async () => {
        const fresh = await taskRepo.findOneByOrFail({ id: task.id });
        return fresh.status === 'failed' ? fresh : null;
      }, 15_000);
      expect(failed.failureReason).toContain(
        "The model 'no-such-model' wasn't found",
      );
    }, 30_000);
  });
});
