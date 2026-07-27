import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import {
  AgentStatus,
  TcpAgent,
  TcpAssignment,
  TcpCompany,
  TcpRole,
  TcpTask,
} from '@lcp/shared';
import { randomUUID, type UUID } from 'crypto';
import { Repository } from 'typeorm';
import { DbService } from '../db/db.service';
import { StorageService } from '../storage/storage.service';
import { PauseAndResumeService } from './pause-and-resume.service';
import { TaskDispatcher } from './task-dispatcher.service';
import { AssignmentService } from './assignment.service';

const ENTITIES = [TcpCompany, TcpRole, TcpAgent, TcpTask, TcpAssignment];

/**
 * Exercises {@link AssignmentService} against a real in-memory SQLite DB so the
 * atomic conditional UPDATEs, the completion output-gate, and the state
 * transitions are covered end-to-end (only StorageService, DbService,
 * TaskDispatcher, and PauseAndResumeService — which have no DB of their own
 * here — are mocked).
 */
describe('AssignmentService', () => {
  let moduleRef: TestingModule;
  let service: AssignmentService;
  let agentRepo: Repository<TcpAgent>;
  let assignmentRepo: Repository<TcpAssignment>;
  let taskRepo: Repository<TcpTask>;
  let companyRepo: Repository<TcpCompany>;
  let roleRepo: Repository<TcpRole>;

  let storage: { checkMissingFiles: jest.Mock; listFiles: jest.Mock };
  let db: {
    getCompany: jest.Mock;
    findRoleByIdOrSlug: jest.Mock;
    listRoles: jest.Mock;
  };
  let dispatcher: {
    taskPlanned: jest.Mock;
    assignmentReadyForQa: jest.Mock;
    assignmentAssured: jest.Mock;
    assignmentFinalised: jest.Mock;
  };
  let pauseResume: { completeAgent: jest.Mock };

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

    agentRepo = moduleRef.get(getRepositoryToken(TcpAgent));
    assignmentRepo = moduleRef.get(getRepositoryToken(TcpAssignment));
    taskRepo = moduleRef.get(getRepositoryToken(TcpTask));
    companyRepo = moduleRef.get(getRepositoryToken(TcpCompany));
    roleRepo = moduleRef.get(getRepositoryToken(TcpRole));
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(() => {
    storage = {
      checkMissingFiles: jest.fn().mockResolvedValue([]),
      listFiles: jest.fn().mockResolvedValue([]),
    };
    db = {
      getCompany: jest.fn(),
      findRoleByIdOrSlug: jest.fn(),
      listRoles: jest.fn().mockResolvedValue([]),
    };
    dispatcher = {
      taskPlanned: jest.fn().mockResolvedValue(undefined),
      assignmentReadyForQa: jest.fn().mockResolvedValue(undefined),
      assignmentAssured: jest.fn().mockResolvedValue(undefined),
      assignmentFinalised: jest.fn().mockResolvedValue(undefined),
    };
    pauseResume = { completeAgent: jest.fn().mockResolvedValue(undefined) };
    service = new AssignmentService(
      agentRepo,
      assignmentRepo,
      taskRepo,
      db as unknown as DbService,
      storage as unknown as StorageService,
      dispatcher as unknown as TaskDispatcher,
      pauseResume as unknown as PauseAndResumeService,
    );
  });

  // --- fixtures -----------------------------------------------------------

  async function seedCompany(): Promise<TcpCompany> {
    return companyRepo.save(
      companyRepo.create({
        slug: `acme-${randomSlug()}`,
        name: 'ACME',
        description: 'A test company',
      }),
    );
  }
  async function seedRole(companyId: UUID): Promise<TcpRole> {
    return roleRepo.save(
      roleRepo.create({
        companyId,
        slug: `role-${randomSlug()}`,
        name: 'analyst',
        description: 'x',
      }),
    );
  }
  async function seedTask(
    companyId: UUID,
    status: TcpTask['status'] = 'planning',
  ): Promise<TcpTask> {
    return taskRepo.save(
      taskRepo.create({
        companyId,
        request: 'do it',
        shortcode: '000',
        status,
      }),
    );
  }
  async function seedAssignment(
    partial: Partial<TcpAssignment>,
  ): Promise<TcpAssignment> {
    const company = partial.companyId
      ? { id: partial.companyId }
      : await seedCompany();
    const role = partial.roleId
      ? { id: partial.roleId }
      : await seedRole(company.id);
    return assignmentRepo.save(
      assignmentRepo.create({
        companyId: company.id,
        roleId: role.id,
        mode: 'implement',
        prompt: 'work',
        status: 'in-progress',
        materials: [],
        expected: [],
        prepared: [],
        approved: [],
        ...partial,
      }),
    );
  }
  async function seedAgent(
    companyId: UUID,
    roleId: UUID,
    assignmentId: UUID,
  ): Promise<TcpAgent> {
    return agentRepo.save(
      agentRepo.create({ companyId, roleId, assignmentId, initialPrompt: 'x' }),
    );
  }
  function randomSlug(): string {
    return Math.random().toString(36).slice(2, 8);
  }

  // --- column-transformer sanitisation ------------------------------------

  describe('control-char sanitisation (column transformers)', () => {
    it('strips control chars from text + artifact columns on save', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const ESC = String.fromCharCode(0x1b);
      const saved = await assignmentRepo.save(
        assignmentRepo.create({
          companyId: company.id,
          roleId: role.id,
          mode: 'implement',
          prompt: `do${ESC}[31m it`,
          status: 'in-progress',
          summary: `all${ESC} done`,
          materials: [],
          expected: [],
          prepared: [{ type: 'inline-text', value: `res${ESC}ult` }],
          approved: [],
        }),
      );
      const fresh = await assignmentRepo.findOneByOrFail({ id: saved.id });
      expect(fresh.prompt).toBe('do[31m it');
      expect(fresh.summary).toBe('all done');
      expect(fresh.prepared[0].value).toBe('result');
    });
  });

  // --- getAgentAssignment -------------------------------------------------

  describe('getAgentAssignment', () => {
    it('returns the assignment and its task', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const task = await seedTask(company.id);
      const assignment = await seedAssignment({
        companyId: company.id,
        roleId: role.id,
        taskId: task.id,
        mode: 'plan',
      });
      const agent = await seedAgent(company.id, role.id, assignment.id);

      const result = await service.getAgentAssignment(agent.id);
      expect(result.assignment.id).toBe(assignment.id);
      expect(result.task?.id).toBe(task.id);
    });

    it('404s for an unknown agent', async () => {
      await expect(
        service.getAgentAssignment(randomUUID()),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // --- resolveStorageScope ------------------------------------------------

  describe('resolveStorageScope', () => {
    it('scopes an implement task assignment to its own working directory (read/write)', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const task = await seedTask(company.id);
      const assignment = await seedAssignment({
        companyId: company.id,
        roleId: role.id,
        taskId: task.id,
        orderIndex: 2,
        materials: [{ type: 'task-materials-path', value: 'brief.md' }],
      });
      const agent = await seedAgent(company.id, role.id, assignment.id);
      db.getCompany.mockResolvedValue({ id: company.id, slug: 'acme' });

      const scope = await service.resolveStorageScope(agent.id);
      expect(scope.readOnly).toBe(false);
      expect(scope.mode).toBe('implement');
      expect(scope.workingPrefix).toBe(
        `acme/tasks/${task.id}/assignments/2/working/`,
      );
      expect(scope.materials).toEqual([
        { name: 'brief.md', key: `acme/tasks/${task.id}/materials/brief.md` },
      ]);
    });

    it('scopes an orphan assignment to the orphan working directory', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const assignment = await seedAssignment({
        companyId: company.id,
        roleId: role.id,
        taskId: null,
      });
      const agent = await seedAgent(company.id, role.id, assignment.id);
      db.getCompany.mockResolvedValue({ id: company.id, slug: 'acme' });

      const scope = await service.resolveStorageScope(agent.id);
      expect(scope.workingPrefix).toBe(
        `acme/assignments/${assignment.id}/working/`,
      );
    });

    it('scopes a qa caller to the target assignment, read-only', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const task = await seedTask(company.id);
      const target = await seedAssignment({
        companyId: company.id,
        roleId: role.id,
        taskId: task.id,
        orderIndex: 0,
      });
      const qaAssignment = await seedAssignment({
        companyId: company.id,
        roleId: role.id,
        taskId: task.id,
        mode: 'qa',
        targetAssignmentId: target.id,
      });
      const agent = await seedAgent(company.id, role.id, qaAssignment.id);
      db.getCompany.mockResolvedValue({ id: company.id, slug: 'acme' });

      const scope = await service.resolveStorageScope(agent.id);
      expect(scope.readOnly).toBe(true);
      expect(scope.mode).toBe('qa');
      expect(scope.workingPrefix).toBe(
        `acme/tasks/${task.id}/assignments/0/working/`,
      );
    });

    it('scopes a plan assignment to its own working directory, read-only', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const task = await seedTask(company.id);
      const assignment = await seedAssignment({
        companyId: company.id,
        roleId: role.id,
        taskId: task.id,
        mode: 'plan',
        orderIndex: 0,
      });
      const agent = await seedAgent(company.id, role.id, assignment.id);
      db.getCompany.mockResolvedValue({ id: company.id, slug: 'acme' });

      const scope = await service.resolveStorageScope(agent.id);
      expect(scope.readOnly).toBe(true);
      expect(scope.mode).toBe('plan');
      expect(scope.workingPrefix).toBe(
        `acme/tasks/${task.id}/assignments/0/working/`,
      );
    });

    it("scopes a finalise assignment to the task's completed/ directory, read-write", async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const task = await seedTask(company.id);
      const assignment = await seedAssignment({
        companyId: company.id,
        roleId: role.id,
        taskId: task.id,
        mode: 'finalise',
      });
      const agent = await seedAgent(company.id, role.id, assignment.id);
      db.getCompany.mockResolvedValue({ id: company.id, slug: 'acme' });

      const scope = await service.resolveStorageScope(agent.id);
      expect(scope.readOnly).toBe(false);
      expect(scope.mode).toBe('finalise');
      expect(scope.workingPrefix).toBe(`acme/tasks/${task.id}/completed/`);
    });

    it('resolves inline-text materials to stable synthetic names', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const assignment = await seedAssignment({
        companyId: company.id,
        roleId: role.id,
        taskId: null,
        materials: [
          { type: 'inline-text', value: 'first note' },
          { type: 'inline-text', value: 'second note' },
        ],
      });
      const agent = await seedAgent(company.id, role.id, assignment.id);
      db.getCompany.mockResolvedValue({ id: company.id, slug: 'acme' });

      const scope = await service.resolveStorageScope(agent.id);
      expect(scope.materials).toEqual([
        { name: 'inline-1', key: null, inlineText: 'first note' },
        { name: 'inline-2', key: null, inlineText: 'second note' },
      ]);
    });

    it('fails the whole scope lookup on an unresolvable material, rather than silently omitting it', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const task = await seedTask(company.id);
      const assignment = await seedAssignment({
        companyId: company.id,
        roleId: role.id,
        taskId: task.id,
        orderIndex: 1,
        materials: [{ type: 'assignment-completed-path', value: 'draft.md' }],
      });
      const agent = await seedAgent(company.id, role.id, assignment.id);
      db.getCompany.mockResolvedValue({ id: company.id, slug: 'acme' });

      // No earlier implement assignment ever approved 'draft.md'.
      await expect(
        service.resolveStorageScope(agent.id),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });
  });

  // --- planTask -----------------------------------------------------------

  describe('planTask', () => {
    async function setupPlanner(taskStatus: TcpTask['status'] = 'planning') {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const task = await seedTask(company.id, taskStatus);
      const planAssignment = await seedAssignment({
        companyId: company.id,
        roleId: role.id,
        taskId: task.id,
        mode: 'plan',
        status: 'in-progress',
      });
      const agent = await seedAgent(company.id, role.id, planAssignment.id);
      db.findRoleByIdOrSlug.mockResolvedValue({ id: role.id });
      return { company, role, task, agent };
    }

    it('creates ordered implement assignments and claims the task', async () => {
      const { task, agent } = await setupPlanner();
      const result = await service.planTask(task.id, agent.id, [
        { prompt: 'a', role: 'analyst', expected: [] },
        {
          prompt: 'b',
          role: 'analyst',
          expected: [{ type: 'assignment-working-path', value: 'out.md' }],
        },
      ]);

      expect(result.created).toBe(2);
      const created = await assignmentRepo.find({
        where: { taskId: task.id, mode: 'implement' },
        order: { orderIndex: 'ASC' },
      });
      expect(created.map((a) => a.orderIndex)).toEqual([0, 1]);
      expect(created.every((a) => a.status === 'ready')).toBe(true);
      const freshTask = await taskRepo.findOneByOrFail({ id: task.id });
      expect(freshTask.status).toBe('in-progress');
      expect(dispatcher.taskPlanned).toHaveBeenCalledTimes(1);
    });

    it('completes the planner agent and marks its plan assignment succeeded (ends the run)', async () => {
      const { task, agent } = await setupPlanner();
      await service.planTask(task.id, agent.id, [
        { prompt: 'a', role: 'analyst', expected: [] },
      ]);

      // create_plan IS the planner's completion — the plan assignment is done
      // and the agent is completed so its worker loop exits promptly.
      const planAssignment = await assignmentRepo.findOneByOrFail({
        taskId: task.id,
        mode: 'plan',
      });
      expect(planAssignment.status).toBe('succeeded');
      expect(pauseResume.completeAgent).toHaveBeenCalledWith(
        agent.id,
        expect.stringContaining('Plan created'),
      );
    });

    it('accepts an aliased artifact type and stores it canonicalised', async () => {
      const { task, agent } = await setupPlanner();
      await service.planTask(task.id, agent.id, [
        {
          prompt: 'a',
          role: 'analyst',
          expected: [{ type: 'text', value: 'a summary' }] as never,
        },
      ]);
      const created = await assignmentRepo.findOneByOrFail({
        taskId: task.id,
        mode: 'implement',
      });
      expect(created.expected[0].type).toBe('inline-text');
    });

    it('accepts the short `file` artifact type alias and stores it canonicalised', async () => {
      const { task, agent } = await setupPlanner();
      await service.planTask(task.id, agent.id, [
        {
          prompt: 'a',
          role: 'analyst',
          expected: [{ type: 'file', value: 'out.md' }] as never,
        },
      ]);
      const created = await assignmentRepo.findOneByOrFail({
        taskId: task.id,
        mode: 'implement',
      });
      expect(created.expected[0].type).toBe('assignment-working-path');
    });

    it('reports the short display name (not the internal type) for an invalid artifact type', async () => {
      const { task, agent } = await setupPlanner();
      await expect(
        service.planTask(task.id, agent.id, [
          {
            prompt: 'a',
            role: 'analyst',
            expected: [{ type: 'bogus-type', value: 'out.md' }] as never,
          },
        ]),
      ).rejects.toThrow(/file, text/);
    });

    it('rejects a non-plan-mode caller', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const task = await seedTask(company.id);
      const a = await seedAssignment({
        companyId: company.id,
        roleId: role.id,
        taskId: task.id,
        mode: 'implement',
      });
      const agent = await seedAgent(company.id, role.id, a.id);
      await expect(
        service.planTask(task.id, agent.id, [
          { prompt: 'a', role: 'analyst', expected: [] },
        ]),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an empty plan', async () => {
      const { task, agent } = await setupPlanner();
      await expect(
        service.planTask(task.id, agent.id, []),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an unresolvable role', async () => {
      const { task, agent } = await setupPlanner();
      db.findRoleByIdOrSlug.mockResolvedValue(null);
      await expect(
        service.planTask(task.id, agent.id, [
          { prompt: 'a', role: 'ghost', expected: [] },
        ]),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a disallowed expected artifact type', async () => {
      const { task, agent } = await setupPlanner();
      await expect(
        service.planTask(task.id, agent.id, [
          {
            prompt: 'a',
            role: 'analyst',
            expected: [{ type: 'task-materials-path', value: 'x' }] as never,
          },
        ]),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('reports every invalid role and artifact type at once, naming the valid roles', async () => {
      const { task, agent } = await setupPlanner();
      db.findRoleByIdOrSlug.mockResolvedValue(null); // every role invalid
      db.listRoles.mockResolvedValue([{ slug: 'analyst' }, { slug: 'writer' }]);
      let message = '';
      try {
        await service.planTask(task.id, agent.id, [
          {
            prompt: 'a',
            role: 'ghost',
            expected: [{ type: 'task-materials-path', value: 'x' }] as never,
          },
        ]);
      } catch (e) {
        message = (e as Error).message;
      }
      // Both the bad role and the bad artifact type are reported together.
      expect(message).toContain('assignment 0 role');
      expect(message).toContain('Valid values are: analyst, writer.');
      expect(message).toContain('assignment 0 expected type');
      expect(message).toContain(
        'If you still intend to create the plan, try again with corrected values for',
      );
    });

    it('rejects an assignment-completed-path material naming a file no earlier step promises', async () => {
      const { task, agent } = await setupPlanner();
      await expect(
        service.planTask(task.id, agent.id, [
          { prompt: 'a', role: 'analyst', expected: [] },
          {
            prompt: 'b',
            role: 'analyst',
            materials: [
              { type: 'assignment-completed-path', value: 'draft.md' },
            ],
            expected: [],
          },
        ]),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts an assignment-completed-path material matching an earlier step’s expected output', async () => {
      const { task, agent } = await setupPlanner();
      const result = await service.planTask(task.id, agent.id, [
        {
          prompt: 'a',
          role: 'analyst',
          expected: [{ type: 'assignment-working-path', value: 'draft.md' }],
        },
        {
          prompt: 'b',
          role: 'analyst',
          materials: [{ type: 'assignment-completed-path', value: 'draft.md' }],
          expected: [],
        },
      ]);
      expect(result.created).toBe(2);
    });

    it('409s a double plan (task no longer planning)', async () => {
      const { task, agent } = await setupPlanner();
      await service.planTask(task.id, agent.id, [
        { prompt: 'a', role: 'analyst', expected: [] },
      ]);
      await expect(
        service.planTask(task.id, agent.id, [
          { prompt: 'a', role: 'analyst', expected: [] },
        ]),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  // --- completeAssignment -------------------------------------------------

  describe('completeAssignment', () => {
    async function setupImplementer(partial: Partial<TcpAssignment> = {}) {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const assignment = await seedAssignment({
        companyId: company.id,
        roleId: role.id,
        status: 'in-progress',
        mode: 'implement',
        ...partial,
      });
      const agent = await seedAgent(company.id, role.id, assignment.id);
      await assignmentRepo.update(assignment.id, { agentId: agent.id });
      db.getCompany.mockResolvedValue({ id: company.id, slug: company.slug });
      return { company, role, assignment, agent };
    }

    it('completes an orphan assignment and completes the agent', async () => {
      const { assignment, agent } = await setupImplementer({ taskId: null });
      await service.completeAssignment(assignment.id, agent.id, 'all done', []);

      const fresh = await assignmentRepo.findOneByOrFail({ id: assignment.id });
      expect(fresh.status).toBe('succeeded');
      expect(fresh.summary).toBe('all done');
      expect(pauseResume.completeAgent).toHaveBeenCalledWith(
        agent.id,
        'all done',
      );
    });

    it('hands a task assignment to QA and pauses the agent', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const task = await seedTask(company.id, 'in-progress');
      const { assignment, agent } = await setupImplementer({
        companyId: company.id,
        roleId: role.id,
        taskId: task.id,
        orderIndex: 0,
      });
      db.getCompany.mockResolvedValue({ id: company.id, slug: company.slug });

      await service.completeAssignment(assignment.id, agent.id, 'done', []);

      const fresh = await assignmentRepo.findOneByOrFail({ id: assignment.id });
      expect(fresh.status).toBe('in-qa');
      expect(fresh.prepared).toEqual([]);
      const freshAgent = await agentRepo.findOneByOrFail({ id: agent.id });
      expect(freshAgent.status).toBe(AgentStatus.Paused);
      expect(freshAgent.pausedAt).toBeTruthy();
      expect(dispatcher.assignmentReadyForQa).toHaveBeenCalledTimes(1);
      expect(pauseResume.completeAgent).not.toHaveBeenCalled();
    });

    it('422s when an expected file is not among prepared', async () => {
      const { assignment, agent } = await setupImplementer({
        taskId: null,
        expected: [{ type: 'assignment-working-path', value: 'report.md' }],
      });
      await expect(
        service.completeAssignment(assignment.id, agent.id, 'done', []),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('422s when a prepared file is missing from storage', async () => {
      const { company, assignment, agent } = await setupImplementer({
        taskId: null,
      });
      storage.checkMissingFiles.mockResolvedValue([
        `${company.slug}/assignments/${assignment.id}/working/out.md`,
      ]);
      await expect(
        service.completeAssignment(assignment.id, agent.id, 'done', [
          { type: 'assignment-working-path', value: 'out.md' },
        ]),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('passes an inline-text expectation on shape alone — content is not gate-matched (QA judges it)', async () => {
      const { assignment, agent } = await setupImplementer({
        taskId: null,
        expected: [{ type: 'inline-text', value: 'a list of chicken foods' }],
      });
      // The prepared text does not "match" the expected description, but the
      // gate only checks shape (a non-empty inline-text artifact is present).
      await service.completeAssignment(assignment.id, agent.id, 'done', [
        { type: 'inline-text', value: 'grubs, seed, and kitchen scraps' },
      ]);
      const fresh = await assignmentRepo.findOneByOrFail({ id: assignment.id });
      expect(fresh.status).toBe('succeeded');
    });

    it('422s an inline-text expectation when no inline-text artifact is provided (a file does not satisfy it)', async () => {
      const { assignment, agent } = await setupImplementer({
        taskId: null,
        expected: [{ type: 'inline-text', value: 'a summary' }],
      });
      await expect(
        service.completeAssignment(assignment.id, agent.id, 'done', [
          { type: 'assignment-working-path', value: 'report.md' },
        ]),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('completes a consultee (orphan) assignment and completes the agent', async () => {
      const { assignment, agent } = await setupImplementer({
        taskId: null,
        mode: 'consultee',
      });
      await service.completeAssignment(
        assignment.id,
        agent.id,
        'worms are great',
        [],
      );
      const fresh = await assignmentRepo.findOneByOrFail({ id: assignment.id });
      expect(fresh.status).toBe('succeeded');
      expect(pauseResume.completeAgent).toHaveBeenCalledWith(
        agent.id,
        'worms are great',
      );
    });

    describe('finalise', () => {
      async function setupFinalise() {
        const company = await seedCompany();
        const role = await seedRole(company.id);
        const task = await taskRepo.save(
          taskRepo.create({
            companyId: company.id,
            request: 'do it',
            shortcode: '000',
            status: 'finalising',
            expected: [{ type: 'task-completed-path', value: 'report.txt' }],
          }),
        );
        const { assignment, agent } = await setupImplementer({
          companyId: company.id,
          roleId: role.id,
          taskId: task.id,
          mode: 'finalise',
        });
        db.getCompany.mockResolvedValue({ id: company.id, slug: company.slug });
        return { task, assignment, agent };
      }

      it('succeeds and calls assignmentFinalised when the expected file is present', async () => {
        const { assignment, agent } = await setupFinalise();
        storage.listFiles.mockResolvedValue([
          {
            key: 'k/report.txt',
            name: 'report.txt',
            size: 1,
            lastModified: 'x',
          },
        ]);
        await service.completeAssignment(assignment.id, agent.id, 'ok', []);
        const fresh = await assignmentRepo.findOneByOrFail({
          id: assignment.id,
        });
        expect(fresh.status).toBe('succeeded');
        expect(dispatcher.assignmentFinalised).toHaveBeenCalledTimes(1);
      });

      it('422s when the expected file is not in the completed dir', async () => {
        const { assignment, agent } = await setupFinalise();
        storage.listFiles.mockResolvedValue([]); // completed dir empty
        await expect(
          service.completeAssignment(assignment.id, agent.id, 'ok', []),
        ).rejects.toBeInstanceOf(UnprocessableEntityException);
        expect(dispatcher.assignmentFinalised).not.toHaveBeenCalled();
      });
    });

    it('rejects a caller that is not the assignment agent', async () => {
      const { assignment } = await setupImplementer({ taskId: null });
      await expect(
        service.completeAssignment(assignment.id, randomUUID(), 'done', []),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('409s a double completion', async () => {
      const { assignment, agent } = await setupImplementer({ taskId: null });
      await service.completeAssignment(assignment.id, agent.id, 'done', []);
      await expect(
        service.completeAssignment(assignment.id, agent.id, 'done', []),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  // --- assureAssignment ---------------------------------------------------

  describe('assureAssignment', () => {
    async function setupQa() {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const target = await seedAssignment({
        companyId: company.id,
        roleId: role.id,
        mode: 'implement',
        status: 'in-qa',
      });
      const qaAssignment = await seedAssignment({
        companyId: company.id,
        roleId: role.id,
        mode: 'qa',
        status: 'in-progress',
        targetAssignmentId: target.id,
      });
      const qaAgent = await seedAgent(company.id, role.id, qaAssignment.id);
      return { target, qaAssignment, qaAgent };
    }

    it('records an accept verdict and completes the QA agent', async () => {
      const { target, qaAssignment, qaAgent } = await setupQa();
      await service.assureAssignment(
        target.id,
        qaAgent.id,
        'accept',
        undefined,
      );

      const freshTarget = await assignmentRepo.findOneByOrFail({
        id: target.id,
      });
      expect(freshTarget.qaStatus).toBe('accepted');
      const freshQa = await assignmentRepo.findOneByOrFail({
        id: qaAssignment.id,
      });
      expect(freshQa.status).toBe('succeeded');
      expect(dispatcher.assignmentAssured).toHaveBeenCalledTimes(1);
      expect(pauseResume.completeAgent).toHaveBeenCalledTimes(1);
    });

    it('records a reject verdict with feedback', async () => {
      const { target, qaAgent } = await setupQa();
      await service.assureAssignment(target.id, qaAgent.id, 'reject', 'fix it');
      const freshTarget = await assignmentRepo.findOneByOrFail({
        id: target.id,
      });
      expect(freshTarget.qaStatus).toBe('rejected');
      expect(freshTarget.qaFeedback).toBe('fix it');
    });

    it('409s a double assurance', async () => {
      const { target, qaAgent } = await setupQa();
      await service.assureAssignment(
        target.id,
        qaAgent.id,
        'accept',
        undefined,
      );
      await expect(
        service.assureAssignment(target.id, qaAgent.id, 'accept', undefined),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects a caller whose QA assignment targets a different assignment', async () => {
      const { qaAgent } = await setupQa();
      await expect(
        service.assureAssignment(randomUUID(), qaAgent.id, 'accept', undefined),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('409s when the target is not in QA', async () => {
      const { target, qaAgent } = await setupQa();
      await assignmentRepo.update(target.id, { status: 'in-progress' });
      await expect(
        service.assureAssignment(target.id, qaAgent.id, 'accept', undefined),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
