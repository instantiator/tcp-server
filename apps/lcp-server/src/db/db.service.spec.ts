import {
  AgentStatus,
  AuditEvent,
  AuditEventType,
  CompanyUser,
  LcpAgent,
  LcpAssignment,
  LcpCompany,
  LcpRole,
  LcpTask,
} from '@lcp/shared';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { randomUUID, UUID } from 'crypto';
import { QueryFailedError, Repository } from 'typeorm';
import { DbService } from './db.service';

const ALL_ENTITIES = [
  LcpCompany,
  LcpRole,
  LcpAgent,
  LcpTask,
  LcpAssignment,
  AuditEvent,
  CompanyUser,
];

describe('DbService', () => {
  let dbService: DbService;
  let companyRepo: Repository<LcpCompany>;
  let roleRepo: Repository<LcpRole>;
  let agentRepo: Repository<LcpAgent>;
  let assignmentRepo: Repository<LcpAssignment>;
  let auditRepo: Repository<AuditEvent>;
  let companyUserRepo: Repository<CompanyUser>;

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
    assignmentRepo = testingModule.get(getRepositoryToken(LcpAssignment));
    auditRepo = testingModule.get(getRepositoryToken(AuditEvent));
    companyUserRepo = testingModule.get(getRepositoryToken(CompanyUser));
  });

  afterEach(async () => {
    await auditRepo.clear();
    // Agents before assignments (agent.assignmentId FK), assignments before roles.
    await agentRepo.clear();
    await assignmentRepo.clear();
    await roleRepo.clear();
    await companyUserRepo.clear();
    await companyRepo.clear();
  });

  // Helpers

  async function seedCompany() {
    return companyRepo.save(
      companyRepo.create({
        slug: 'acme',
        name: 'ACME',
        description: 'A Company that Makes Everything',
      }),
    );
  }

  async function seedRole(companyId: UUID) {
    return roleRepo.save(
      roleRepo.create({
        companyId,
        slug: 'analyst',
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
      await dbService.createCompany(
        {
          name: 'Acme Corp',
          description: 'A Company That Makes Everything',
          mcpServerList: [],
        },
        'acme',
        'alice',
      );
      const record = await companyRepo.findOneBy({ slug: 'acme' });
      expect(record).not.toBeNull();
      expect(record!.name).toBe('Acme Corp');
      expect(record!.slug).toBe('acme');
    });

    it('assigns a UUID to the new record', async () => {
      const result = await dbService.createCompany(
        {
          name: 'Acme Corp',
          description: 'A Company That Makes Everything',
          mcpServerList: [],
        },
        'acme',
        'alice',
      );
      expect(result.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it('replaces an existing record with the same slug', async () => {
      await dbService.createCompany(
        { name: 'First', description: 'v1', mcpServerList: [] },
        'acme',
        'alice',
      );
      await dbService.createCompany(
        { name: 'Second', description: 'v2', mcpServerList: [] },
        'acme',
        'alice',
      );

      expect(await companyRepo.count({ where: { slug: 'acme' } })).toBe(1);
      expect((await companyRepo.findOneBy({ slug: 'acme' }))!.name).toBe(
        'Second',
      );
    });

    it('adds the creator as a CompanyUser with memberType "creator"', async () => {
      const company = await dbService.createCompany(
        { name: 'Acme Corp', description: 'A co', mcpServerList: [] },
        'acme',
        'alice',
        'Alice',
      );
      const creator = await companyUserRepo.findOneBy({
        companyId: company.id,
        identifier: 'alice',
      });
      expect(creator).not.toBeNull();
      expect(creator!.memberType).toBe('creator');
      expect(creator!.name).toBe('Alice');
    });

    it('throws BadRequestException and rolls back when plannerRoleId does not belong to the new company', async () => {
      // A brand-new company has no roles of its own yet, so a plannerRoleId
      // referencing a role that belongs to a different (existing) company is
      // the case that must be caught — an outright unknown role id already
      // fails the FK constraint before reaching this check. Uses a distinct
      // slug from 'acme' — createCompany('acme', ...) deletes (and cascades)
      // any existing 'acme'-slugged company first, which would take the
      // fixture role down with it.
      const other = await companyRepo.save(
        companyRepo.create({
          slug: 'other-co',
          name: 'Other',
          description: 'd',
        }),
      );
      const foreignRole = await seedRole(other.id);

      await expect(
        dbService.createCompany(
          {
            name: 'Acme Corp',
            description: 'A co',
            mcpServerList: [],
            plannerRoleId: foreignRole.id,
          },
          'acme',
          'alice',
        ),
      ).rejects.toThrow(BadRequestException);
      expect(await companyRepo.count({ where: { slug: 'acme' } })).toBe(0);
    });
  });

  // setCompany

  describe('setCompany', () => {
    it('creates a new record when no identifiers resolve to an existing one', async () => {
      await dbService.setCompany({
        slug: 'acme',
        name: 'Acme Corp',
        description: 'A company that makes everything',
      });
      expect(await companyRepo.count()).toBe(1);
    });

    it('updates an existing record when company.id matches', async () => {
      const created = await dbService.setCompany({
        slug: 'acme',
        name: 'Original Name',
        description: 'Company',
      });
      await dbService.setCompany({
        id: created.id,
        slug: 'acme',
        name: 'Updated Name',
      });

      expect(await companyRepo.count()).toBe(1);
      const record = await companyRepo.findOneBy({ id: created.id });
      expect(record!.name).toBe('Updated Name');
    });

    it('updates an existing record when identifiers.id is given instead of company.id', async () => {
      const created = await dbService.setCompany({
        slug: 'acme',
        name: 'Original Name',
        description: 'Company',
      });
      const updated = await dbService.setCompany(
        { name: 'Updated Name' },
        { id: created.id },
      );

      expect(await companyRepo.count()).toBe(1);
      expect(updated.name).toBe('Updated Name');
      expect(updated.id).toBe(created.id);
    });

    it('updates an existing record when identifiers.slug is given', async () => {
      const created = await dbService.setCompany({
        slug: 'acme',
        name: 'Original Name',
        description: 'Company',
      });
      const updated = await dbService.setCompany(
        { name: 'Updated Name' },
        { slug: 'acme' },
      );

      expect(await companyRepo.count()).toBe(1);
      expect(updated.name).toBe('Updated Name');
      expect(updated.id).toBe(created.id);
    });

    it('does not overwrite unmodified fields when updating', async () => {
      const created = await dbService.setCompany({
        slug: 'acme',
        name: 'Original Name',
        description: 'Original company',
      });
      await dbService.setCompany({ id: created.id, name: 'Updated Name' });

      const record = await companyRepo.findOneBy({ id: created.id });
      expect(record!.slug).toBe('acme');
    });

    it('throws NotFoundException when identifiers.id does not match an existing record', async () => {
      await expect(
        dbService.setCompany({ name: 'Updated Name' }, { id: randomUUID() }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when identifiers.slug does not match an existing record', async () => {
      await expect(
        dbService.setCompany(
          { name: 'Updated Name' },
          { slug: 'no-such-slug' },
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('never leaves the company missing between calls (no delete-then-recreate)', async () => {
      const created = await dbService.setCompany({
        slug: 'acme',
        name: 'Original Name',
        description: 'Company',
      });
      // If this were still delete-by-slug-then-insert, a lookup racing between
      // the two setCompany calls could observe the company as gone. Since
      // there's no delete step at all, it's always found via getCompany here.
      await dbService.setCompany({ name: 'Updated Name' }, { slug: 'acme' });
      expect(await dbService.getCompany(created.id)).not.toBeNull();
    });

    it('throws on a duplicate slug when creating a new company', async () => {
      await dbService.setCompany({
        slug: 'acme',
        name: 'First',
        description: 'A company that makes everything',
      });
      await expect(
        dbService.setCompany({
          slug: 'acme',
          name: 'Second',
          description: 'A company that makes everything',
        }),
      ).rejects.toThrow(QueryFailedError);
    });

    it('allows removing llmConfig even when roles have no llmConfig (env fallback covers)', async () => {
      const created = await dbService.setCompany({
        slug: 'llm-co',
        name: 'LLM Co',
        description: 'LLM Company',
        llmConfig: { provider: 'openai', model: 'gpt-4o' },
      });
      await roleRepo.save(
        roleRepo.create({
          companyId: created.id,
          slug: 'inheritor',
          name: 'inheritor',
          description: 'Uses company default.',
          systemPromptTemplate: 'You are {{name}}.',
        }),
      );
      // Removing llmConfig must succeed — env fallback covers orphaned roles at runtime
      await expect(
        dbService.setCompany({
          id: created.id,
          slug: 'llm-co',
          name: 'LLM Co',
          description: 'LLM Company',
          llmConfig: null,
        }),
      ).resolves.toBeDefined();
    });

    it('deep-merges llmConfig so a partial patch preserves other fields', async () => {
      const created = await dbService.setCompany({
        slug: 'merge-co',
        name: 'Merge Co',
        description: 'Merge Company',
        llmConfig: {
          provider: 'openai',
          model: 'gpt-4o',
          apiKey: 'test-api-key',
        },
      });

      const updated = await dbService.setCompany({
        id: created.id,
        slug: 'merge-co',
        name: 'Merge Co',
        description: 'Merge Company',
        llmConfig: { model: 'gpt-4o-mini' },
      });

      expect(updated.llmConfig!.model).toBe('gpt-4o-mini');
      expect(updated.llmConfig!.provider).toBe('openai');
      expect(updated.llmConfig!.apiKey).toBe('test-api-key');
    });

    it('allows removing llmConfig when all roles have their own llmConfig', async () => {
      const created = await dbService.setCompany({
        slug: 'llm-co2',
        name: 'LLM Co 2',
        description: 'LLM Company 1',
        llmConfig: { provider: 'openai', model: 'gpt-4o' },
      });
      // Role has its own llmConfig — not reliant on the company default
      await roleRepo.save(
        roleRepo.create({
          companyId: created.id,
          slug: 'self-configured',
          name: 'self-configured',
          description: 'Has own config.',
          llmConfig: { provider: 'lm-studio', model: 'qwen3-5b' },
          systemPromptTemplate: 'You are {{name}}.',
        }),
      );
      // Removing llmConfig must succeed
      await expect(
        dbService.setCompany({
          id: created.id,
          slug: 'llm-co2',
          name: 'LLM Co 2',
          description: 'LLM company 2',
        }),
      ).resolves.toBeDefined();
    });

    it('persists plannerRoleId when it belongs to the company being updated', async () => {
      const created = await dbService.setCompany({
        slug: 'planner-co',
        name: 'Planner Co',
        description: 'd',
      });
      const role = await seedRole(created.id);
      const updated = await dbService.setCompany(
        { plannerRoleId: role.id },
        { id: created.id },
      );
      expect(updated.plannerRoleId).toBe(role.id);
    });

    it('throws BadRequestException when plannerRoleId belongs to a different company', async () => {
      const created = await dbService.setCompany({
        slug: 'planner-co-a',
        name: 'Planner Co A',
        description: 'd',
      });
      const other = await dbService.setCompany({
        slug: 'planner-co-b',
        name: 'Planner Co B',
        description: 'd',
      });
      const foreignRole = await seedRole(other.id);
      await expect(
        dbService.setCompany(
          { plannerRoleId: foreignRole.id },
          { id: created.id },
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when plannerRoleId does not exist at all', async () => {
      const created = await dbService.setCompany({
        slug: 'planner-co-c',
        name: 'Planner Co C',
        description: 'd',
      });
      await expect(
        dbService.setCompany(
          { plannerRoleId: randomUUID() },
          { id: created.id },
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // getCompany

  describe('getCompany', () => {
    it('retrieves a company by UUID', async () => {
      const created = await dbService.setCompany({
        slug: 'acme',
        name: 'Acme Corp',
        description: 'A Company that Makes Everything',
      });

      const result = await dbService.getCompany(created.id);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(created.id);
    });

    it('retrieves a company by slug', async () => {
      await dbService.setCompany({
        slug: 'acme',
        name: 'Acme Corp',
        description: 'A Company that Makes Everything',
      });

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
      const created = await dbService.setCompany({
        slug: 'plainslug',
        name: 'Acme',
        description: 'A Company that Makes Everything',
      });

      expect(await dbService.getCompany(created.id)).not.toBeNull();
      expect(await dbService.getCompany('plainslug')).not.toBeNull();
      expect(await dbService.getCompany('other-slug')).toBeNull();
    });
  });

  // setRole (create path) / getRole / listRoles

  describe('setRole — create', () => {
    it('creates and retrieves a role', async () => {
      const company = await seedCompany();
      const role = await dbService.setRole({
        companyId: company.id,
        slug: 'analyst',
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
      expect(found!.llmConfig!.model).toBe('qwen3-5b');
    });

    it('getRole returns null for unknown id', async () => {
      expect(await dbService.getRole(randomUUID())).toBeNull();
    });

    it('listRoles returns only roles for the given company', async () => {
      const company = await seedCompany();
      await dbService.setRole({
        companyId: company.id,
        slug: 'planner',
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

    it('accepts a role with no llmConfig when the company has llmConfig', async () => {
      const company = await companyRepo.save(
        companyRepo.create({
          slug: 'default-llm',
          name: 'Default LLM Co',
          description: 'A default company',
          llmConfig: { provider: 'openai', model: 'gpt-4o' },
        }),
      );
      const role = await dbService.setRole({
        companyId: company.id,
        slug: 'inheritor',
        name: 'inheritor',
        description: 'Uses company default.',
        systemPromptTemplate: 'You are {{name}}.',
        knowledgeDomains: [],
        mcpServerList: [],
      });
      expect(role.id).toBeDefined();
      expect(role.llmConfig).toBeNull();
    });

    it('accepts a role with no llmConfig when the company also has no llmConfig (env fallback covers)', async () => {
      const company = await seedCompany();
      const role = await dbService.setRole({
        companyId: company.id,
        slug: 'env-reliant',
        name: 'env-reliant',
        description: 'Relies on env fallback.',
        systemPromptTemplate: 'You are {{name}}.',
        knowledgeDomains: [],
        mcpServerList: [],
      });
      expect(role.id).toBeDefined();
      expect(role.llmConfig).toBeNull();
    });

    it('throws NotFoundException when companyId does not exist in the database', async () => {
      await expect(
        dbService.setRole({
          companyId: randomUUID(),
          slug: 'orphan',
          name: 'orphan',
          description: 'No company.',
          llmConfig: { provider: 'lm-studio', model: 'qwen3-5b' },
          systemPromptTemplate: 'You are {{name}}.',
          knowledgeDomains: [],
          mcpServerList: [],
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException even without llmConfig when companyId does not exist', async () => {
      await expect(
        dbService.setRole({
          companyId: randomUUID(),
          slug: 'orphan',
          name: 'orphan',
          description: 'No company.',
          systemPromptTemplate: 'You are {{name}}.',
          knowledgeDomains: [],
          mcpServerList: [],
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects "shared" as a role slug (reserved for company-wide knowledge)', async () => {
      const company = await seedCompany();
      await expect(
        dbService.setRole({
          companyId: company.id,
          slug: 'shared',
          name: 'shared',
          description: 'Attempting to claim the reserved slug.',
          systemPromptTemplate: '',
          knowledgeDomains: [],
          mcpServerList: [],
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // setRole (update path)

  describe('setRole — update', () => {
    it('throws NotFoundException for an unknown identifiers.id', async () => {
      await expect(
        dbService.setRole({ name: 'x' }, { id: randomUUID() }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException (not a fallback create) for an unknown identifiers.slug', async () => {
      const company = await seedCompany();
      await expect(
        dbService.setRole(
          { companyId: company.id, name: 'x' },
          { slug: 'no-such-role' },
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('updates a top-level field while leaving others unchanged, via role.id', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);

      const updated = await dbService.setRole({
        id: role.id,
        name: 'updated-name',
      });

      expect(updated.name).toBe('updated-name');
      expect(updated.description).toBe(role.description);
      expect(updated.llmConfig!.provider).toBe('lm-studio');
    });

    it('updates a role via identifiers.id instead of role.id', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);

      const updated = await dbService.setRole(
        { name: 'updated-name' },
        { id: role.id },
      );

      expect(updated.name).toBe('updated-name');
    });

    it('updates a role via identifiers.slug scoped to companyId', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);

      const updated = await dbService.setRole(
        { companyId: company.id, name: 'updated-name' },
        { slug: role.slug },
      );

      expect(updated.name).toBe('updated-name');
      expect(updated.id).toBe(role.id);
    });

    it('deep-merges llmConfig so a partial patch preserves other fields', async () => {
      const company = await seedCompany();
      const role = await roleRepo.save(
        roleRepo.create({
          companyId: company.id,
          slug: 'planner',
          name: 'planner',
          description: 'Plans.',
          llmConfig: {
            provider: 'openai',
            model: 'gpt-4o',
            apiKey: 'test-api-key',
          },
          systemPromptTemplate: 'You are {{name}}.',
        }),
      );

      const updated = await dbService.setRole({
        id: role.id,
        llmConfig: { model: 'gpt-4o-mini' },
      });

      expect(updated.llmConfig!.model).toBe('gpt-4o-mini');
      // Provider and apiKey must survive the partial patch
      expect(updated.llmConfig!.provider).toBe('openai');
      expect(updated.llmConfig!.apiKey).toBe('test-api-key');
    });

    it('rejects renaming a role\'s slug to "shared" (reserved for company-wide knowledge)', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);

      await expect(
        dbService.setRole({ id: role.id, slug: 'shared' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // findRoleByIdOrSlug

  describe('findRoleByIdOrSlug', () => {
    it('finds a role by UUID within the given company', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);

      const found = await dbService.findRoleByIdOrSlug(company.id, role.id);
      expect(found?.id).toBe(role.id);
    });

    it('finds a role by slug within the given company', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);

      const found = await dbService.findRoleByIdOrSlug(company.id, role.slug);
      expect(found?.id).toBe(role.id);
    });

    it('returns null when the slug exists but for a different company', async () => {
      const company = await seedCompany();
      await seedRole(company.id);
      const otherCompany = await companyRepo.save(
        companyRepo.create({
          slug: 'other-co',
          name: 'Other Co',
          description: 'A different company',
        }),
      );

      expect(
        await dbService.findRoleByIdOrSlug(otherCompany.id, 'analyst'),
      ).toBeNull();
    });

    it('returns null for an unknown slug', async () => {
      const company = await seedCompany();
      expect(
        await dbService.findRoleByIdOrSlug(company.id, 'no-such-role'),
      ).toBeNull();
    });
  });

  // deleteCompany / deleteRole

  describe('deleteCompany', () => {
    it('deletes an existing company and returns true', async () => {
      const company = await seedCompany();
      expect(await dbService.deleteCompany(company.id)).toBe(true);
      expect(await companyRepo.findOneBy({ id: company.id })).toBeNull();
    });

    it('returns false for an unknown company id', async () => {
      expect(await dbService.deleteCompany(randomUUID())).toBe(false);
    });
  });

  describe('deleteRole', () => {
    it('deletes an existing role and returns true', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      expect(await dbService.deleteRole(role.id)).toBe(true);
      expect(await roleRepo.findOneBy({ id: role.id })).toBeNull();
    });

    it('returns false for an unknown role id', async () => {
      expect(await dbService.deleteRole(randomUUID())).toBe(false);
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

    it('creates and cross-links an orphan implement-mode assignment', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const agent = await dbService.createAgent({
        companyId: company.id,
        roleId: role.id,
        initialPrompt: 'Summarise.',
      });

      const assignment = await assignmentRepo.findOneByOrFail({
        id: agent.assignmentId,
      });
      // Orphan (no task), implement mode, prompt copied, back-linked to the agent.
      expect(assignment.taskId).toBeNull();
      expect(assignment.mode).toBe('implement');
      expect(assignment.status).toBe('in-progress');
      expect(assignment.prompt).toBe('Summarise.');
      expect(assignment.agentId).toBe(agent.id);
      expect(assignment.companyId).toBe(company.id);
      expect(assignment.roleId).toBe(role.id);
      // Default required tool for implement mode.
      expect(agent.requiredToolCalls).toEqual(['complete_assignment']);
    });

    it('honours a supplied mode and does not create a second assignment', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const agent = await dbService.createAgent({
        companyId: company.id,
        roleId: role.id,
        initialPrompt: 'Plan it.',
        mode: 'plan',
      });

      const assignment = await assignmentRepo.findOneByOrFail({
        id: agent.assignmentId,
      });
      expect(assignment.mode).toBe('plan');
      expect(agent.requiredToolCalls).toEqual(['create_plan']);
      expect(await assignmentRepo.count()).toBe(1);
    });

    it('creates a chat-mode assignment with no required tool calls', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const agent = await dbService.createAgent({
        companyId: company.id,
        roleId: role.id,
        initialPrompt: '',
        mode: 'chat',
      });

      const assignment = await assignmentRepo.findOneByOrFail({
        id: agent.assignmentId,
      });
      expect(assignment.mode).toBe('chat');
      // A chat turn ends with narrated text — no completion tool is required.
      expect(agent.requiredToolCalls).toEqual([]);
    });

    it('attaches to a supplied assignment without creating an orphan', async () => {
      const company = await seedCompany();
      const role = await seedRole(company.id);
      const existing = await assignmentRepo.save(
        assignmentRepo.create({
          taskId: null,
          companyId: company.id,
          roleId: role.id,
          mode: 'implement',
          prompt: 'Pre-made.',
          status: 'in-progress',
        }),
      );

      const agent = await dbService.createAgent({
        companyId: company.id,
        roleId: role.id,
        initialPrompt: 'Pre-made.',
        assignmentId: existing.id,
      });

      expect(agent.assignmentId).toBe(existing.id);
      // No extra assignment created.
      expect(await assignmentRepo.count()).toBe(1);
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
