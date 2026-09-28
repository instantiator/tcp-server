import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import {
  AgentStatus,
  AuditEventType,
  TcpAgent,
  TcpAssignment,
  TcpCompany,
  TcpRole,
  TcpTask,
  type TcpMaterialArtifact,
} from '@tcp/shared';
import { ConfigService } from '@nestjs/config';
import { type UUID } from 'crypto';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../storage/storage.service';
import { AgentOrchestrationService } from './agent-orchestration.service';
import { PauseAndResumeService } from './pause-and-resume.service';
import { QaVerdictService } from './qa-verdict.service';
import { TaskDeliverablesService } from './task-deliverables.service';
import { TaskFailureService } from './task-failure.service';
import { TaskOrchestrationService } from './task-orchestration.service';
import { TaskRecoveryService } from './task-recovery.service';
import { TaskStateService } from './task-state.service';
import type { TcpAgentTemplate } from '../templates/TcpAgentTemplate';

const ENTITIES = [TcpCompany, TcpRole, TcpAgent, TcpTask, TcpAssignment];

/**
 * Exercises the whole orchestration stack — {@link TaskOrchestrationService}
 * and its {@link TaskStateService}/{@link TaskDeliverablesService}/
 * {@link QaVerdictService}/{@link TaskFailureService}/
 * {@link TaskRecoveryService} collaborators, wired together for real — against
 * an in-memory SQLite DB, so the atomic conditional UPDATEs, state transitions,
 * materials merge, and recovery decisions are covered end-to-end. Only the
 * outward-facing collaborators (agent dispatch, pause/resume, storage, audit,
 * config) are mocked — `createAgent` still persists a real agent row so the
 * assignment↔agent back-link the completion/QA paths rely on is genuine.
 */
