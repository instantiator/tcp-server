import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import {
  AgentStatus,
  LcpAgent,
  LcpAssignment,
  LcpCompany,
  LcpRole,
  LcpTask,
  type LcpMaterialArtifact,
} from '@lcp/shared';
import { ConfigService } from '@nestjs/config';
import { type UUID } from 'crypto';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../storage/storage.service';
import { AgentOrchestrationService } from './agent-orchestration.service';
import { PauseAndResumeService } from './pause-and-resume.service';
import { TaskOrchestrationService } from './task-orchestration.service';
import type { LcpAgentTemplate } from '../templates/LcpAgentTemplate';

const ENTITIES = [LcpCompany, LcpRole, LcpAgent, LcpTask, LcpAssignment];

/**
 * Exercises {@link TaskOrchestrationService} against a real in-memory SQLite DB
 * so the atomic conditional UPDATEs, state transitions, materials merge, and
 * recovery decisions are covered end-to-end. Only the outward-facing
 * collaborators (agent dispatch, pause/resume, storage, audit, config) are
 * mocked — `createAgent` still persists a real agent row so the assignment↔agent
 * back-link the completion/QA paths rely on is genuine.
 */
describe('TaskOrchestrationService', () => {
  let moduleRef: TestingModule;
  let service: TaskOrchestrationService;
  let taskRepo: Repository<LcpTask>;
  let assignmentRepo: Repository<LcpAssignment>;
  let agentRepo: Repository<LcpAgent>;
  let companyRepo: Repository<LcpCompany>;
  let roleRepo: Repository<LcpRole>;

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
    taskRepo = moduleRef.get(getRepositoryToken(LcpTask));
    assignmentRepo = moduleRef.get(getRepositoryToken(LcpAssignment));
    agentRepo = moduleRef.get(getRepositoryToken(LcpAgent));
    companyRepo = moduleRef.get(getRepositoryToken(LcpCompany));
    roleRepo = moduleRef.get(getRepositoryToken(LcpRole));
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(() => {
    // createAgent persists a real agent row (as DbService.createAgent would),
    // so the orchestrator's back-link and later lookups operate on real data.
    agents = {
      createAgent: jest.fn().mockImplementation((t: LcpAgentTemplate) =>
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

    service = new TaskOrchestrationService(
      taskRepo,
      assignmentRepo,
      agentRepo,
      companyRepo,
      roleRepo,
      agents as unknown as AgentOrchestrationService,
      pauseResume as unknown as PauseAndResumeService,
      storage as unknown as StorageService,
      audit as unknown as AuditService,
      config as unknown as ConfigService,
    );
  });

  // --- fixtures -------------------------------------------------------------

  function slug(): string {
    return Math.random().toString(36).slice(2, 8);
  }
  async function seedCompany(
    partial: Partial<LcpCompany> = {},
  ): Promise<LcpCompany> {
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
    partial: Partial<LcpRole> = {},
  ): Promise<LcpRole> {
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
    partial: Partial<LcpTask> = {},
  ): Promise<LcpTask> {
    return taskRepo.save(
      taskRepo.create({
        companyId,
        request: 'do it',
        status: 'planning',
        materials: [],
        expected: [],
        ...partial,
      }),
    );
  }
  async function seedAssignment(
    partial: Partial<LcpAssignment>,
  ): Promise<LcpAssignment> {
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
      const hint: LcpMaterialArtifact = {
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
      company: LcpCompany;
      task: LcpTask;
      target: LcpAssignment;
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
    });

    it('is idempotent — a duplicate accept does not re-run side effects', async () => {
      const { target } = await seedInQa();
      await service.assignmentAssured(target);
      pauseResume.completeAgent.mockClear();

      // Second call: target is now succeeded, not in-qa → no-op.
      await service.assignmentAssured(target);
      expect(pauseResume.completeAgent).not.toHaveBeenCalled();
    });
  });

  // --- reject ---------------------------------------------------------------

  describe('assignmentAssured — reject', () => {
    async function seedRejected(
      qaAttempts: number,
      role?: LcpRole,
      company?: LcpCompany,
    ): Promise<LcpAssignment> {
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

      await service.handleAgentFailed(agent.id, 'boom');

      const taskAfter = (await taskRepo.findOneBy({ id: task.id }))!;
      expect(taskAfter.status).toBe('failed');
      expect(taskAfter.failureReason).toContain('planner failed');
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

      await service.handleAgentFailed(agent.id, 'crashed');

      expect((await assignmentRepo.findOneBy({ id: step.id }))!.status).toBe(
        'failed',
      );
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
        service.handleAgentFailed(agent.id, 'boom'),
      ).resolves.toBeUndefined();
      expect((await assignmentRepo.findOneBy({ id: orphan.id }))!.status).toBe(
        'in-progress',
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

      await service.handleAgentCompleted(agent.id);

      const taskAfter = (await taskRepo.findOneBy({ id: task.id }))!;
      expect(taskAfter.status).toBe('failed');
      expect(taskAfter.failureReason).toContain('without producing a plan');
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

      await service.handleAgentCompleted(agent.id);

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
        service.handleAgentCompleted(agent.id),
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

    it('handleAgentFailed(finalise): fails the task but keeps files promoted', async () => {
      const { task, agent } = await seedFinalising();
      storage.listFiles.mockResolvedValue([
        { key: 'k/report.txt', name: 'report.txt', size: 1, lastModified: 'x' },
      ]);

      await service.handleAgentFailed(agent.id, 'boom');

      const fresh = await taskRepo.findOneByOrFail({ id: task.id });
      expect(fresh.status).toBe('failed');
      expect(fresh.failureReason).toContain('finalise failed');
      // Files still recorded as completed.
      expect(fresh.completed).toEqual([
        { type: 'task-completed-path', value: 'report.txt' },
      ]);
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

      await service.reconcileTask(task);
      expect((await taskRepo.findOneBy({ id: task.id }))!.status).toBe(
        'failed',
      );
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

      await service.reconcileTask(task);
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

      await service.reconcileTask(task);
      const qa = await assignmentRepo.findOneBy({
        targetAssignmentId: step.id,
        mode: 'qa',
      });
      expect(qa).not.toBeNull();
      expect(qa!.status).toBe('in-progress');
    });
  });
});
