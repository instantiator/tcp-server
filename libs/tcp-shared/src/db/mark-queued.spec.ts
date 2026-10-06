import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { UUID } from 'crypto';
import { Repository } from 'typeorm';
import {
  AgentStatus,
  TcpAgent,
  TcpAssignment,
  TcpCompany,
  TcpRole,
  TcpTask,
} from '../models';
import { markQueued } from './mark-queued';

const ENTITIES = [TcpCompany, TcpRole, TcpAgent, TcpTask, TcpAssignment];

describe('markQueued', () => {
  let module: TestingModule;
  let agents: Repository<TcpAgent>;
  let agentId: UUID;

  beforeAll(async () => {
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
    }).compile();
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
    const assignment = await module
      .get<Repository<TcpAssignment>>(getRepositoryToken(TcpAssignment))
      .save({
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
      }),
    );
    agentId = agent.id;
  });

  afterAll(async () => {
    await module.close();
  });

  /** Puts the agent in `status`, with or without an unclaimed pause. */
  async function setState(status: AgentStatus, pausedAt: Date | null) {
    await agents.update(agentId, { status, pausedAt: pausedAt ?? undefined });
    if (pausedAt === null) {
      await agents
        .createQueryBuilder()
        .update(TcpAgent)
        .set({ pausedAt: () => 'NULL' })
        .where('id = :agentId', { agentId })
        .execute();
    }
  }

  async function statusNow(): Promise<AgentStatus> {
    return (await agents.findOneByOrFail({ id: agentId })).status;
  }

  it.each([
    ['an idle agent', AgentStatus.Idle],
    ['a paused agent whose pause the resume has claimed', AgentStatus.Paused],
  ])('queues %s', async (_label, status) => {
    await setState(status, null);
    await expect(markQueued(agents, agentId)).resolves.toBe(true);
    expect(await statusNow()).toBe(AgentStatus.Queued);
  });

  it.each([
    ['already queued', AgentStatus.Queued, null],
    ['already running (the worker got there first)', AgentStatus.Running, null],
    ['paused again since the resume', AgentStatus.Paused, new Date()],
    ['cancelled', AgentStatus.Cancelled, null],
    ['completed', AgentStatus.Completed, null],
  ])('leaves an agent that is %s alone', async (_label, status, pausedAt) => {
    await setState(status, pausedAt);
    await expect(markQueued(agents, agentId)).resolves.toBe(false);
    expect(await statusNow()).toBe(status);
  });
});