describe('TaskOrchestrationService', () => {
  let moduleRef: TestingModule;
  let service: TaskOrchestrationService;
  let failures: TaskFailureService;
  let recovery: TaskRecoveryService;
  let taskRepo: Repository<TcpTask>;
  let assignmentRepo: Repository<TcpAssignment>;
  let agentRepo: Repository<TcpAgent>;
  let companyRepo: Repository<TcpCompany>;
  let roleRepo: Repository<TcpRole>;

  let agents: {
    createAgent: jest.Mock;
    dispatchStartJob: jest.Mock;
    resumeAgent: jest.Mock;
  };
  let pauseResume: { completeAgent: jest.Mock; failAgent: jest.Mock };
  let storage: { copyFile: jest.Mock; listFiles: jest.Mock };
  let audit: { record: jest.Mock };
  let config: { get: jest.Mock };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          entities: ENTITIES,
          synchronize: true,
        }),
        TypeOrmModule.forFeature(ENTITIES),
      ],
    }).compile();
    taskRepo = moduleRef.get(getRepositoryToken(TcpTask));
    assignmentRepo = moduleRef.get(getRepositoryToken(TcpAssignment));
    agentRepo = moduleRef.get(getRepositoryToken(TcpAgent));
    companyRepo = moduleRef.get(getRepositoryToken(TcpCompany));
    roleRepo = moduleRef.get(getRepositoryToken(TcpRole));
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(() => {
    // createAgent persists a real agent row (as DbService.createAgent would),
    // so the orchestrator's back-link and later lookups operate on real data.
    agents = {
      createAgent: jest.fn().mockImplementation((t: TcpAgentTemplate) =>
        agentRepo.save(
          agentRepo.create({
            companyId: t.companyId,
            roleId: t.roleId,
            assignmentId: t.assignmentId,
            initialPrompt: t.initialPrompt,
          }),
        ),
      ),
      dispatchStartJob: jest.fn().mockResolvedValue(undefined),
      resumeAgent: jest.fn().mockResolvedValue(undefined),
    };
    pauseResume = {
      completeAgent: jest.fn().mockResolvedValue(undefined),
      failAgent: jest.fn().mockResolvedValue(undefined),
    };
    storage = {
      copyFile: jest.fn().mockResolvedValue(undefined),
      listFiles: jest.fn().mockResolvedValue([]),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    config = { get: jest.fn().mockReturnValue(undefined) };

    const state = new TaskStateService(
      taskRepo,
      assignmentRepo,
      audit as unknown as AuditService,
    );
    const deliverables = new TaskDeliverablesService(
      taskRepo,
      companyRepo,
      storage as unknown as StorageService,
      state,
    );
    const qa = new QaVerdictService(
      taskRepo,
      assignmentRepo,
      companyRepo,
      roleRepo,
      agents as unknown as AgentOrchestrationService,
      pauseResume as unknown as PauseAndResumeService,
      deliverables,
      state,
      config as unknown as ConfigService,
    );
    failures = new TaskFailureService(
      taskRepo,
      assignmentRepo,
      agentRepo,
      roleRepo,
      deliverables,
      state,
      audit as unknown as AuditService,
    );
    service = new TaskOrchestrationService(
      taskRepo,
      assignmentRepo,
      companyRepo,
      agents as unknown as AgentOrchestrationService,
      pauseResume as unknown as PauseAndResumeService,
      qa,
      failures,
      deliverables,
      state,
    );
    recovery = new TaskRecoveryService(
      taskRepo,
      assignmentRepo,
      agentRepo,
      service,
      failures,
      deliverables,
      state,
    );
  });

  // --- fixtures -------------------------------------------------------------

  function slug(): string {
    return Math.random().toString(36).slice(2, 8);
  }
  async function seedCompany(
    partial: Partial<TcpCompany> = {},
  ): Promise<TcpCompany> {
    return companyRepo.save(
      companyRepo.create({
        slug: `acme-${slug()}`,
        name: 'ACME',
        description: 'x',
        ...partial,
      }),
    );
  }
  async function seedRole(
    companyId: UUID,
    partial: Partial<TcpRole> = {},
  ): Promise<TcpRole> {
    return roleRepo.save(
      roleRepo.create({
        companyId,
        slug: `role-${slug()}`,
        name: 'analyst',
        description: 'x',
        ...partial,
      }),
    );
  }
  async function seedTask(
    companyId: UUID,
    partial: Partial<TcpTask> = {},
  ): Promise<TcpTask> {
    return taskRepo.save(
      taskRepo.create({
        companyId,
        request: 'do it',
        shortcode: '000',
        status: 'planning',
        materials: [],
        expected: [],
        ...partial,
      }),
    );
  }
  async function seedAssignment(
    partial: Partial<TcpAssignment>,
  ): Promise<TcpAssignment> {
    return assignmentRepo.save(
      assignmentRepo.create({
        mode: 'implement',
        prompt: 'work',
        status: 'ready',
        materials: [],
        expected: [],
        prepared: [],
        approved: [],
        ...partial,
      }),
    );
  }

  // --- dispatchPlanner ------------------------------------------------------

  describe('dispatchPlanner', () => {
    it('creates a plan assignment + agent and back-links agentId', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const task = await seedTask(company.id, {
        plannerRoleId: role.id,
        request: 'Write a report',
      });

      await service.dispatchPlanner(task);

      const plan = await assignmentRepo.findOneBy({
        taskId: task.id,
        mode: 'plan',
      });
      expect(plan).not.toBeNull();
      expect(plan!.status).toBe('in-progress');
      expect(plan!.prompt).toBe('Write a report');
      expect(plan!.agentId).toBeTruthy();
      expect(agents.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({ requiredToolCalls: ['create_plan'] }),
      );
      expect(agents.dispatchStartJob).toHaveBeenCalledTimes(1);

      // The ready→planning reaction is recorded as one entity:'task'
      // state_change; the publisher routes it to both the task and company
      // channels (see dispatchPlanner's docstring). The summary rides in the
      // payload.
      const taskStateCall = (audit.record.mock.calls as unknown[][]).find(
        (c) =>
          c[3] === AuditEventType.StateChange &&
          (c[4] as { entity?: string }).entity === 'task',
      );
      expect(taskStateCall).toBeDefined();
      expect(taskStateCall![0]).toBe(company.id);
      expect(taskStateCall![4]).toMatchObject({
        entity: 'task',
        taskId: task.id,
        newStatus: 'planning',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        summary: expect.objectContaining({ id: task.id, status: 'planning' }),
      });
    });

    // 002.02 stage 1 (cause C1): the only assignment event is recorded before
    // the agent exists, and the agentId back-link publishes nothing, so no
    // client learns which agent works the plan until that agent next changes.
    it('publishes the plan assignment again once its agentId is back-linked', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const task = await seedTask(company.id, { plannerRoleId: role.id });

      await service.dispatchPlanner(task);

      const plan = await assignmentRepo.findOneBy({
        taskId: task.id,
        mode: 'plan',
      });
      const linkedCall = (audit.record.mock.calls as unknown[][]).find(
        (c) =>
          c[3] === AuditEventType.StateChange &&
          (c[4] as { entity?: string }).entity === 'assignment' &&
          c[2] === plan!.agentId,
      );
      expect(linkedCall).toBeDefined();
      expect(linkedCall![4]).toMatchObject({
        assignmentId: plan!.id,
        newStatus: 'in-progress',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        summary: expect.objectContaining({ id: plan!.id }),
      });
    });

    it('falls back to the company planner role', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      await companyRepo.update(company.id, { plannerRoleId: role.id });
      const task = await seedTask(company.id);

      await service.dispatchPlanner(task);
      const plan = await assignmentRepo.findOneBy({
        taskId: task.id,
        mode: 'plan',
      });
      expect(plan!.roleId).toBe(role.id);
    });

    it('is idempotent — a second call creates no second plan assignment', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const task = await seedTask(company.id, { plannerRoleId: role.id });

      await service.dispatchPlanner(task);
      await service.dispatchPlanner(task);

      const plans = await assignmentRepo.findBy({
        taskId: task.id,
        mode: 'plan',
      });
      expect(plans).toHaveLength(1);
      expect(agents.createAgent).toHaveBeenCalledTimes(1);
    });
  });

  // --- assignmentReadyForQa --------------------------------------------------

  describe('assignmentReadyForQa', () => {
    it('shows a path-type prepared artifact as its bare filename, never a resolved storage key', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const task = await seedTask(company.id);
      const assignment = await seedAssignment({
        taskId: task.id,
        companyId: company.id,
        roleId: role.id,
        orderIndex: 0,
        prepared: [{ type: 'assignment-working-path', value: 'guide.md' }],
      });

      await service.assignmentReadyForQa(assignment);

      const qa = await assignmentRepo.findOneBy({
        targetAssignmentId: assignment.id,
        mode: 'qa',
      });
      expect(qa).not.toBeNull();
      expect(qa!.prompt).toContain('- guide.md');
      // Never the resolved storage key — the QA agent reads it via the
      // scoped `read_working_file(filename)` tool instead.
      expect(qa!.prompt).not.toContain(
        `${company.slug}/tasks/${task.id}/assignments/0/working/guide.md`,
      );
      expect(agents.dispatchStartJob).toHaveBeenCalledTimes(1);
    });

    it('is idempotent — a second call while a QA assignment is live creates no duplicate', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const task = await seedTask(company.id);
      const assignment = await seedAssignment({
        taskId: task.id,
        companyId: company.id,
        roleId: role.id,
        orderIndex: 0,
        prepared: [{ type: 'inline-text', value: 'done' }],
      });

      await service.assignmentReadyForQa(assignment);
      await service.assignmentReadyForQa(assignment);

      const qas = await assignmentRepo.findBy({
        targetAssignmentId: assignment.id,
        mode: 'qa',
      });
      expect(qas).toHaveLength(1);
    });
  });

  // --- taskPlanned / dispatchAssignment -------------------------------------

  describe('taskPlanned', () => {
    it('dispatches only the lowest-orderIndex ready assignment', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const task = await seedTask(company.id, { status: 'in-progress' });
      await seedAssignment({
        taskId: task.id,
        companyId: company.id,
        roleId: role.id,
        orderIndex: 0,
      });
      const step1 = await seedAssignment({
        taskId: task.id,
        companyId: company.id,
        roleId: role.id,
        orderIndex: 1,
      });

      await service.taskPlanned(task);

      const step0After = await assignmentRepo.findOneBy({
        taskId: task.id,
        orderIndex: 0,
      });
      expect(step0After!.status).toBe('in-progress');
      expect(step0After!.agentId).toBeTruthy();
      expect((await assignmentRepo.findOneBy({ id: step1.id }))!.status).toBe(
        'ready',
      );
    });

    it('recomputes the task status to in-progress once the first step is dispatched', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      // A task's status derives to 'ready' the moment its plan exists but no
      // step has started yet — dispatching the first step must move it to
      // 'in-progress' immediately, not leave it stale until that step finishes.
      const task = await seedTask(company.id, { status: 'ready' });
      await seedAssignment({
        taskId: task.id,
        companyId: company.id,
        roleId: role.id,
        orderIndex: 0,
      });

      await service.taskPlanned(task);

      expect((await taskRepo.findOneBy({ id: task.id }))!.status).toBe(
        'in-progress',
      );
    });
  });

  // --- materials merge ------------------------------------------------------

  describe('materials merge on dispatch', () => {
    it('merges task materials, prior approved outputs, and planner hints, deduped most-recent', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const task = await seedTask(company.id, {
        status: 'in-progress',
        materials: [{ type: 'task-materials-path', value: 'brief.txt' }],
      });
      // Two prior succeeded steps both approved 'shared.txt'; the newer wins
      // (only one entry survives — resolution picks the highest orderIndex).
      await seedAssignment({
        taskId: task.id,
        companyId: company.id,
        roleId: role.id,
        orderIndex: 0,
        status: 'succeeded',
        approved: [{ type: 'assignment-completed-path', value: 'shared.txt' }],
      });
      await seedAssignment({
        taskId: task.id,
        companyId: company.id,
        roleId: role.id,
        orderIndex: 1,
        status: 'succeeded',
        approved: [
          { type: 'assignment-completed-path', value: 'shared.txt' },
          { type: 'assignment-completed-path', value: 'extra.txt' },
        ],
      });
      const hint: TcpMaterialArtifact = {
        type: 'inline-text',
        value: 'planner hint',
      };
      const step2 = await seedAssignment({
        taskId: task.id,
        companyId: company.id,
        roleId: role.id,
        orderIndex: 2,
        materials: [hint],
      });

      await service.taskPlanned(task);

      const merged = (await assignmentRepo.findOneBy({ id: step2.id }))!
        .materials;
      const values = merged.map((m) => `${m.type}:${m.value}`);
      expect(values).toContain('task-materials-path:brief.txt');
      expect(values).toContain('assignment-completed-path:shared.txt');
      expect(values).toContain('assignment-completed-path:extra.txt');
      expect(values).toContain('inline-text:planner hint');
      // 'shared.txt' appears once despite two prior approvals.
      expect(
        values.filter((v) => v === 'assignment-completed-path:shared.txt'),
      ).toHaveLength(1);
    });
  });

  // --- accept ---------------------------------------------------------------

  describe('assignmentAssured — accept', () => {
    async function seedInQa(): Promise<{
      company: TcpCompany;
      task: TcpTask;
      target: TcpAssignment;
    }> {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const task = await seedTask(company.id, { status: 'in-progress' });
      const target = await seedAssignment({
        taskId: task.id,
        companyId: company.id,
        roleId: role.id,
        orderIndex: 0,
        status: 'in-qa',
        qaStatus: 'accepted',
        summary: 'done',
        prepared: [{ type: 'assignment-working-path', value: 'out.txt' }],
      });
      const agent = await agentRepo.save(
        agentRepo.create({
          companyId: company.id,
          roleId: role.id,
          assignmentId: target.id,
          initialPrompt: 'x',
          status: AgentStatus.Paused,
        }),
      );
      await assignmentRepo.update(target.id, { agentId: agent.id });
      return { company, task, target: { ...target, agentId: agent.id } };
    }

    it('promotes files, records approved, succeeds, completes the agent, finalises', async () => {
      const { task, target } = await seedInQa();

      await service.assignmentAssured(target);

      expect(storage.copyFile).toHaveBeenCalledTimes(1);
      const after = (await assignmentRepo.findOneBy({ id: target.id }))!;
      expect(after.status).toBe('succeeded');
      expect(after.approved).toEqual([
        { type: 'assignment-completed-path', value: 'out.txt' },
      ]);
      expect(pauseResume.completeAgent).toHaveBeenCalledWith(
        target.agentId,
        'done',
      );
      const taskAfter = (await taskRepo.findOneBy({ id: task.id }))!;
      expect(taskAfter.status).toBe('succeeded');
      expect(taskAfter.completed).not.toBeNull();

      // Regression: recordAssignmentState must report the *new* status
      // ('succeeded'), not the stale in-memory 'in-qa' the atomic claim
      // updated only in the DB. Now recorded as an entity:'assignment'
      // state_change whose summary carries the status.
      const assignmentStateCall = (audit.record.mock.calls as unknown[][]).find(
        (c) =>
          c[3] === AuditEventType.StateChange &&
          (c[4] as { entity?: string }).entity === 'assignment' &&
          (c[4] as { assignmentId?: string }).assignmentId === target.id &&
          (c[4] as { newStatus?: string }).newStatus === 'succeeded',
      );
      expect(assignmentStateCall).toBeDefined();
      expect(assignmentStateCall![4]).toMatchObject({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        summary: expect.objectContaining({
          id: target.id,
          status: 'succeeded',
        }),
      });
    });

    it('is idempotent — a duplicate accept does not re-run side effects', async () => {
      const { target } = await seedInQa();
      await service.assignmentAssured(target);
      pauseResume.completeAgent.mockClear();

      // Second call: target is now succeeded, not in-qa → no-op.
      await service.assignmentAssured(target);
      expect(pauseResume.completeAgent).not.toHaveBeenCalled();
    });

    it('advance(): dispatches a finalise agent (not mechanical succeed) when task.expected is non-empty', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const task = await seedTask(company.id, {
        status: 'in-progress',
        plannerRoleId: role.id,
        expected: [{ type: 'task-completed-path', value: 'report.txt' }],
      });
      const target = await seedAssignment({
        taskId: task.id,
        companyId: company.id,
        roleId: role.id,
        orderIndex: 0,
        status: 'in-qa',
        qaStatus: 'accepted',
        summary: 'done',
        prepared: [{ type: 'assignment-working-path', value: 'out.txt' }],
      });
      const agent = await agentRepo.save(
        agentRepo.create({
          companyId: company.id,
          roleId: role.id,
          assignmentId: target.id,
          initialPrompt: 'x',
          status: AgentStatus.Paused,
        }),
      );
      await assignmentRepo.update(target.id, { agentId: agent.id });

      await service.assignmentAssured({ ...target, agentId: agent.id });

      const taskAfter = (await taskRepo.findOneBy({ id: task.id }))!;
      // Not mechanically succeeded — a finalise assignment is dispatched instead.
      expect(taskAfter.status).toBe('finalising');
      const finalise = await assignmentRepo.findOneBy({
        taskId: task.id,
        mode: 'finalise',
      });
      expect(finalise).not.toBeNull();
      expect(finalise!.status).toBe('in-progress');
    });
  });

  // --- reject ---------------------------------------------------------------

  describe('assignmentAssured — reject', () => {
    async function seedRejected(
      qaAttempts: number,
      role?: TcpRole,
      company?: TcpCompany,
    ): Promise<TcpAssignment> {
      const co = company ?? (await seedCompany());
      const r = role ?? (await seedRole(co.id));
      const task = await seedTask(co.id, { status: 'in-progress' });
      const target = await seedAssignment({
        taskId: task.id,
        companyId: co.id,
        roleId: r.id,
        orderIndex: 0,
        status: 'in-qa',
        qaStatus: 'rejected',
        qaFeedback: 'needs work',
        qaAttempts,
      });
      const agent = await agentRepo.save(
        agentRepo.create({
          companyId: co.id,
          roleId: r.id,
          assignmentId: target.id,
          initialPrompt: 'x',
          status: AgentStatus.Paused,
        }),
      );
      await assignmentRepo.update(target.id, { agentId: agent.id });
      return { ...target, agentId: agent.id };
    }

    it('returns to in-progress and resumes the agent with feedback under the cap', async () => {
      const target = await seedRejected(0);

      await service.assignmentAssured(target);

      const after = (await assignmentRepo.findOneBy({ id: target.id }))!;
      expect(after.status).toBe('in-progress');
      expect(after.qaAttempts).toBe(1);
      expect(after.qaStatus).toBeNull();
      expect(after.qaFeedback).toBeNull();
      expect(agents.resumeAgent).toHaveBeenCalledWith(
        target.agentId,
        expect.stringContaining('needs work'),
      );
    });

    it('fails the assignment and task once the cap is reached', async () => {
      // Default cap is 3; qaAttempts 2 → nextAttempts 3 >= 3 → fail.
      const target = await seedRejected(2);

      await service.assignmentAssured(target);

      const after = (await assignmentRepo.findOneBy({ id: target.id }))!;
      expect(after.status).toBe('failed');
      expect(after.qaAttempts).toBe(3);
      expect(after.failureReason).toBe('did not pass QA');
      expect(pauseResume.failAgent).toHaveBeenCalledWith(
        target.agentId,
        expect.stringContaining('QA'),
      );
      const taskAfter = (await taskRepo.findOneBy({ id: after.taskId! }))!;
      expect(taskAfter.status).toBe('failed');
      expect(taskAfter.failureReason).toContain(target.id);
    });

    it('honours a role runConfig.maxQaAttempts override', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id, {
        runConfig: { maxQaAttempts: 1 },
      });
      // Cap 1; qaAttempts 0 → nextAttempts 1 >= 1 → fail on first rejection.
      const target = await seedRejected(0, role, company);

      await service.assignmentAssured(target);
      expect((await assignmentRepo.findOneBy({ id: target.id }))!.status).toBe(
        'failed',
      );
    });

    it('honours the TASK_MAX_QA_ATTEMPTS env when no runConfig override', async () => {
      config.get.mockReturnValue('2');
      // Cap 2; qaAttempts 1 → nextAttempts 2 >= 2 → fail.
      const target = await seedRejected(1);

      await service.assignmentAssured(target);
      expect((await assignmentRepo.findOneBy({ id: target.id }))!.status).toBe(
        'failed',
      );
    });
  });

  // --- handleAgentFailed ----------------------------------------------------

  describe('handleAgentFailed', () => {
    it('fails the task when a plan agent fails', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const task = await seedTask(company.id, { status: 'planning' });
      const plan = await seedAssignment({
        taskId: task.id,
        companyId: company.id,
        roleId: role.id,
        mode: 'plan',
        status: 'in-progress',
      });
      const agent = await agentRepo.save(
        agentRepo.create({
          companyId: company.id,
          roleId: role.id,
          assignmentId: plan.id,
          initialPrompt: 'x',
        }),
      );

      await failures.handleAgentFailed(agent.id, 'boom');

      const taskAfter = (await taskRepo.findOneBy({ id: task.id }))!;
      expect(taskAfter.status).toBe('failed');
      expect(taskAfter.failureReason).toContain('planner failed');
      // The plan assignment must not be left stuck in-progress.
      const planAfter = (await assignmentRepo.findOneBy({ id: plan.id }))!;
      expect(planAfter.status).toBe('failed');
      expect(planAfter.failureReason).toBe('boom');
    });

    it('fails the assignment and task when an implement agent fails', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const task = await seedTask(company.id, { status: 'in-progress' });
      const step = await seedAssignment({
        taskId: task.id,
        companyId: company.id,
        roleId: role.id,
        orderIndex: 0,
        status: 'in-progress',
      });
      const agent = await agentRepo.save(
        agentRepo.create({
          companyId: company.id,
          roleId: role.id,
          assignmentId: step.id,
          initialPrompt: 'x',
        }),
      );

      await failures.handleAgentFailed(agent.id, 'crashed');

      const stepAfter = (await assignmentRepo.findOneBy({ id: step.id }))!;
      expect(stepAfter.status).toBe('failed');
      expect(stepAfter.failureReason).toBe('crashed');
      expect((await taskRepo.findOneBy({ id: task.id }))!.status).toBe(
        'failed',
      );
    });

    it('does nothing for an orphan (task-less) agent', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const orphan = await seedAssignment({
        companyId: company.id,
        roleId: role.id,
        taskId: null,
        status: 'in-progress',
      });
      const agent = await agentRepo.save(
        agentRepo.create({
          companyId: company.id,
          roleId: role.id,
          assignmentId: orphan.id,
          initialPrompt: 'x',
        }),
      );

      await expect(
        failures.handleAgentFailed(agent.id, 'boom'),
      ).resolves.toBeUndefined();
      expect((await assignmentRepo.findOneBy({ id: orphan.id }))!.status).toBe(
        'in-progress',
      );
    });

    it('fails the target assignment and task when a QA agent fails', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const task = await seedTask(company.id, { status: 'in-progress' });
      const target = await seedAssignment({
        taskId: task.id,
        companyId: company.id,
        roleId: role.id,
        orderIndex: 0,
        status: 'in-qa',
      });
      const qa = await seedAssignment({
        taskId: task.id,
        companyId: company.id,
        roleId: role.id,
        mode: 'qa',
        targetAssignmentId: target.id,
        status: 'in-progress',
      });
      const agent = await agentRepo.save(
        agentRepo.create({
          companyId: company.id,
          roleId: role.id,
          assignmentId: qa.id,
          initialPrompt: 'x',
        }),
      );

      await failures.handleAgentFailed(agent.id, 'qa crashed');

      const targetAfter = (await assignmentRepo.findOneBy({ id: target.id }))!;
      expect(targetAfter.status).toBe('failed');
      expect(targetAfter.failureReason).toContain('qa crashed');
      // The qa assignment itself must fail too, not just the reviewed target.
      const qaAfter = (await assignmentRepo.findOneBy({ id: qa.id }))!;
      expect(qaAfter.status).toBe('failed');
      expect(qaAfter.failureReason).toBe('qa crashed');
      expect((await taskRepo.findOneBy({ id: task.id }))!.status).toBe(
        'failed',
      );
    });

    it('is a no-op when the target assignment is no longer in-qa (lost the race to a concurrent QA accept)', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const task = await seedTask(company.id, { status: 'in-progress' });
      const target = await seedAssignment({
        taskId: task.id,
        companyId: company.id,
        roleId: role.id,
        orderIndex: 0,
        status: 'succeeded', // already resolved by a concurrent accept
      });
      const qa = await seedAssignment({
        taskId: task.id,
        companyId: company.id,
        roleId: role.id,
        mode: 'qa',
        targetAssignmentId: target.id,
        status: 'in-progress',
      });
      const agent = await agentRepo.save(
        agentRepo.create({
          companyId: company.id,
          roleId: role.id,
          assignmentId: qa.id,
          initialPrompt: 'x',
        }),
      );

      await failures.handleAgentFailed(agent.id, 'qa crashed late');

      expect((await assignmentRepo.findOneBy({ id: target.id }))!.status).toBe(
        'succeeded',
      );
      // The reviewed assignment already passed, so nothing is failed — not the
      // task, and not the qa assignment (its late failure is a no-op).
      expect((await assignmentRepo.findOneBy({ id: qa.id }))!.status).toBe(
        'in-progress',
      );
      expect((await taskRepo.findOneBy({ id: task.id }))!.status).toBe(
        'in-progress',
      );
    });
  });

  // --- cancelTask ------------------------------------------------------------

  describe('cancelTask', () => {
    it('cancels every non-terminal assignment and its agent, and the task itself', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const task = await seedTask(company.id, { status: 'in-progress' });
      const step = await seedAssignment({
        taskId: task.id,
        companyId: company.id,
        roleId: role.id,
        orderIndex: 0,
        status: 'in-progress',
      });
      const agent = await agentRepo.save(
        agentRepo.create({
          companyId: company.id,
          roleId: role.id,
          assignmentId: step.id,
          initialPrompt: 'x',
        }),
      );
      await assignmentRepo.update(step.id, { agentId: agent.id });

      await service.cancelTask(await taskRepo.findOneByOrFail({ id: task.id }));

      expect(
        (await assignmentRepo.findOneByOrFail({ id: step.id })).status,
      ).toBe('cancelled');
      expect((await agentRepo.findOneByOrFail({ id: agent.id })).status).toBe(
        AgentStatus.Cancelled,
      );
      // cancelTask itself only cascades to assignments/agents and records the
      // task's cancellation — the task row's own status is set by
      // TaskService.cancel()'s atomic claim, one layer up, before this is
      // ever called; that's exercised by the e2e/API-facing tests instead.
      expect(audit.record).toHaveBeenCalledWith(
        company.id,
        'orchestrator',
        null,
        expect.anything(),
        expect.objectContaining({ taskId: task.id, newStatus: 'cancelled' }),
        expect.objectContaining({ taskId: task.id }),
      );
    });

    it('does not cancel an assignment that completed concurrently — a stale in-memory snapshot loses the atomic claim', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const task = await seedTask(company.id, { status: 'in-progress' });
      const step = await seedAssignment({
        taskId: task.id,
        companyId: company.id,
        roleId: role.id,
        orderIndex: 0,
        status: 'in-progress',
      });

      // Simulates the exact race this atomic-claim mechanism guards against:
      // cancelTask's own assignments fetch returns an in-progress snapshot,
      // but by the time it tries to claim that assignment, a concurrent
      // completion has already moved the real row on to 'succeeded'.
      jest
        .spyOn(assignmentRepo, 'find')
        .mockResolvedValueOnce([{ ...step, status: 'in-progress' }]);
      await assignmentRepo.update(step.id, { status: 'succeeded' });

      await service.cancelTask(await taskRepo.findOneByOrFail({ id: task.id }));

      // The claim (WHERE status = 'in-progress') affected 0 rows, so the
      // concurrently-completed assignment is left exactly as it was.
      expect(
        (await assignmentRepo.findOneByOrFail({ id: step.id })).status,
      ).toBe('succeeded');
      // cancelTask still records the task's own cancellation regardless of
      // how many of its assignments it actually claimed.
      expect(audit.record).toHaveBeenCalledWith(
        company.id,
        'orchestrator',
        null,
        expect.anything(),
        expect.objectContaining({ taskId: task.id, newStatus: 'cancelled' }),
        expect.objectContaining({ taskId: task.id }),
      );
    });
  });

  // --- handleAgentCompleted -------------------------------------------------

  describe('handleAgentCompleted', () => {
    it('fails a still-planning task when a planner completes with no plan', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const task = await seedTask(company.id, { status: 'planning' });
      const plan = await seedAssignment({
        taskId: task.id,
        companyId: company.id,
        roleId: role.id,
        mode: 'plan',
        status: 'in-progress',
      });
      const agent = await agentRepo.save(
        agentRepo.create({
          companyId: company.id,
          roleId: role.id,
          assignmentId: plan.id,
          initialPrompt: 'x',
        }),
      );

      await failures.handleAgentCompleted(agent.id);

      const taskAfter = (await taskRepo.findOneBy({ id: task.id }))!;
      expect(taskAfter.status).toBe('failed');
      expect(taskAfter.failureReason).toContain('without producing a plan');
      // The plan assignment itself must fail too, not just the task.
      const planAfter = (await assignmentRepo.findOneBy({ id: plan.id }))!;
      expect(planAfter.status).toBe('failed');
      expect(planAfter.failureReason).toBe('created a plan with 0 assignments');
    });

    it('forces the plan assignment to failed even when create_plan marked it succeeded (empty plan)', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const task = await seedTask(company.id, { status: 'planning' });
      // create_plan fired with an empty plan: it marks its own assignment
      // succeeded and completes the agent, leaving a `succeeded` assignment
      // beside a task that will fail for having no plan.
      const plan = await seedAssignment({
        taskId: task.id,
        companyId: company.id,
        roleId: role.id,
        mode: 'plan',
        status: 'succeeded',
      });
      const agent = await agentRepo.save(
        agentRepo.create({
          companyId: company.id,
          roleId: role.id,
          assignmentId: plan.id,
          initialPrompt: 'x',
        }),
      );

      await failures.handleAgentCompleted(agent.id);

      expect((await taskRepo.findOneBy({ id: task.id }))!.status).toBe(
        'failed',
      );
      expect((await assignmentRepo.findOneBy({ id: plan.id }))!.status).toBe(
        'failed',
      );
    });

    it('is a no-op when the planner produced a plan (task already in-progress)', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const task = await seedTask(company.id, { status: 'in-progress' });
      const plan = await seedAssignment({
        taskId: task.id,
        companyId: company.id,
        roleId: role.id,
        mode: 'plan',
        status: 'succeeded',
      });
      // The plan the planner created: one implement assignment.
      await seedAssignment({
        taskId: task.id,
        companyId: company.id,
        roleId: role.id,
        mode: 'implement',
        orderIndex: 0,
        status: 'ready',
      });
      const agent = await agentRepo.save(
        agentRepo.create({
          companyId: company.id,
          roleId: role.id,
          assignmentId: plan.id,
          initialPrompt: 'x',
        }),
      );

      await failures.handleAgentCompleted(agent.id);

      expect((await taskRepo.findOneBy({ id: task.id }))!.status).toBe(
        'in-progress',
      );
    });

    it('does nothing for a non-planner (implement) completion', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const task = await seedTask(company.id, { status: 'in-progress' });
      const step = await seedAssignment({
        taskId: task.id,
        companyId: company.id,
        roleId: role.id,
        mode: 'implement',
        orderIndex: 0,
        status: 'in-qa',
      });
      const agent = await agentRepo.save(
        agentRepo.create({
          companyId: company.id,
          roleId: role.id,
          assignmentId: step.id,
          initialPrompt: 'x',
        }),
      );

      await expect(
        failures.handleAgentCompleted(agent.id),
      ).resolves.toBeUndefined();
      expect((await taskRepo.findOneBy({ id: task.id }))!.status).toBe(
        'in-progress',
      );
    });
  });

  // --- finalise mode --------------------------------------------------------

  describe('finalise', () => {
    async function seedFinalising() {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const task = await seedTask(company.id, {
        status: 'finalising',
        plannerRoleId: role.id,
        expected: [{ type: 'task-completed-path', value: 'report.txt' }],
      });
      const finalise = await seedAssignment({
        taskId: task.id,
        companyId: company.id,
        roleId: role.id,
        mode: 'finalise',
        status: 'succeeded',
        summary: 'done',
      });
      const agent = await agentRepo.save(
        agentRepo.create({
          companyId: company.id,
          roleId: role.id,
          assignmentId: finalise.id,
          initialPrompt: 'x',
        }),
      );
      await assignmentRepo.update(finalise.id, { agentId: agent.id });
      return { company, task, finalise, agent };
    }

    it('assignmentFinalised: succeeds the task with completed from the completed/ dir', async () => {
      const { task, finalise } = await seedFinalising();
      storage.listFiles.mockResolvedValue([
        { key: 'k/report.txt', name: 'report.txt', size: 1, lastModified: 'x' },
      ]);

      await service.assignmentFinalised(
        await assignmentRepo.findOneByOrFail({ id: finalise.id }),
      );

      const fresh = await taskRepo.findOneByOrFail({ id: task.id });
      expect(fresh.status).toBe('succeeded');
      expect(fresh.completed).toEqual([
        { type: 'task-completed-path', value: 'report.txt' },
      ]);
      expect(pauseResume.completeAgent).toHaveBeenCalled();
    });

    it('handleAgentFailed(finalise): fails the task and the finalise assignment, keeping files promoted', async () => {
      const { task, finalise, agent } = await seedFinalising();
      // A finalise agent fails while its assignment is still in flight.
      await assignmentRepo.update(finalise.id, { status: 'in-progress' });
      storage.listFiles.mockResolvedValue([
        { key: 'k/report.txt', name: 'report.txt', size: 1, lastModified: 'x' },
      ]);

      await failures.handleAgentFailed(agent.id, 'boom');

      const fresh = await taskRepo.findOneByOrFail({ id: task.id });
      expect(fresh.status).toBe('failed');
      expect(fresh.failureReason).toContain('finalise failed');
      // Files still recorded as completed.
      expect(fresh.completed).toEqual([
        { type: 'task-completed-path', value: 'report.txt' },
      ]);
      // The finalise assignment must not be left stuck in-progress.
      const freshAssignment = await assignmentRepo.findOneByOrFail({
        id: finalise.id,
      });
      expect(freshAssignment.status).toBe('failed');
      expect(freshAssignment.failureReason).toBe('boom');
    });
  });

  // --- reconcileTask --------------------------------------------------------

  describe('reconcileTask', () => {
    it('fails a planning task whose planner agent is dead', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const task = await seedTask(company.id, { status: 'planning' });
      const plan = await seedAssignment({
        taskId: task.id,
        companyId: company.id,
        roleId: role.id,
        mode: 'plan',
        status: 'in-progress',
      });
      const agent = await agentRepo.save(
        agentRepo.create({
          companyId: company.id,
          roleId: role.id,
          assignmentId: plan.id,
          initialPrompt: 'x',
          status: AgentStatus.Failed,
        }),
      );
      await assignmentRepo.update(plan.id, { agentId: agent.id });

      await recovery.reconcileTask(task);
      expect((await taskRepo.findOneBy({ id: task.id }))!.status).toBe(
        'failed',
      );
      // The plan assignment must not be left stuck in-progress.
      const planAfter = (await assignmentRepo.findOneBy({ id: plan.id }))!;
      expect(planAfter.status).toBe('failed');
      expect(planAfter.failureReason).toBe('agent died before restart');
    });

    it('dispatches the next ready assignment when nothing is running', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const task = await seedTask(company.id, { status: 'in-progress' });
      const step = await seedAssignment({
        taskId: task.id,
        companyId: company.id,
        roleId: role.id,
        orderIndex: 0,
        status: 'ready',
      });

      await recovery.reconcileTask(task);
      expect((await assignmentRepo.findOneBy({ id: step.id }))!.status).toBe(
        'in-progress',
      );
    });

    it('re-dispatches QA for an in-qa assignment with no live QA agent', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const task = await seedTask(company.id, { status: 'in-progress' });
      const step = await seedAssignment({
        taskId: task.id,
        companyId: company.id,
        roleId: role.id,
        orderIndex: 0,
        status: 'in-qa',
      });

      await recovery.reconcileTask(task);
      const qa = await assignmentRepo.findOneBy({
        targetAssignmentId: step.id,
        mode: 'qa',
      });
      expect(qa).not.toBeNull();
      expect(qa!.status).toBe('in-progress');
    });

    it('fails a finalising task whose finalise agent is dead', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const task = await seedTask(company.id, {
        status: 'finalising',
        expected: [{ type: 'task-completed-path', value: 'report.txt' }],
      });
      const finalise = await seedAssignment({
        taskId: task.id,
        companyId: company.id,
        roleId: role.id,
        mode: 'finalise',
        status: 'in-progress',
      });
      const agent = await agentRepo.save(
        agentRepo.create({
          companyId: company.id,
          roleId: role.id,
          assignmentId: finalise.id,
          initialPrompt: 'x',
          status: AgentStatus.Failed,
        }),
      );
      await assignmentRepo.update(finalise.id, { agentId: agent.id });
      storage.listFiles.mockResolvedValue([
        { key: 'k/report.txt', name: 'report.txt', size: 1, lastModified: 'x' },
      ]);

      await recovery.reconcileTask(task);

      const fresh = await taskRepo.findOneByOrFail({ id: task.id });
      expect(fresh.status).toBe('failed');
      expect(fresh.failureReason).toContain(
        'finalise agent died before restart',
      );
      expect(fresh.completed).toEqual([
        { type: 'task-completed-path', value: 'report.txt' },
      ]);
      // The finalise assignment must not be left stuck in-progress.
      const freshAssignment = await assignmentRepo.findOneByOrFail({
        id: finalise.id,
      });
      expect(freshAssignment.status).toBe('failed');
      expect(freshAssignment.failureReason).toBe('agent died before restart');
    });
  });
});
