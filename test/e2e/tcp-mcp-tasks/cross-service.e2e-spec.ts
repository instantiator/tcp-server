import {
  AgentStatus,
  AuditClientService,
  AuditEvent,
  InternalApiClient,
  TcpAgent,
  TcpAssignment,
  TcpAssignmentMode,
  TcpCompany,
  TcpRole,
  TcpTask,
} from '@tcp/shared';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { UUID } from 'crypto';
import type { AddressInfo, Server } from 'net';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { TasksToolsService } from '../../../apps/tcp-mcp-tasks/src/mcp/tasks-tools.service';
import { AppModule } from '../../../apps/tcp-server/src/app.module';

const INTERNAL_KEY = process.env.INTERNAL_API_KEY ?? 'e2e-test-internal-key';

/**
 * tcp-mcp-tasks' tool handlers against a live tcp-server — the tier ADR-016
 * records as outstanding for this service, and the only place its three
 * mode-gated tools meet the state machine they drive. Unit tests mock the
 * internal API client, so a handler that posts to a URL no route serves, gates
 * on the wrong mode, or turns a corrective 4xx into an exception would pass
 * everywhere except here.
 *
 * Fixtures are written straight to the database rather than driven through a
 * real agent run: what is under test is the tool → tcp-server → state
 * transition path, not how an agent arrives at calling the tool.
 */
async function callTool(
  service: TasksToolsService,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const server = service.createServer();
  const tools = (server as unknown as { _registeredTools: unknown })
    ._registeredTools as Record<
    string,
    {
      handler: (
        args: Record<string, unknown>,
      ) => Promise<{ content: { text: string }[] }>;
    }
  >;
  const tool = tools[toolName];
  if (!tool) throw new Error(`Tool '${toolName}' not found`);
  const result = await tool.handler(args);
  return result.content[0].text;
}

