import { LcpCompany } from '@lcp/shared';
import { randomUUID } from 'crypto';
import { DbService } from '../db/db.service';
import { LcpCompanyTemplate } from '../templates/LcpCompanyTemplate';
import { ApiService } from './api.service';

const makeDbService = (): jest.Mocked<
  Pick<DbService, 'createCompany' | 'setCompany' | 'getCompany'>
> => ({
  createCompany: jest.fn().mockResolvedValue(undefined),
  setCompany: jest.fn().mockResolvedValue(undefined),
  getCompany: jest.fn().mockResolvedValue(null),
});

describe('ApiService', () => {
  let db: ReturnType<typeof makeDbService>;
  let api: ApiService;

  beforeEach(() => {
    db = makeDbService();
    api = new ApiService(db as unknown as DbService);
  });

  describe('createCompany', () => {
    it('calls dbService.createCompany with the template, slug, and creator identity', async () => {
      const template: LcpCompanyTemplate = {
        name: 'Acme Corp',
        description: 'A Company That Makes Everything',
        mcpServerList: [],
      };
      const slug = 'acme';
      await api.createCompany(template, slug, 'alice', 'Alice');
      expect(db.createCompany).toHaveBeenCalledWith(
        template,
        slug,
        'alice',
        'Alice',
      );
    });

    it('returns the result from dbService.createCompany', async () => {
      const fakeCompany = {
        id: randomUUID(),
        slug: 'acme',
        name: 'Acme Corp',
      } as LcpCompany;
      db.createCompany.mockResolvedValue(fakeCompany);
      const result = await api.createCompany(
        {
          name: 'Acme Corp',
          description: 'A Company That Makes Everything',
          mcpServerList: [],
        },
        'acme',
        'alice',
      );
      expect(result).toBe(fakeCompany);
    });
  });

  describe('setCompany', () => {
    it('resolves a UUID-shaped path identifier to identifiers.id', async () => {
      const id = randomUUID();
      const company = { slug: 'acme', name: 'Acme' };
      await api.setCompany(id, company);
      expect(db.setCompany).toHaveBeenCalledWith(company, { id });
    });

    it('resolves a non-UUID path identifier to identifiers.slug', async () => {
      const company = { name: 'Acme' };
      await api.setCompany('acme', company);
      expect(db.setCompany).toHaveBeenCalledWith(company, { slug: 'acme' });
    });
  });

  describe('getCompany', () => {
    it('calls dbService.getCompany with the given UUID', async () => {
      const id = randomUUID();
      await api.getCompany(id);
      expect(db.getCompany).toHaveBeenCalledWith(id);
    });

    it('returns whatever dbService.getCompany resolves to', async () => {
      const id = randomUUID();
      const fakeCompany = {
        id,
        slug: 'acme',
        name: 'Acme',
        description: 'A Company That Makes Everything',
        mcpServerList: [],
      };
      db.getCompany.mockResolvedValue(fakeCompany);

      const result = await api.getCompany(id);
      expect(result).toBe(fakeCompany);
    });

    it('returns null when dbService.getCompany resolves to null', async () => {
      db.getCompany.mockResolvedValue(null);
      const result = await api.getCompany(randomUUID());
      expect(result).toBeNull();
    });
  });
});
