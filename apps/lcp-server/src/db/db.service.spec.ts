import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { QueryFailedError, Repository } from 'typeorm';
import {
  AgentStatus,
  AuditEvent,
  AuditEventType,
  LcpAgent,
  LcpCompany,
  LcpRole,
} from '@lcp/shared';
import { DbService } from './db.service';

const ALL_ENTITIES = [LcpCompany, LcpRole, LcpAgent, AuditEvent];

describe('DbService', () => {
  let dbService: DbService;
  let companyRepo: Repository<LcpCompany>;
  let roleRepo: Repository<LcpRole>;
  let agentRepo: Repository<LcpAgent>;
  let auditRepo: Repository<AuditEvent>;

  beforeAll(async () => {
    const testingModule: TestingModule = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          entities: ALL_ENTITIES,
          synchronize: true,
        }),
        TypeOrmModule.forFeature(ALL_ENTITIES),
      ],
      providers: [DbService],
    }).compile();

    dbService = testingModule.get(DbService);
    companyRepo = testingModule.get(getRepositoryToken(LcpCompany));
    roleRepo = testingModule.get(getRepositoryToken(LcpRole));
    agentRepo = testingModule.get(getRepositoryToken(LcpAgent));
    auditRepo = testingModule.get(getRepositoryToken(AuditEvent));
  });

  afterEach(async () => {
    await auditRepo.clear();
    await agentRepo.clear();
    await roleRepo.clear();
    await companyRepo.clear();
  });

  // Helpers

  async function seedCompany() {
    return companyRepo.save(companyRepo.create({ slug: 'acme', name: 'ACME' }));
  }

  async function seedRole(companyId: string) {
    return roleRepo.save(
      roleRepo.create({
        companyId,
        name: 'analyst',
        description: 'Analyses data.',
        llmConfig: { provider: 'lm-studio', model: 'qwen3-5b' },
        systemPromptTemplate: 'You are {{name}}.',
      }),
    );
  }

  // createCompany

  describe('createCompany', () => {
    it('persists a new record with the given slug and template fields', async () => {
      await dbService.createCompany({ name: 'Acme Corp' }, 'acme');
      const record = await companyRepo.findOneBy({ slug: 'acme' });
      expect(record).not.toBeNull();
      expect(record!.name).toBe('Acme Corp');
      expect(record!.slug).toBe('acme');
    });

    it('assigns a UUID to the new record', async () => {
      const result = await dbService.createCompany(
        { name: 'Acme Corp' },
        'acme',
      );
      expect(result.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it('replaces an existing record with the same slug', async () => {
      await dbService.createCompany({ name: 'First' }, 'acme');
      await dbService.createCompany({ name: 'Second' }, 'acme');

      expect(await companyRepo.count({ where: { slug: 'acme' } })).toBe(1);
      expect((await companyRepo.findOneBy({ slug: 'acme' }))!.name).toBe(
        'Second',
      );
    });
  });

  // setCompany

  describe('setCompany', () => {
    it('creates a new record when replace=true and no prior record exists', async () => {
      await dbService.setCompany({ slug: 'acme', name: 'Acme Corp' }, true);
      expect(await companyRepo.count()).toBe(1);
    });

    it('creates a new record when replace=false', async () => {
      await dbService.setCompany({ slug: 'acme', name: 'Acme Corp' }, false);
      const record = await companyRepo.findOneBy({ slug: 'acme' });
      expect(record).not.toBeNull();
      expect(record!.slug).toBe('acme');
    });

    it('updates an existing record when replace=false and the id matches', async () => {
      const id = randomUUID();
      await dbService.setCompany(
        { id, slug: 'acme', name: 'Original Name' },
        false,
      );
      await dbService.setCompany(
        { id, slug: 'acme', name: 'Updated Name' },
        false,
      );

      expect(await companyRepo.count()).toBe(1);
      const record = await companyRepo.findOneBy({ id });
      expect(record!.name).toBe('Updated Name');
    });

    it('does not overwrite unmodified fields when updating', async () => {
      const id = randomUUID();
      await dbService.setCompany(
        { id, slug: 'acme', name: 'Original Name' },
        false,
      );
      await dbService.setCompany({ id, name: 'Updated Name' }, false);

      const record = await companyRepo.findOneBy({ id });
      expect(record!.slug).toBe('acme');
    });

    it('destroys the prior record with the same slug when replace=true', async () => {
      await dbService.setCompany({ slug: 'acme', name: 'First' }, true);
      await dbService.setCompany({ slug: 'acme', name: 'Second' }, true);

      expect(await companyRepo.count({ where: { slug: 'acme' } })).toBe(1);
      expect((await companyRepo.findOneBy({ slug: 'acme' }))!.name).toBe(
        'Second',
      );
    });

    it('throws on a duplicate slug when replace=false', async () => {
      await dbService.setCompany({ slug: 'acme', name: 'First' }, false);
      await expect(
        dbService.setCompany({ slug: 'acme', name: 'Second' }, false),
      ).rejects.toThrow(QueryFailedError);
    });
  });

  // getCompany

  describe('getCompany', () => {
    it('retrieves a company by UUID', async () => {
      const id = randomUUID();
      await dbService.setCompany(
        { id, slug: 'acme', name: 'Acme Corp' },
        false,
      );

      const result = await dbService.getCompany(id);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(id);
    });

    it('retrieves a company by slug', async () => {
      await dbService.setCompany({ slug: 'acme', name: 'Acme Corp' }, true);

      const result = await dbService.getCompany('acme');
      expect(result).not.toBeNull();
      expect(result!.slug).toBe('acme');
    });

    it('returns null for an unknown UUID', async () => {
      expect(await dbService.getCompany(randomUUID())).toBeNull();
    });

    it('returns null for an unknown slug', async () => {
      expect(await dbService.getCompany('does-not-exist')).toBeNull();
    });

    it('routes UUID-shaped strings to findByPk and plain strings to findOne', async () => {
      const id = randomUUID();
      await dbService.setCompany(
        { id, slug: 'plainslug', name: 'Acme' },
        false,
      );

      expect(await dbService.getCompany(id)).not.toBeNull();
      expect(await dbService.getCompany('plainslug')).not.toBeNull();
      expect(await dbService.getCompany('other-slug')).toBeNull();
    });
  });

  // createRole / getRole / listRoles

  describe('createRole', () => {
    it('creates and retrieves a role', async () => {
      const company = await seedCompany();
      const role = await dbService.createRole({
        companyId: company.id,
        name: 'analyst',
        description: 'Analyses data.',
        llmConfig: { provider: 'lm-studio', model: 'qwen3-5b' },
        systemPromptTemplate: 'You are {{name}}.',
        knowledgeDomains: [],
        mcpServerList: [],
      });

      const found = await dbService.getRole(role.id);
      expect(found).not.toBeNull();
      expect(found!.name).toBe('analyst');
      expect(found!.llmConfig.model).toBe('qwen3-5b');
    });

    it('getRole returns null for unknown id', async () => {
      expect(await dbService.getRole(randomUUID())).toBeNull();
    });

    it('listRoles returns only roles for the given company', async () => {
      const company = await seedCompany();
      await dbService.createRole({
        companyId: company.id,
        name: 'planner',
        description: 'Plans.',
        llmConfig: { provider: 'lm-studio', model: 'qwen3-5b' },
        systemPromptTemplate: '',
        knowledgeDomains: [],
        mcpServerList: [],
      });

      const result = await dbService.listRoles(company.id);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('planner');
    });
  });

  // createAgent / getAgent / updateAgentStatus

  describe('createAgent', () => {
    it('creates an agent in idle status with null threadId', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const agent = await dbService.createAgent({
        companyId: company.id,
        roleId: role.id,
        initialPrompt: 'Summarise.',
      });

      const found = await dbService.getAgent(agent.id);
      expect(found).not.toBeNull();
      expect(found!.status).toBe(AgentStatus.Idle);
      expect(found!.threadId).toBeNull();
    });

    it('getAgent returns null for unknown id', async () => {
      expect(await dbService.getAgent(randomUUID())).toBeNull();
    });

    it('updateAgentStatus changes status and optionally sets threadId', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const agent = await dbService.createAgent({
        companyId: company.id,
        roleId: role.id,
        initialPrompt: 'Go.',
      });

      await dbService.updateAgentStatus(
        agent.id,
        AgentStatus.Running,
        agent.id,
      );

      const found = await agentRepo.findOneByOrFail({ id: agent.id });
      expect(found.status).toBe(AgentStatus.Running);
      expect(found.threadId).toBe(agent.id);
    });
  });

  // saveAuditEvent

  describe('saveAuditEvent', () => {
    it('persists an audit event with the correct fields', async () => {
      const company = await seedCompany();
      const event = await dbService.saveAuditEvent(
        company.id,
        'analyst',
        null,
        AuditEventType.LlmRequest,
        { tokens: 42 },
      );

      const found = await auditRepo.findOneByOrFail({ id: event.id });
      expect(found.eventType).toBe(AuditEventType.LlmRequest);
      expect(found.payload).toEqual({ tokens: 42 });
      expect(found.agentId).toBeNull();
    });
  });
});
