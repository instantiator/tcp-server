import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { QueryFailedError, Repository } from 'typeorm';
import { LcpCompany } from '@lcp/shared';
import { DbService } from './db.service';

describe('DbService', () => {
  let dbService: DbService;
  let repo: Repository<LcpCompany>;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          entities: [LcpCompany],
          synchronize: true,
        }),
        TypeOrmModule.forFeature([LcpCompany]),
      ],
      providers: [DbService],
    }).compile();

    dbService = module.get(DbService);
    repo = module.get(getRepositoryToken(LcpCompany));
  });

  afterEach(async () => {
    await repo.clear();
  });

  describe('createCompany', () => {
    it('persists a new record with the given slug and template fields', async () => {
      await dbService.createCompany({ name: 'Acme Corp' }, 'acme');
      const record = await repo.findOneBy({ slug: 'acme' });
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

      expect(await repo.count({ where: { slug: 'acme' } })).toBe(1);
      expect((await repo.findOneBy({ slug: 'acme' }))!.name).toBe('Second');
    });
  });

  describe('setCompany', () => {
    it('creates a new record when replace=true and no prior record exists', async () => {
      await dbService.setCompany({ slug: 'acme', name: 'Acme Corp' }, true);
      expect(await repo.count()).toBe(1);
    });

    it('creates a new record when replace=false', async () => {
      await dbService.setCompany({ slug: 'acme', name: 'Acme Corp' }, false);
      const record = await repo.findOneBy({ slug: 'acme' });
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

      expect(await repo.count()).toBe(1);
      const record = await repo.findOneBy({ id });
      expect(record!.name).toBe('Updated Name');
    });

    it('does not overwrite unmodified fields when updating', async () => {
      const id = randomUUID();
      await dbService.setCompany(
        { id, slug: 'acme', name: 'Original Name' },
        false,
      );
      await dbService.setCompany({ id, name: 'Updated Name' }, false);

      const record = await repo.findOneBy({ id });
      expect(record!.slug).toBe('acme');
    });

    it('destroys the prior record with the same slug when replace=true', async () => {
      await dbService.setCompany({ slug: 'acme', name: 'First' }, true);
      await dbService.setCompany({ slug: 'acme', name: 'Second' }, true);

      expect(await repo.count({ where: { slug: 'acme' } })).toBe(1);
      expect((await repo.findOneBy({ slug: 'acme' }))!.name).toBe('Second');
    });

    it('throws on a duplicate slug when replace=false', async () => {
      await dbService.setCompany({ slug: 'acme', name: 'First' }, false);
      await expect(
        dbService.setCompany({ slug: 'acme', name: 'Second' }, false),
      ).rejects.toThrow(QueryFailedError);
    });
  });

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
});
