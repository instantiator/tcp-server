import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import {
  AgentStatus,
  TcpAgent,
  TcpAssignment,
  TcpCompany,
  TcpRole,
  TcpTask,
} from '@tcp/shared';
import { randomUUID, type UUID } from 'crypto';
import { Repository } from 'typeorm';
import { AssignmentCompletionService } from './assignment-completion.service';
import { OutputGateService } from './output-gate.service';
import { PauseAndResumeService } from './pause-and-resume.service';
import { TaskDispatcher } from './task-dispatcher.service';

const ENTITIES = [TcpCompany, TcpRole, TcpAgent, TcpTask, TcpAssignment];

/**
 * Covers {@link AssignmentCompletionService.completeChat} — the user-driven
 * ending, which no other spec reaches: `AssignmentService` only ever calls the
 * agent-authenticated {@link AssignmentCompletionService.complete}.
 *
 * Against a real in-memory database rather than a mocked repository, because
 * the thing worth testing here is the atomic claim: a second completion has to
 * lose, and a mock that returns whatever it is told proves nothing about that.
 */
describe('AssignmentCompletionService.completeChat', () => {
  let moduleRef: TestingModule;
  let service: AssignmentCompletionService;
  let agentRepo: Repository<TcpAgent>;
  let assignmentRepo: Repository<TcpAssignment>;
  let companyRepo: Repository<TcpCompany>;
  let roleRepo: Repository<TcpRole>;
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
    companyRepo = moduleRef.get(getRepositoryToken(TcpCompany));
    roleRepo = moduleRef.get(getRepositoryToken(TcpRole));
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(() => {
    pauseResume = { completeAgent: jest.fn().mockResolvedValue(undefined) };
    service = new AssignmentCompletionService(
      agentRepo,
      assignmentRepo,
      moduleRef.get(getRepositoryToken(TcpTask)),
      // Nothing this path takes reaches the dispatcher or the gate: a chat has
      // no task to advance and no expected outputs to check.
      {} as unknown as TaskDispatcher,
      pauseResume as unknown as PauseAndResumeService,
      {} as unknown as OutputGateService,
    );
  });

  /** A chat assignment and the agent holding it, both persisted. */
  async function seedChat(
    overrides: {
      mode?: TcpAssignment['mode'];
      status?: TcpAssignment['status'];
      agentStatus?: AgentStatus;
      output?: string;
    } = {},
  ): Promise<{ assignment: TcpAssignment; agentId: UUID }> {
    const company = await companyRepo.save(
      companyRepo.create({
        slug: `acme-${randomSlug()}`,
        name: 'ACME',
        description: 'A test company',
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
    const { id: companyId } = company;
    const { id: roleId } = role;
    const assignment = await assignmentRepo.save(
      assignmentRepo.create({
        companyId,
        roleId,
        mode: overrides.mode ?? 'chat',
        prompt: '',
        status: overrides.status ?? 'in-progress',
        materials: [],
        expected: [],
        prepared: [],
        approved: [],
      }),
    );
    const agent = await agentRepo.save(
      agentRepo.create({
        companyId,
        roleId,
        assignmentId: assignment.id,
        initialPrompt: '',
        status: overrides.agentStatus ?? AgentStatus.Idle,
        output: overrides.output ?? null,
      }),
    );
    assignment.agentId = agent.id;
    await assignmentRepo.save(assignment);
    return { assignment, agentId: agent.id };
  }

  function randomSlug(): string {
    return randomUUID().slice(0, 8);
  }

  it('succeeds the assignment and completes its agent', async () => {
    const { assignment, agentId } = await seedChat({ output: 'last reply' });

    await service.completeChat(assignment);

    const stored = await assignmentRepo.findOneBy({ id: assignment.id });
    expect(stored?.status).toBe('succeeded');
    // The agent's last reply is handed on rather than blanked — a client
    // reconnecting to a finished chat replays it.
    expect(pauseResume.completeAgent).toHaveBeenCalledWith(
      agentId,
      'last reply',
    );
  });

  it('rejects an assignment that is not a chat', async () => {
    const { assignment } = await seedChat({ mode: 'implement' });

    await expect(service.completeChat(assignment)).rejects.toThrow(
      BadRequestException,
    );
    expect(pauseResume.completeAgent).not.toHaveBeenCalled();
  });

  it('rejects a chat whose agent is mid-turn', async () => {
    const { assignment } = await seedChat({
      agentStatus: AgentStatus.Running,
    });

    await expect(service.completeChat(assignment)).rejects.toThrow(
      ConflictException,
    );
    const stored = await assignmentRepo.findOneBy({ id: assignment.id });
    expect(stored?.status).toBe('in-progress');
  });

  it('rejects a second completion — only one caller can claim the row', async () => {
    const { assignment } = await seedChat();

    await service.completeChat(assignment);
    // The same in-memory entity a second time, exactly as a second request
    // holding its own freshly loaded copy would behave.
    await expect(service.completeChat(assignment)).rejects.toThrow(
      ConflictException,
    );
    expect(pauseResume.completeAgent).toHaveBeenCalledTimes(1);
  });
});
