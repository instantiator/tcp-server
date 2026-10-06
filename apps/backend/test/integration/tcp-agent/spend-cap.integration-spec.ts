import type { UUID } from 'crypto';
import { createServer, type AddressInfo } from 'node:net';
import {
  AgentStatus,
  AuditClientService,
  CompanyUser,
  McpClientService,
  SpendCapState,
  TcpAgent,
  TcpAssignment,
  TcpCompany,
  TcpNotification,
  TcpRole,
  TcpTask,
  TokenUsage,
  type AuditEventType,
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
import { AppModule as TcpAgentAppModule } from '../../../apps/tcp-agent/src/app.module';
import { AgentRegistryService } from '../../../apps/tcp-agent/src/registry/agent-registry.service';
import { SpendResumeService } from '../../../apps/tcp-server/src/api/spend-resume.service';
import { TaskService } from '../../../apps/tcp-server/src/api/task.service';
import { makeTestJwt } from '../../e2e/helpers/test-jwt';
import { requireEnv } from '../../support/require-env';

const STUB_LLM_URL = requireEnv('STUB_LLM_URL');
const INTERNAL_API_KEY = requireEnv('INTERNAL_API_KEY');

/** A cap so tiny that one real LLM call's recorded usage always exceeds it. */
const TINY_SPEND_CAPS = {
  'openai-compatible': {
    limits: [{ tokens: 1, per: 'month' }],
    notifyAt: [50],
    action: 'pause',
  },
};

/** Marks the prompt that starts task A's planner (stays in its history). */
const TASK_A_MARKER = 'TASK-A-SPEND-CAP-MARKER';
/** Marks the prompt that starts task B's planner. */
const TASK_B_MARKER = 'TASK-B-SPEND-CAP-MARKER';
/** The prompt every follow-on implement assignment carries. */
const IMPLEMENT_MARKER = 'IMPLEMENT-STEP-SPEND-CAP-MARKER';
/**
 * Only ever appears in the first message of a resume `AgentOrchestrationService`
 * sends after a spend-cap pause (`SPEND_CAP_RESUME_PROMPT`) — matching on it
 * proves the planner's completion was seen *after* a real resume, not on its
 * first (gated) attempt.
 */
const RESUME_MARKER = 'spending limit';

/**
 * Whole-scenario coverage of the spend-cap path with the real tcp-server and
 * tcp-agent apps, the real BullMQ queue, Postgres, and the stub LLM: a task
 * started under no cap runs normally; recording its usage trips a tiny cap,
 * which pauses it mid-run with its checkpoint intact; a second task started
 * while the cap holds is exempted via the real `POST /api/task/:id/start`
 * route and runs regardless; dismissing the cap resumes the first task,
 * which continues from its checkpoint rather than restarting.
 *
 * Modelled on `consultation-cycle.integration-spec.ts` (two real apps, real
 * queue) and `task-flow.integration-spec.ts` (a task driven to completion) —
 * only the MCP hop is faked, via a mocked `McpClientService.loadTools` whose
 * fake tools call exactly the internal endpoints the real MCP servers call.
 *
 * Run via: ./scripts/run-integration-tests.sh
 */
describe('Spend cap enforcement across a task run (stub LLM, real queue)', () => {
  let serverApp: INestApplication;
  let agentModuleRef: TestingModule;
  let tcpServerUrl: string;
  let loadToolsMock: jest.Mock;

  let companyRepo: Repository<TcpCompany>;
  let roleRepo: Repository<TcpRole>;
  let companyUserRepo: Repository<CompanyUser>;
  let taskRepo: Repository<TcpTask>;
  let assignmentRepo: Repository<TcpAssignment>;
  let agentRepo: Repository<TcpAgent>;
  let notificationRepo: Repository<TcpNotification>;
  let spendCapStateRepo: Repository<SpendCapState>;
  let tokenUsageRepo: Repository<TokenUsage>;
  let taskService: TaskService;
  let spendResume: SpendResumeService;
  let initialState: InitialStateService;

  let companyId: UUID;
  let roleId: UUID;
  let memberAuth: { Authorization: string };

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
  ): Promise<TcpAgent> {
    // Paused is deliberately not a bail-out status: resuming a paused agent
    // passes back through `paused` for a moment before the queued resume job
    // is actually picked up and flips it to `running`, so treating it as
    // settled here would false-positive on exactly the resume path this spec
    // tests.
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
    });
  }

  /** True once `agentId` has reached any terminal status (or no longer exists). */
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
   * `create_plan`'s real plan submission dispatches a further implement agent
   * before this spec gets a chance to intervene — this spec's own fake MCP
   * tool for that follow-on step is incidental to the cap scenario and isn't
   * asserted on, so rather than script it to a clean finish, each planner's
   * task is cancelled (cascading to its still-running agents, same as a real
   * cancellation) right after the scenario's own assertions on it are done.
   * Without this, a follow-on agent still mid-run when the suite tears down
   * would leave `agentModuleRef.close()` (and so this spec) waiting on its
   * BullMQ worker to finish that job.
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

  /** A harmless `tasks__describe_server` the planner can call without finishing anything. */
  function describeServerTool(): DynamicStructuredTool {
    return new DynamicStructuredTool({
      name: 'tasks__describe_server',
      description: 'Describes the tasks service.',
      schema: z.object({}),
      func: (): Promise<string> =>
        Promise.resolve('Call create_plan when your plan is ready.'),
    });
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
        const { data } = await axios.get<{ assignment: { taskId: UUID } }>(
          `${tcpServerUrl}/internal/agent/${agentId}/assignment`,
          internalHeaders,
        );
        await axios.post(
          `${tcpServerUrl}/internal/task/${data.assignment.taskId}/plan`,
          {
            agentId,
            assignments: [
              { prompt: IMPLEMENT_MARKER, role: roleId, expected: [] },
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
    // `ConfigModule.forRoot`'s Joi validation runs synchronously the moment
    // tcp-server's `app.module` is evaluated — which a hoisted top-of-file
    // `import` would trigger before this line ever ran. So SPEND_CAPS is set
    // here first, and the module required afterwards (mirrors
    // `auth/route-audit.spec.ts`).
    process.env.SPEND_CAPS = JSON.stringify(TINY_SPEND_CAPS);
    // Starting task B goes through the real HTTP route (so `exemptIfCapped`
    // really runs), which means a real JWT must pass the real `JwtStrategy`.
    // That strategy discovers its JWKS URI from the OIDC provider's discovery
    // document unless `OIDC_JWKS_URI` is set — the integration tier runs no
    // OIDC provider at all (unlike the e2e tier's bundled Zitadel), so
    // discovery would otherwise fail outright before `jwks-rsa` is ever
    // reached. Setting it to any URL skips discovery; the URL itself is never
    // fetched, because `jwks-rsa` is also mocked below, exactly like the e2e
    // tier's own `test/e2e/__mocks__/jwks-rsa.ts` — it hands back a fixed HMAC
    // secret that `makeTestJwt` signs against.
    process.env.OIDC_JWKS_URI = 'http://localhost:8080/unused-jwks-uri';
    // `jest.doMock` (rather than the usual hoisted `jest.mock`) is used
    // because ts-jest does not hoist — this must run, in this exact spot,
    // before `app.module` (and therefore `jwt.strategy.ts`) is ever required
    // below.
    jest.doMock('jwks-rsa', () => ({
      passportJwtSecret:
        () =>
        (
          _req: unknown,
          _rawJwtToken: unknown,
          done: (err: null, secret: string) => void,
        ) =>
          done(null, 'stub-secret'),
    }));
    /* eslint-disable @typescript-eslint/no-require-imports -- SPEND_CAPS/the jwks-rsa mock above must be set before app.module is evaluated, which a hoisted import would not allow */
    const { AppModule: TcpServerAppModule } =
      require('../../../apps/tcp-server/src/app.module') as typeof import('../../../apps/tcp-server/src/app.module');
    /* eslint-enable @typescript-eslint/no-require-imports */

    const serverModuleRef = await Test.createTestingModule({
      imports: [TcpServerAppModule],
    }).compile();
    serverApp = serverModuleRef.createNestApplication();
    await serverApp.init();
    await serverApp.listen(port);

    companyRepo = serverModuleRef.get(getRepositoryToken(TcpCompany));
    roleRepo = serverModuleRef.get(getRepositoryToken(TcpRole));
    companyUserRepo = serverModuleRef.get(getRepositoryToken(CompanyUser));
    taskRepo = serverModuleRef.get(getRepositoryToken(TcpTask));
    assignmentRepo = serverModuleRef.get(getRepositoryToken(TcpAssignment));
    agentRepo = serverModuleRef.get(getRepositoryToken(TcpAgent));
    notificationRepo = serverModuleRef.get(getRepositoryToken(TcpNotification));
    spendCapStateRepo = serverModuleRef.get(getRepositoryToken(SpendCapState));
    tokenUsageRepo = serverModuleRef.get(getRepositoryToken(TokenUsage));
    taskService = serverModuleRef.get(TaskService);
    spendResume = serverModuleRef.get(SpendResumeService);

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
            toolName: 'describe_server',
            tool: describeServerTool(),
          },
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
        // Re-pointed at the real server for the same TCP_SERVER_URL-timing
        // reason as `notifyFailed` above — unlike task-flow/consultation-cycle,
        // this spec's whole scenario turns on the real usage/cap pipeline
        // `AuditService.write` drives, so (unlike those specs) this must
        // actually reach it rather than no-op. Fire-and-forget, same contract
        // as the real `AuditClientService.record` (never throws).
        record: (
          eventCompanyId: UUID,
          role: string,
          agentId: UUID | null,
          eventType: AuditEventType,
          payload: Record<string, unknown>,
        ) => {
          axios
            .post(
              `${tcpServerUrl}/internal/audit`,
              {
                companyId: eventCompanyId,
                role,
                agentId: agentId ?? undefined,
                eventType,
                payload,
              },
              internalHeaders,
            )
            .catch(() => {});
        },
      })
      .compile();
    // Lifecycle hooks only fire on init — without it AgentWorkerService never
    // creates the BullMQ worker this spec depends on.
    await agentModuleRef.init();
    initialState = agentModuleRef.get(InitialStateService);

    const company = await companyRepo.save(
      companyRepo.create({
        name: 'Spend Cap Integration Co',
        slug: `spend-cap-co-${Date.now()}`,
        description: 'For spend-cap integration tests',
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
        slug: 'spend-cap-role',
        name: 'Planner',
        description: 'Plans and implements for the spend-cap scenario',
        systemPromptTemplate: 'You are {{name}}.',
      }),
    );
    roleId = role.id;

    // The member identity used for the real `POST /api/task/:id/start` call —
    // `CompanyMembershipGuard` needs a `CompanyUser` row, which a direct repo
    // insert (unlike `POST /api/company`) never creates on its own.
    await companyUserRepo.save(
      companyUserRepo.create({
        companyId,
        identifier: 'test-user',
        name: null,
        memberType: 'member',
        roles: [],
        knowledgeDomains: [],
      }),
    );
    memberAuth = { Authorization: `Bearer ${makeTestJwt()}` };
  }, 60_000);

  afterAll(async () => {
    // Backstop: nothing may still be running when the fixtures go.
    agentModuleRef.get(AgentRegistryService).abortAll('test teardown');
    await waitForNoRunningLoops();
    await agentRepo.createQueryBuilder().delete().execute();
    await assignmentRepo.createQueryBuilder().delete().execute();
    await taskRepo.delete({ companyId });
    await companyUserRepo.delete({ companyId });
    await roleRepo.delete({ id: roleId });
    await companyRepo.delete({ id: companyId });
    await spendCapStateRepo.delete({ provider: 'openai-compatible' });
    await notificationRepo
      .createQueryBuilder()
      .delete()
      .where("params->>'provider' = :provider", {
        provider: 'openai-compatible',
      })
      .execute();
    // Both modules hold their own DB/Redis/BullMQ connections; closing one
    // leaves the other's open and stalls Jest's exit.
    await agentModuleRef.close();
    await serverApp.close();
    delete process.env.SPEND_CAPS;
  });

  it('pauses a task on a tiny cap, exempts a task started while it holds, and resumes the first from its checkpoint once dismissed', async () => {
    await putStubConfig({
      prompts: [
        // Listed first: after task A resumes, its history carries *both*
        // this marker and TASK_A_MARKER — this must win so the planner's
        // completion only ever happens post-resume.
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
              text: 'Implementing now.',
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
        // A tool call that never finishes anything — task A's planner needs
        // at least two LLM calls, and this keeps looping on one until the
        // gate (asynchronously, on the fire-and-forget audit path) catches
        // up and pauses it. Safe up to AGENT_ITERATIONS (40).
        {
          match: TASK_A_MARKER,
          mode: 'loop',
          responses: [
            {
              text: 'Looking into it.',
              tools: [{ tool: 'tasks__describe_server', data: {} }],
            },
          ],
        },
      ],
      defaults: {
        mode: 'loop',
        responses: [{ text: 'stub-llm fallback: no rule matched this prompt' }],
      },
    });

    // --- step 1: task A starts while no cap is reached ---------------
    const taskA = await taskRepo.save(
      taskRepo.create({
        companyId,
        request: `${TASK_A_MARKER}: do the thing.`,
        shortcode: `spend-cap-a-${Date.now()}`,
        plannerRoleId: roleId,
        status: 'ready',
      }),
    );
    await taskService.start(taskA.id);
    expect(
      (await taskRepo.findOneByOrFail({ id: taskA.id })).spendCapExempt,
    ).toBe(false);

    const plannerA = await assignmentRepo.findOneByOrFail({
      taskId: taskA.id,
      mode: 'plan',
    });
    const plannerAId = plannerA.agentId as UUID;
    const initialStateBuildSpy = jest.spyOn(initialState, 'build');

    // --- step 2: its planner pauses once the cap is reached -----------
    await waitForAgentStatus(plannerAId, AgentStatus.Paused);
    const pausedPlannerA = await agentRepo.findOneByOrFail({
      id: plannerAId,
    });
    expect(pausedPlannerA.pauseReason).toBe('spend_cap');

    const notifications = await notificationRepo.find();
    const providerOf = (n: TcpNotification): string | undefined => {
      const provider = n.params?.['provider'];
      return typeof provider === 'string' ? provider : undefined;
    };
    expect(
      notifications.some(
        (n) =>
          n.kind === 'spend_threshold' && providerOf(n) === 'openai-compatible',
      ),
    ).toBe(true);
    expect(
      notifications.some(
        (n) =>
          n.kind === 'spend_reached' && providerOf(n) === 'openai-compatible',
      ),
    ).toBe(true);

    const capState = await spendCapStateRepo.findOneByOrFail({
      provider: 'openai-compatible',
    });
    expect(capState.action).toBe('pause');
    expect(capState.reachedUntil).toBeTruthy();
    expect(new Date(capState.reachedUntil as Date).getTime()).toBeGreaterThan(
      Date.now(),
    );

    const usageBefore = await tokenUsageRepo.count({
      where: { agentId: plannerAId },
    });
    expect(usageBefore).toBeGreaterThanOrEqual(1);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const usageAfter = await tokenUsageRepo.count({
      where: { agentId: plannerAId },
    });
    expect(usageAfter).toBe(usageBefore);

    // --- step 3: task B starts via the real HTTP route while capped ---
    const taskB = await taskRepo.save(
      taskRepo.create({
        companyId,
        request: `${TASK_B_MARKER}: do another thing.`,
        shortcode: `spend-cap-b-${Date.now()}`,
        plannerRoleId: roleId,
        status: 'ready',
      }),
    );
    await axios.post(
      `${tcpServerUrl}/api/task/${taskB.id}/start`,
      {},
      { headers: memberAuth },
    );
    expect(
      (await taskRepo.findOneByOrFail({ id: taskB.id })).spendCapExempt,
    ).toBe(true);

    const plannerB = await assignmentRepo.findOneByOrFail({
      taskId: taskB.id,
      mode: 'plan',
    });
    const plannerBId = plannerB.agentId as UUID;
    await waitForAgentStatus(plannerBId, AgentStatus.Completed);
    // B's own assertions are done — cancel it now so its create_plan-spawned
    // implement agent (unscripted past this point, and not part of the
    // scenario) can't still be running when the suite tears down.
    await cancelTaskAndSettle(taskB.id);

    // --- step 4: dismissing the cap resumes A, which continues rather
    // than restarts ------------------------------------------------------
    await spendResume.dismissCap('openai-compatible', 'until-reset');
    await waitForAgentStatus(plannerAId, AgentStatus.Completed);

    // `build` assembles the full initial-state message list — only ever
    // needed for a fresh run. A resume injects the reply into the existing
    // checkpoint instead (see `AgentLoopService.runLoop`), so if A truly
    // continued rather than restarted, it was never called a second time
    // for this agent (filtering by id, since the implement assignment
    // `create_plan` just dispatched is itself a fresh agent and legitimately
    // calls `build` once).
    const buildCallsForPlannerA = initialStateBuildSpy.mock.calls.filter(
      (call) => call[0].id === plannerAId,
    );
    expect(buildCallsForPlannerA).toHaveLength(1);

    // Same cleanup as B's, now that A's own assertions are done too.
    await cancelTaskAndSettle(taskA.id);
  }, 120_000);
});
