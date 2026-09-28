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
} from '@tcp/shared';
import { randomUUID, type UUID } from 'crypto';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { TaskDeliverablesService } from './task-deliverables.service';
import { TaskFailureService } from './task-failure.service';
import { TaskStateService } from './task-state.service';

const ENTITIES = [TcpCompany, TcpRole, TcpAgent, TcpTask, TcpAssignment];

/**
 * Covers {@link TaskFailureService.cancelTask}'s agent cascade (002.02 stage
 * 2): cancelling an agent used to write silently, so a client watching it
 * never learned a task cancellation had reached its agents. Against a real
 * in-memory database, like the completion-service specs, because the thing
 * worth testing is write-then-publish ordering — a mocked repository proves
 * nothing about that.
 */
describe('TaskFailureService.cancelTask — agent cancellation', () => {
  let moduleRef: TestingModule;
  let service: TaskFailureService;
  let agentRepo: Repository<TcpAgent>;
  let assignmentRepo: Repository<TcpAssignment>;
  let taskRepo: Repository<TcpTask>;
  let companyRepo: Repository<TcpCompany>;
  let roleRepo: Repository<TcpRole>;
  let audit: { record: jest.Mock };

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
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    const state = new TaskStateService(
      taskRepo,
      assignmentRepo,
      audit as unknown as AuditService,
    );
    service = new TaskFailureService(
      taskRepo,
      assignmentRepo,
      agentRepo,
      roleRepo,
      // cancelTask never reaches the deliverables collaborator — only
      // failFinalise does.
      {} as unknown as TaskDeliverablesService,
      state,
      audit as unknown as AuditService,
    );
  });

  function randomSlug(): string {
    return randomUUID().slice(0, 8);
  }

  /** A company, role, in-progress task, its live assignment and working agent. */
  async function seedLiveTask(): Promise<{
    task: TcpTask;
    agentId: UUID;
  }> {
    const company = await companyRepo.save(
      companyRepo.create({
        slug: `cancel-${randomSlug()}`,
        name: 'Cancel Co',
        description: 'x',
      }),
    );
    const role = await roleRepo.save(
      roleRepo.create({
        companyId: company.id,
        slug: `role-${randomSlug()}`,
        name: 'analyst',
        description: 'x',
      }),
    );
    const task = await taskRepo.save(
      taskRepo.create({
        companyId: company.id,
        request: 'do it',
        shortcode: '000',
        status: 'in-progress',
      }),
    );
    const assignment = await assignmentRepo.save(
      assignmentRepo.create({
        companyId: company.id,
        roleId: role.id,
        taskId: task.id,
        mode: 'implement',
        status: 'in-progress',
        orderIndex: 0,
        prompt: 'work',
        materials: [],
        expected: [],
        prepared: [],
        approved: [],
      }),
    );
    const agent = await agentRepo.save(
      agentRepo.create({
        companyId: company.id,
        roleId: role.id,
        assignmentId: assignment.id,
        initialPrompt: '',
        status: AgentStatus.Running,
      }),
    );
    assignment.agentId = agent.id;
    await assignmentRepo.save(assignment);
    return { task, agentId: agent.id };
  }

  it('publishes the agent cancelled state_change, with a summary, only after the agent row is written', async () => {
    const { task, agentId } = await seedLiveTask();
    const updateSpy = jest.spyOn(agentRepo, 'createQueryBuilder');

    await service.cancelTask(task);

    const cancelled = await agentRepo.findOneByOrFail({ id: agentId });
    expect(cancelled.status).toBe(AgentStatus.Cancelled);

    const recordCalls = audit.record.mock.calls as [
      string,
      string,
      string,
      AuditEventType,
      { entity?: string; newStatus?: string },
    ][];
    const publishCallIndex = recordCalls.findIndex(
      ([, , agentIdArg, eventType, payload]) =>
        agentIdArg === agentId &&
        eventType === AuditEventType.StateChange &&
        payload.entity === 'agent' &&
        payload.newStatus === AgentStatus.Cancelled,
    );
    expect(publishCallIndex).toBeGreaterThanOrEqual(0);
    expect(recordCalls[publishCallIndex][4]).toMatchObject({
      reason: 'task cancelled',
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      summary: expect.objectContaining({
        id: agentId,
        status: AgentStatus.Cancelled,
      }),
    });

    // The UPDATE query builder (the actual write) was invoked before the
    // publish — persist-then-publish, per the class's docstring.
    expect(updateSpy.mock.invocationCallOrder[0]).toBeLessThan(
      audit.record.mock.invocationCallOrder[publishCallIndex],
    );

    updateSpy.mockRestore();
  });

  it('publishes nothing for an agent already in a terminal state', async () => {
    const { task, agentId } = await seedLiveTask();
    await agentRepo.update(agentId, { status: AgentStatus.Completed });
    audit.record.mockClear();

    await service.cancelTask(task);

    const cancelled = await agentRepo.findOneByOrFail({ id: agentId });
    // Unchanged — cancelAgent's WHERE excludes terminal statuses.
    expect(cancelled.status).toBe(AgentStatus.Completed);

    const agentCalls = (
      audit.record.mock.calls as [
        string,
        string,
        string,
        AuditEventType,
        { entity?: string },
      ][]
    ).filter(([, , , , payload]) => payload.entity === 'agent');
    expect(agentCalls).toHaveLength(0);
  });
});
