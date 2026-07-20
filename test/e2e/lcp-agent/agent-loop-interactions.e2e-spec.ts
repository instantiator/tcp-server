import type { UUID } from 'crypto';
import { readFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import {
  AuditClientService,
  LcpAgent,
  LcpAssignment,
  LcpCompany,
  LcpRole,
  LcpTask,
  McpClientService,
  assignmentWorkingKey,
} from '@lcp/shared';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import axios from 'axios';
import { Repository } from 'typeorm';
import { z } from 'zod';
import { AgentLoopService } from '../../../apps/lcp-agent/src/agent/agent-loop.service';
import { AppModule as LcpAgentAppModule } from '../../../apps/lcp-agent/src/app.module';
import { TaskService } from '../../../apps/lcp-server/src/api/task.service';
import { AppModule as LcpServerAppModule } from '../../../apps/lcp-server/src/app.module';
import { StorageService } from '../../../apps/lcp-server/src/storage/storage.service';
import { requireEnv } from '../../support/require-env';

const STUB_LLM_URL = requireEnv('STUB_LLM_URL');
const INTERNAL_API_KEY = requireEnv('INTERNAL_API_KEY');

const TERMINAL_TASK_STATUSES = ['succeeded', 'failed', 'cancelled'];

/** Shape of `fixtures/<flow>-setup.json` — static company/role/task seed data. */
interface FlowSetupFixture {
  company: { name: string; description: string };
  role: {
    slug: string;
    name: string;
    description: string;
    systemPromptTemplate?: string;
  };
  task: {
    request: string;
    expected?: { type: 'task-completed-path' | 'inline-text'; value: string }[];
  };
}

/**
 * End-to-end coverage of a *whole task* driven entirely through the real
 * agent loop: a planner produces a 2-step plan, each step is implemented and
 * QA'd, then a finalise agent runs — every turn answered by the stub LLM
 * (apps/lcp-stub-llm) from a scripted, sequenced fixture. Only the MCP hop is
 * faked (`McpClientService.loadTools`, resolved per-agent from its own
 * assignment's mode) — the tool calls it returns hit lcp-server's real
 * internal API exactly as a live `lcp-mcp-tasks` container would, so the real
 * `TaskOrchestrationService`/`AssignmentService` state machine drives every
 * handoff via the real BullMQ dispatch chain (no manual agent-by-agent
 * orchestration in this test).
 *
 * Deliberately skips the public `POST /api/task` + `/start` HTTP+auth layer —
 * this test is about the agent loop, not the API surface. See
 * `test/e2e/lcp-server/task.e2e-spec.ts` for `POST /api/task/:id/start`
 * coverage of task+planning-assignment creation.
 *
 * Fixtures live in `fixtures/<flow>-setup.json` (entities) and
 * `fixtures/<flow>-llm.json` (a `PUT /stub/config` body, sequenced per
 * conversational turn) so a new flow (e.g. a QA-rejection or exhaustion path)
 * is just two more JSON files plus a `runFlow(...)` call.
 *
 * Run via: ./scripts/run-e2e-tests.sh
 */
describe('Agent loop interactions (e2e)', () => {
  let serverApp: INestApplication;
  let agentModuleRef: TestingModule;
  let lcpServerUrl: string;
  let taskService: TaskService;
  let storageService: StorageService;
  let loadToolsMock: jest.Mock;

  let companyRepo: Repository<LcpCompany>;
  let roleRepo: Repository<LcpRole>;
  let taskRepo: Repository<LcpTask>;
  let assignmentRepo: Repository<LcpAssignment>;
  let agentRepo: Repository<LcpAgent>;

  /** Polls `check` until it returns a truthy value, or throws after `timeoutMs`. */
  async function waitFor<T>(
    check: () => Promise<T | null | undefined | false>,
    timeoutMs = 60_000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = await check();
      if (result) return result;
      if (Date.now() >= deadline) {
        throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  /**
   * Grabs a free port synchronously so `LCP_SERVER_URL` can be set correctly
   * *before* any Nest module compiles — see the identical helper (and its
   * doc comment explaining why) in `test/integration/lcp-agent/task-flow.integration-spec.ts`.
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

  function loadFixture<T>(name: string): T {
    const raw = readFileSync(
      join(__dirname, 'fixtures', `${name}.json`),
      'utf8',
    );
    return JSON.parse(raw) as T;
  }

  // --- fake `tasks__*` MCP tools -------------------------------------------
  // Each tool's `func` calls the exact internal endpoint a live
  // `lcp-mcp-tasks` container's tool handler would, so the real
  // AssignmentService/TaskOrchestrationService state machine runs for real.

  function createPlanTool(taskId: UUID, agentId: UUID): DynamicStructuredTool {
    return new DynamicStructuredTool({
      name: 'tasks__create_plan',
      description: "Submits the task's plan.",
      schema: z.object({
        assignments: z.array(
          z.object({
            prompt: z.string(),
            role: z.string(),
            expected: z.array(
              z.object({ type: z.string(), value: z.string() }),
            ),
          }),
        ),
      }),
      func: async ({
        assignments,
      }: {
        assignments: {
          prompt: string;
          role: string;
          expected: { type: string; value: string }[];
        }[];
      }): Promise<string> => {
        await axios.post(
          `${lcpServerUrl}/internal/task/${taskId}/plan`,
          { agentId, assignments },
          { headers: { 'X-Internal-Api-Key': INTERNAL_API_KEY } },
        );
        return 'Plan submitted.';
      },
    });
  }

  function assureAssignmentTool(
    targetAssignmentId: UUID,
    agentId: UUID,
  ): DynamicStructuredTool {
    return new DynamicStructuredTool({
      name: 'tasks__assure_assignment',
      description: 'Records a QA verdict on the assignment under review.',
      schema: z.object({
        qa: z.enum(['accept', 'reject']),
        feedback: z.string().optional(),
      }),
      func: async ({
        qa,
        feedback,
      }: {
        qa: 'accept' | 'reject';
        feedback?: string;
      }): Promise<string> => {
        await axios.post(
          `${lcpServerUrl}/internal/assignment/${targetAssignmentId}/assure`,
          { agentId, qa, feedback },
          { headers: { 'X-Internal-Api-Key': INTERNAL_API_KEY } },
        );
        return 'QA verdict recorded.';
      },
    });
  }

  /**
   * `complete_assignment` — used by implement, finalise, and consultee turns.
   * A real `create_working_file` MCP call would have already written any
   * `assignment-working-path` artifact by the time the model calls this; this
   * fake tool writes a trivial placeholder for each one so the real output
   * gate (`AssignmentService.checkOutputGate`/`checkTaskExpectations`, which
   * only checks presence, not content) passes the same way it would for a
   * real implementing agent.
   */
  function completeAssignmentTool(
    assignment: LcpAssignment,
    agentId: UUID,
    companySlug: string,
  ): DynamicStructuredTool {
    return new DynamicStructuredTool({
      name: 'tasks__complete_assignment',
      description: "Submits the agent's finished assignment.",
      schema: z.object({
        summary: z.string(),
        prepared: z
          .array(z.object({ type: z.string(), value: z.string() }))
          .default([]),
      }),
      func: async ({
        summary,
        prepared,
      }: {
        summary: string;
        prepared: { type: string; value: string }[];
      }): Promise<string> => {
        if (assignment.orderIndex != null) {
          for (const item of prepared) {
            if (item.type === 'assignment-working-path') {
              await storageService.putByKey(
                assignmentWorkingKey(
                  companySlug,
                  assignment.taskId as UUID,
                  assignment.orderIndex,
                  item.value,
                ),
                Buffer.from(
                  `Generated by agent-loop-interactions.e2e-spec.ts for assignment ${assignment.id}.\n`,
                ),
                'text/markdown',
              );
            }
          }
        }
        await axios.post(
          `${lcpServerUrl}/internal/assignment/${assignment.id}/complete`,
          { agentId, summary, prepared },
          { headers: { 'X-Internal-Api-Key': INTERNAL_API_KEY } },
        );
        return 'Assignment completed.';
      },
    });
  }

  /**
   * Resolves the right fake tool for whichever agent is currently running,
   * purely from its own assignment's `mode` — this is what lets the test
   * hand off through plan → implement → qa → implement → qa → finalise
   * without knowing the agent sequence in advance.
   */
  async function resolveToolsForAgent(agentId: UUID) {
    const agent = await agentRepo.findOneByOrFail({ id: agentId });
    const assignment = await assignmentRepo.findOneByOrFail({
      id: agent.assignmentId,
    });
    const company = await companyRepo.findOneByOrFail({
      id: assignment.companyId,
    });

    switch (assignment.mode) {
      case 'plan':
        return [
          {
            serverName: 'tasks',
            toolName: 'create_plan',
            tool: createPlanTool(assignment.taskId as UUID, agentId),
          },
        ];
      case 'qa':
        return [
          {
            serverName: 'tasks',
            toolName: 'assure_assignment',
            tool: assureAssignmentTool(
              assignment.targetAssignmentId as UUID,
              agentId,
            ),
          },
        ];
      case 'implement':
      case 'finalise':
      case 'consultee':
        return [
          {
            serverName: 'tasks',
            toolName: 'complete_assignment',
            tool: completeAssignmentTool(assignment, agentId, company.slug),
          },
        ];
      default:
        return [];
    }
  }

  beforeAll(async () => {
    const port = await getFreePort();
    lcpServerUrl = `http://127.0.0.1:${port}`;
    process.env.LCP_SERVER_URL = lcpServerUrl;

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
    taskService = serverModuleRef.get(TaskService);
    storageService = serverModuleRef.get(StorageService);

    loadToolsMock = jest.fn(
      async (
        _serverNames: string[],
        _serverUrls: Record<string, string>,
        context: { agentId?: string },
      ) => resolveToolsForAgent(context.agentId as UUID),
    );

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
    // A bare .compile() never fires lifecycle hooks — without .init(),
    // AgentWorkerService.onModuleInit never creates its BullMQ worker, so
    // nothing would ever pick up the jobs TaskOrchestrationService dispatches.
    await agentModuleRef.init();
    // Referenced so the real agent-loop class this test exercises is a
    // visible dependency, not just an incidental transitive import.
    void agentModuleRef.get(AgentLoopService, { strict: false });
  });

  afterAll(async () => {
    await agentModuleRef.close();
    await serverApp.close();
  });

  /**
   * Seeds company/role/task from `<flow>-setup.json`, configures the stub
   * from `<flow>-llm.json`, starts the task via the real `TaskService`, and
   * waits for it to reach a terminal status — the real BullMQ-driven
   * dispatch chain does everything in between.
   */
  async function runFlow(flowName: string): Promise<LcpTask> {
    const setup = loadFixture<FlowSetupFixture>(`${flowName}-setup`);
    const llmConfig = loadFixture<unknown>(`${flowName}-llm`);
    await putStubConfig(llmConfig);

    const company = await companyRepo.save(
      companyRepo.create({
        ...setup.company,
        slug: `${flowName}-${Date.now()}`,
        llmConfig: {
          provider: 'lm-studio',
          model: 'stub',
          baseUrl: STUB_LLM_URL,
        },
      }),
    );
    const role = await roleRepo.save(
      roleRepo.create({ ...setup.role, companyId: company.id }),
    );

    const created = await taskService.create({
      companyId: company.id,
      request: setup.task.request,
      plannerRoleId: role.id,
      expected: setup.task.expected,
    });
    await taskService.start(created.id);

    return waitFor(async () => {
      const found = await taskRepo.findOneBy({ id: created.id });
      return found && TERMINAL_TASK_STATUSES.includes(found.status)
        ? found
        : null;
    });
  }

  it('runs a full 2-step plan (plan -> implement -> QA -> implement -> QA -> finalise) to a succeeded task', async () => {
    const task = await runFlow('successful-flow');

    expect(task.status).toBe('succeeded');
    expect(task.completed).toEqual(
      expect.arrayContaining([
        { type: 'task-completed-path', value: 'out.md' },
      ]),
    );

    const assignments = await assignmentRepo.find({
      where: { taskId: task.id },
    });
    const byMode = (mode: string) => assignments.filter((a) => a.mode === mode);
    expect(byMode('plan')).toHaveLength(1);
    expect(byMode('implement')).toHaveLength(2);
    expect(byMode('qa')).toHaveLength(2);
    expect(byMode('finalise')).toHaveLength(1);
    for (const assignment of assignments) {
      expect(assignment.status).toBe('succeeded');
    }
  }, 60_000);
});
