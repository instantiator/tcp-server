import {
  AgentStatus,
  TcpAgent,
  TcpAssignment,
  TcpCompany,
  TcpRole,
  TcpTask,
  type PauseReason,
} from '@tcp/shared';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { UUID } from 'crypto';
import { Repository } from 'typeorm';
import { AgentOrchestrationService } from './agent-orchestration.service';
import { RateLimitResumeService } from './rate-limit-resume.service';
import { SystemShutdownService } from './system-shutdown.service';

const ENTITIES = [TcpCompany, TcpRole, TcpAgent, TcpTask, TcpAssignment];

describe('RateLimitResumeService', () => {
  let module: TestingModule;
  let service: RateLimitResumeService;
  let agents: Repository<TcpAgent>;
  let resumeAgent: jest.Mock;
  let shuttingDown: boolean;
  let seed: (
    pauseReason: PauseReason,
    resumeAfter: Date | null,
  ) => Promise<UUID>;

  beforeAll(async () => {
    resumeAgent = jest.fn().mockResolvedValue(undefined);
    module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          entities: ENTITIES,
          synchronize: true,
        }),
        TypeOrmModule.forFeature(ENTITIES),
      ],
      providers: [
        RateLimitResumeService,
        { provide: AgentOrchestrationService, useValue: { resumeAgent } },
        {
          provide: SystemShutdownService,
          useValue: {
            get isShuttingDown() {
              return shuttingDown;
            },
          },
        },
      ],
    }).compile();
    service = module.get(RateLimitResumeService);
    agents = module.get(getRepositoryToken(TcpAgent));

    const company = await module
      .get<Repository<TcpCompany>>(getRepositoryToken(TcpCompany))
      .save({ slug: 'acme', name: 'ACME', description: 'A company.' });
    const role = await module
      .get<Repository<TcpRole>>(getRepositoryToken(TcpRole))
      .save({
        companyId: company.id,
        slug: 'analyst',
        name: 'analyst',
        description: 'Analyses data.',
        systemPromptTemplate: 'You are {{name}}.',
      });
    const assignments = module.get<Repository<TcpAssignment>>(
      getRepositoryToken(TcpAssignment),
    );
    seed = async (pauseReason, resumeAfter) => {
      const assignment = await assignments.save({
        taskId: null,
        companyId: company.id,
        roleId: role.id,
        mode: 'implement',
        prompt: 'Do it.',
        status: 'in-progress',
      });
      const agent = await agents.save(
        agents.create({
          companyId: company.id,
          roleId: role.id,
          assignmentId: assignment.id,
          initialPrompt: 'Go.',
          status: AgentStatus.Paused,
          pausedAt: new Date(),
          pauseReason,
          resumeAfter: resumeAfter ?? undefined,
        }),
      );
      return agent.id;
    };
  });

  afterAll(async () => {
    service.onModuleDestroy();
    await module.close();
  });

  beforeEach(async () => {
    shuttingDown = false;
    resumeAgent.mockClear();
    await agents.clear();
  });

  it('resumes only rate-limited agents whose time has come', async () => {
    const due = await seed('rate_limited', new Date(Date.now() - 1_000));
    await seed('rate_limited', new Date(Date.now() + 60_000)); // not yet
    await seed('rate_limited', null); // auto-resume was off
    await seed('spend_cap', new Date(Date.now() - 1_000)); // not ours

    await service.sweep();

    expect(resumeAgent.mock.calls).toEqual([
      [due, undefined, { lifts: ['rate_limited'] }],
    ]);
  });

  it('keeps going when one resume fails', async () => {
    const first = await seed('rate_limited', new Date(Date.now() - 2_000));
    const second = await seed('rate_limited', new Date(Date.now() - 1_000));
    resumeAgent.mockRejectedValueOnce(new Error('cannot be resumed'));

    await service.sweep();

    expect(resumeAgent.mock.calls.map(([id]) => id as string).sort()).toEqual(
      [first, second].sort(),
    );
  });

  it('resumes nothing while the system is shutting down', async () => {
    await seed('rate_limited', new Date(Date.now() - 1_000));
    shuttingDown = true;

    await service.sweep();

    expect(resumeAgent).not.toHaveBeenCalled();
  });
});