describe('tcp-mcp-tasks -> tcp-server (cross-service e2e)', () => {
  let app: INestApplication<App>;
  let tools: TasksToolsService;

  let companyRepo: Repository<TcpCompany>;
  let roleRepo: Repository<TcpRole>;
  let taskRepo: Repository<TcpTask>;
  let assignmentRepo: Repository<TcpAssignment>;
  let agentRepo: Repository<TcpAgent>;
  let auditRepo: Repository<AuditEvent>;

  let companyId: UUID;
  let plannerRoleId: UUID;
  let builderRoleId: UUID;

  /** QA attempts allowed for the builder role — pinned so exhaustion is reachable. */
  const MAX_QA_ATTEMPTS = 2;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    await app.listen(0);
    const address: AddressInfo | string | null = (
      app.getHttpServer() as Server
    ).address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected app to listen on a TCP port');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    companyRepo = moduleFixture.get(getRepositoryToken(TcpCompany));
    roleRepo = moduleFixture.get(getRepositoryToken(TcpRole));
    taskRepo = moduleFixture.get(getRepositoryToken(TcpTask));
    assignmentRepo = moduleFixture.get(getRepositoryToken(TcpAssignment));
    agentRepo = moduleFixture.get(getRepositoryToken(TcpAgent));
    auditRepo = moduleFixture.get(getRepositoryToken(AuditEvent));

    const config = {
      getOrThrow: (key: string) => {
        if (key === 'TCP_SERVER_URL') return baseUrl;
        if (key === 'INTERNAL_API_KEY') return INTERNAL_KEY;
        throw new Error(`Unexpected config key requested: ${key}`);
      },
    } as unknown as ConfigService;
    const api = new InternalApiClient(config);
    tools = new TasksToolsService(new AuditClientService(api), api);

    const company = await companyRepo.save(
      companyRepo.create({
        slug: `mcp-tasks-co-${Date.now()}`,
        name: 'MCP Tasks Corp',
        description: 'Fixture company for tcp-mcp-tasks cross-service e2e.',
      }),
    );
    companyId = company.id;

    plannerRoleId = (
      await roleRepo.save(
        roleRepo.create({
          companyId,
          slug: 'planner',
          name: 'planner',
          description: 'Plans the work.',
          systemPromptTemplate: 'You are {{name}}.',
        }),
      )
    ).id;

    builderRoleId = (
      await roleRepo.save(
        roleRepo.create({
          companyId,
          slug: 'builder',
          name: 'builder',
          description: 'Does the work.',
          systemPromptTemplate: 'You are {{name}}.',
          // Pinned here rather than left to the env so the exhaustion case
          // below is reachable in a fixed number of rejections.
          runConfig: { maxQaAttempts: MAX_QA_ATTEMPTS },
        }),
      )
    ).id;
  });

  /**
   * Waits for the tools' fire-and-forget audit writes to land.
   *
   * Every handler records its audit event *after* returning its result, so
   * tearing the agents down the moment a tool call resolves races a POST
   * that is still in flight — which the server then rejects on the agent
   * foreign key. Settles when the row count stops moving.
   */
  async function settleAuditWrites(): Promise<void> {
    let previous = -1;
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const count = await auditRepo.countBy({ companyId });
      if (count === previous) return;
      previous = count;
    }
  }

  // One teardown for the whole file, after every tool call has been made —
  // deleting between scenarios would reintroduce the race above, and each
  // scenario keys off its own fixtures rather than an empty table.
  afterAll(async () => {
    await settleAuditWrites();
    await agentRepo.delete({ companyId });
    await assignmentRepo.delete({ companyId });
    await taskRepo.delete({ companyId });
    await roleRepo.delete({ companyId });
    await companyRepo.delete({ id: companyId });
    await app.close();
  });

  /**
   * Seeds an assignment and the agent working on it, cross-linked the way a
   * real dispatch leaves them — `complete_assignment` and `assure_assignment`
   * both refuse a caller the assignment doesn't name.
   */
  async function seedAgentOn(
    fields: Partial<TcpAssignment> & { mode: TcpAssignmentMode },
  ): Promise<{ assignment: TcpAssignment; agent: TcpAgent }> {
    const assignment = await assignmentRepo.save(
      assignmentRepo.create({
        taskId: null,
        companyId,
        roleId: builderRoleId,
        prompt: 'Do the thing.',
        status: 'in-progress',
        ...fields,
      }),
    );
    const agent = await agentRepo.save(
      agentRepo.create({
        companyId,
        roleId: assignment.roleId,
        assignmentId: assignment.id,
        status: AgentStatus.Running,
        initialPrompt: assignment.prompt,
      }),
    );
    await assignmentRepo.update(assignment.id, { agentId: agent.id });
    assignment.agentId = agent.id;
    return { assignment, agent };
  }

  describe('create_plan', () => {
    let task: TcpTask;
    let planner: TcpAgent;

    beforeAll(async () => {
      task = await taskRepo.save(
        taskRepo.create({
          companyId,
          request: 'Build the thing.',
          shortcode: `plan-${Date.now()}`,
          status: 'planning',
        }),
      );
      ({ agent: planner } = await seedAgentOn({
        mode: 'plan',
        taskId: task.id,
        roleId: plannerRoleId,
        orderIndex: 0,
      }));
    });

    it('rejects an unknown role with a message naming the valid ones, not an exception', async () => {
      const text = await callTool(tools, 'create_plan', {
        agentId: planner.id,
        companyId,
        assignments: [
          {
            prompt: 'Do the work.',
            role: 'nonexistent-role',
            expected: [{ type: 'text', value: 'A summary.' }],
          },
        ],
      });

      // The whole point of the relay path: the model gets something it can
      // correct itself from, in place of a failed tool call.
      expect(text).toContain('nonexistent-role');
      expect(text).toContain('builder');
      expect(await assignmentRepo.countBy({ taskId: task.id })).toBe(1);
    });

    it('creates the planned assignments against the real task', async () => {
      const text = await callTool(tools, 'create_plan', {
        agentId: planner.id,
        companyId,
        assignments: [
          {
            prompt: 'Write the report.',
            role: 'builder',
            expected: [{ type: 'text', value: 'The report.' }],
          },
          {
            prompt: 'Check the report.',
            role: 'builder',
            expected: [{ type: 'text', value: 'A verdict.' }],
          },
        ],
      });

      expect(text).toContain('2');
      const planned = await assignmentRepo.find({
        where: { taskId: task.id, mode: 'implement' },
        order: { orderIndex: 'ASC' },
      });
      expect(planned).toHaveLength(2);
      expect(planned[0].prompt).toBe('Write the report.');
      // Canonicalised on the way in — `text` is stored as `inline-text`.
      expect(planned[0].expected).toEqual([
        { type: 'inline-text', value: 'The report.' },
      ]);
    });

    it('refuses a caller that is not in plan mode', async () => {
      const { agent } = await seedAgentOn({ mode: 'implement' });

      const text = await callTool(tools, 'create_plan', {
        agentId: agent.id,
        companyId,
        assignments: [
          {
            prompt: 'Do the work.',
            role: 'builder',
            expected: [{ type: 'text', value: 'A summary.' }],
          },
        ],
      });

      expect(text).toContain('implement');
      expect(text).toContain('complete_assignment');
    });
  });

  describe('complete_assignment', () => {
    it('completes an implement assignment whose prepared artifacts satisfy the gate', async () => {
      const { assignment, agent } = await seedAgentOn({
        mode: 'implement',
        expected: [{ type: 'inline-text', value: 'The answer.' }],
      });

      const text = await callTool(tools, 'complete_assignment', {
        agentId: agent.id,
        companyId,
        summary: 'Answered in full.',
        prepared: [{ type: 'text', value: '42' }],
      });

      expect(text).not.toContain('Error');
      const stored = await assignmentRepo.findOneByOrFail({
        id: assignment.id,
      });
      expect(stored.status).toBe('succeeded');
      expect(stored.summary).toBe('Answered in full.');
      // Canonicalised on the way in, same as the plan's expected artifacts.
      expect(stored.prepared).toEqual([{ type: 'inline-text', value: '42' }]);
    });

    it('relays the output gate’s corrective message when nothing was prepared', async () => {
      const { assignment, agent } = await seedAgentOn({
        mode: 'implement',
        expected: [{ type: 'inline-text', value: 'The answer.' }],
      });

      const text = await callTool(tools, 'complete_assignment', {
        agentId: agent.id,
        companyId,
        summary: 'Nothing to show.',
        prepared: [],
      });

      expect(text).toContain('complete_assignment again');
      // Still open, so the agent really can correct and resubmit.
      const stored = await assignmentRepo.findOneByOrFail({
        id: assignment.id,
      });
      expect(stored.status).toBe('in-progress');
    });

    it('refuses a caller that is in plan mode', async () => {
      const { agent } = await seedAgentOn({ mode: 'plan' });

      const text = await callTool(tools, 'complete_assignment', {
        agentId: agent.id,
        companyId,
        summary: 'Done.',
        prepared: [{ type: 'text', value: '42' }],
      });

      expect(text).toContain('plan');
      expect(text).toContain('create_plan');
    });
  });

  describe('assure_assignment', () => {
    /**
     * Seeds the state a QA agent is dispatched into: a task, a submitted
     * assignment waiting in `in-qa` with its implementing agent paused, and a
     * qa-mode assignment pointed at it. A task per scenario, so nothing is
     * torn down mid-run — the accept/reject paths write audit rows against
     * these agents after the tool call has already returned.
     */
    async function seedForQa(qaAttempts = 0): Promise<{
      target: TcpAssignment;
      reviewer: TcpAgent;
    }> {
      const task = await taskRepo.save(
        taskRepo.create({
          companyId,
          request: 'Build the reviewed thing.',
          shortcode: `qa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          status: 'in-progress',
        }),
      );
      const { assignment: target, agent: builder } = await seedAgentOn({
        mode: 'implement',
        taskId: task.id,
        orderIndex: 0,
        status: 'in-qa',
        summary: 'Submitted for review.',
        prepared: [{ type: 'inline-text', value: '42' }],
        qaAttempts,
      });
      await agentRepo.update(builder.id, {
        status: AgentStatus.Paused,
        pausedAt: new Date(),
      });
      const { agent: reviewer } = await seedAgentOn({
        mode: 'qa',
        taskId: task.id,
        orderIndex: 1,
        targetAssignmentId: target.id,
      });
      return { target, reviewer };
    }

    it('accept advances the reviewed assignment to succeeded', async () => {
      const { target, reviewer } = await seedForQa();

      const text = await callTool(tools, 'assure_assignment', {
        agentId: reviewer.id,
        companyId,
        qa: 'accept',
      });

      expect(text).toContain('accepted');
      const stored = await assignmentRepo.findOneByOrFail({ id: target.id });
      expect(stored.status).toBe('succeeded');
      expect(stored.qaStatus).toBe('accepted');
    });

    it('reject returns the assignment for another attempt while attempts remain', async () => {
      const { target, reviewer } = await seedForQa();

      const text = await callTool(tools, 'assure_assignment', {
        agentId: reviewer.id,
        companyId,
        qa: 'reject',
        feedback: 'The numbers do not add up.',
      });

      expect(text).toContain('rejected');
      const stored = await assignmentRepo.findOneByOrFail({ id: target.id });
      expect(stored.status).toBe('in-progress');
      expect(stored.qaAttempts).toBe(1);
    });

    it('reject fails the assignment once its QA attempts are exhausted', async () => {
      const { target, reviewer } = await seedForQa(MAX_QA_ATTEMPTS - 1);

      await callTool(tools, 'assure_assignment', {
        agentId: reviewer.id,
        companyId,
        qa: 'reject',
        feedback: 'Still wrong.',
      });

      const stored = await assignmentRepo.findOneByOrFail({ id: target.id });
      expect(stored.status).toBe('failed');
      expect(stored.qaAttempts).toBe(MAX_QA_ATTEMPTS);
    });

    it('relays the server’s refusal when rejecting without feedback', async () => {
      const { target, reviewer } = await seedForQa();

      const text = await callTool(tools, 'assure_assignment', {
        agentId: reviewer.id,
        companyId,
        qa: 'reject',
      });

      expect(text).toContain('feedback');
      const stored = await assignmentRepo.findOneByOrFail({ id: target.id });
      expect(stored.status).toBe('in-qa');
    });

    it('refuses a caller that is not in qa mode', async () => {
      const { agent } = await seedAgentOn({ mode: 'implement' });

      const text = await callTool(tools, 'assure_assignment', {
        agentId: agent.id,
        companyId,
        qa: 'accept',
      });

      expect(text).toContain('implement');
      expect(text).toContain('complete_assignment');
    });
  });
});
