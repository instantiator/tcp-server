import {
  AgentStatus,
  Conversation,
  emptyCompanyStats,
  TcpAgent,
  TcpAssignment,
  TcpCompany,
  TcpRole,
  TcpTask,
} from '@tcp/shared';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import type { UUID } from 'crypto';
import { Repository } from 'typeorm';
import { CompanyStatsService } from './company-stats.service';

const ENTITIES = [
  TcpCompany,
  TcpRole,
  TcpAgent,
  TcpAssignment,
  TcpTask,
  Conversation,
];

describe('CompanyStatsService', () => {
  let service: CompanyStatsService;
  let agentRepo: Repository<TcpAgent>;
  let taskRepo: Repository<TcpTask>;
  let convRepo: Repository<Conversation>;

  /** Acme has rows of every kind; Beta has none. */
  let acme: UUID;
  let beta: UUID;

  let testingModule: TestingModule;

  beforeAll(async () => {
    testingModule = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          entities: ENTITIES,
          synchronize: true,
        }),
        TypeOrmModule.forFeature(ENTITIES),
      ],
      providers: [CompanyStatsService],
    }).compile();

    service = testingModule.get(CompanyStatsService);
    agentRepo = testingModule.get(getRepositoryToken(TcpAgent));
    taskRepo = testingModule.get(getRepositoryToken(TcpTask));
    convRepo = testingModule.get(getRepositoryToken(Conversation));
    const companyRepo: Repository<TcpCompany> = testingModule.get(
      getRepositoryToken(TcpCompany),
    );
    const roleRepo: Repository<TcpRole> = testingModule.get(
      getRepositoryToken(TcpRole),
    );
    const assignmentRepo: Repository<TcpAssignment> = testingModule.get(
      getRepositoryToken(TcpAssignment),
    );

    /** Creates a company with the one role and assignment its agents need. */
    const company = async (
      slug: string,
    ): Promise<{ id: UUID; roleId: UUID; assignmentId: UUID }> => {
      const { id } = await companyRepo.save({
        slug,
        name: slug,
        description: slug,
        mcpServerList: [],
      });
      const role = await roleRepo.save(
        roleRepo.create({
          companyId: id,
          slug: `${slug}-analyst`,
          name: 'Analyst',
          description: 'Analyses things',
          rolePrompt: 'Analyse.',
          knowledgeDomains: [],
        }),
      );
      const assignment = await assignmentRepo.save(
        assignmentRepo.create({
          companyId: id,
          roleId: role.id,
          taskId: null,
          agentId: null,
          mode: 'chat',
          status: 'in-progress',
          prompt: 'Do the thing',
          materials: [],
          expected: [],
        }),
      );
      return { id, roleId: role.id, assignmentId: assignment.id };
    };

    const acmeFixture = await company('acme');
    const betaFixture = await company('beta');
    acme = acmeFixture.id;
    beta = betaFixture.id;

    const makeAgent = (
      fixture: { id: UUID; roleId: UUID; assignmentId: UUID },
      status: AgentStatus,
    ) =>
      agentRepo.save(
        agentRepo.create({
          companyId: fixture.id,
          roleId: fixture.roleId,
          assignmentId: fixture.assignmentId,
          initialPrompt: 'Do the thing',
          requiredToolCalls: [],
          status,
        }),
      );

    // Two active agents and two terminal ones that must not count.
    for (const status of [
      AgentStatus.Idle,
      AgentStatus.Running,
      AgentStatus.Completed,
      AgentStatus.Failed,
    ]) {
      await makeAgent(acmeFixture, status);
    }
    // One active agent in the other company — must not leak into acme's count.
    await makeAgent(betaFixture, AgentStatus.Running);

    const task = (status: TcpTask['status'], shortcode: string) =>
      taskRepo.save(
        taskRepo.create({
          companyId: acme,
          request: 'Do the thing',
          shortcode,
          status,
          materials: [],
          expected: [],
        }),
      );
    await task('ready', '000');
    await task('ready', '001');
    await task('succeeded', '002');

    const enquiry = (
      slug: string,
      status: Conversation['status'],
      owner: UUID,
    ) =>
      convRepo.save(
        convRepo.create({
          slug,
          companyId: owner,
          roleName: 'analyst',
          roleId: null,
          agentId: null,
          question: 'Which vendor?',
          context: null,
          status,
          routedToIdentifiers: [],
        }),
      );
    await enquiry('analyst-1', 'awaiting_user', acme);
    await enquiry('analyst-2', 'awaiting_user', acme);
    await enquiry('analyst-3', 'closed', acme);
    await enquiry('analyst-4', 'awaiting_user', beta);
  });

  // Closes the better-sqlite3 DataSource this module opened. Without it the
  // connection outlives the suite, and `@nestjs/typeorm`'s connection retry —
  // an rxjs timer — can fire after Jest has torn the environment down, at
  // which point re-loading the driver throws "require after teardown".
  afterAll(async () => {
    await testingModule.close();
  });

  afterEach(() => jest.restoreAllMocks());

  it('returns an empty map without querying for an empty input', async () => {
    const agents = jest.spyOn(agentRepo, 'createQueryBuilder');
    await expect(service.listStats([])).resolves.toEqual(new Map());
    expect(agents).not.toHaveBeenCalled();
  });

  it('counts active agents, tasks by status and open enquiries per company', async () => {
    const stats = await service.listStats([acme, beta]);

    expect(stats.get(acme)).toEqual({
      ...emptyCompanyStats(),
      activeAgents: 2,
      tasksByStatus: {
        ...emptyCompanyStats().tasksByStatus,
        ready: 2,
        succeeded: 1,
      },
      openEnquiries: 2,
    });
  });

  it('zero-fills every task status, not just the ones present', async () => {
    const stats = await service.listStats([acme]);
    expect(Object.keys(stats.get(acme)!.tasksByStatus).sort()).toEqual(
      Object.keys(emptyCompanyStats().tasksByStatus).sort(),
    );
    expect(stats.get(acme)!.tasksByStatus.cancelled).toBe(0);
  });

  it('gives a company with no rows a zero-filled entry', async () => {
    const stats = await service.listStats([beta]);
    expect(stats.get(beta)).toEqual({
      ...emptyCompanyStats(),
      activeAgents: 1,
      openEnquiries: 1,
    });
  });

  it('gives an unknown company id an entry rather than omitting it', async () => {
    const unknown = randomUUID();
    const stats = await service.listStats([unknown]);
    expect(stats.get(unknown)).toEqual(emptyCompanyStats());
  });

  // "Not per company" is the whole point of the fixed stat set: the overview
  // lists every company a user belongs to, so a per-company query would scale
  // with membership count.
  it.each([2, 5])(
    'issues exactly one query per stat for %i companies',
    async (count) => {
      const agents = jest.spyOn(agentRepo, 'createQueryBuilder');
      const tasks = jest.spyOn(taskRepo, 'createQueryBuilder');
      const convs = jest.spyOn(convRepo, 'createQueryBuilder');

      const ids = [
        acme,
        beta,
        ...Array.from({ length: count - 2 }, randomUUID),
      ];
      await service.listStats(ids.slice(0, count));

      expect(agents).toHaveBeenCalledTimes(1);
      expect(tasks).toHaveBeenCalledTimes(1);
      expect(convs).toHaveBeenCalledTimes(1);
    },
  );
});
