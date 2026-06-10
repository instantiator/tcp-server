import { randomUUID } from 'crypto';
import { DbService } from '../db/db.service';
import { LcpCompany } from '../models';
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
    it('calls dbService.createCompany with the template and slug', async () => {
      const template: LcpCompanyTemplate = { name: 'Acme Corp' };
      const slug = 'acme';
      await api.createCompany(template, slug);
      expect(db.createCompany).toHaveBeenCalledWith(template, slug);
    });

    it('returns the result from dbService.createCompany', async () => {
      const fakeCompany = {
        id: randomUUID(),
        slug: 'acme',
        name: 'Acme Corp',
      } as LcpCompany;
      db.createCompany.mockResolvedValue(fakeCompany);
      const result = await api.createCompany({ name: 'Acme Corp' }, 'acme');
      expect(result).toBe(fakeCompany);
    });
  });

  describe('setCompany', () => {
    it('calls dbService.setCompany with replace=false', async () => {
      const id = randomUUID();
      const company = { slug: 'acme', name: 'Acme' };
      await api.setCompany(id, company);
      expect(db.setCompany).toHaveBeenCalledWith({ ...company, id }, false);
    });

    it('merges the id parameter into the company object', async () => {
      const id = randomUUID();
      await api.setCompany(id, { slug: 'acme', name: 'Acme' });
      const [called] = db.setCompany.mock.calls[0];
      expect(called.id).toBe(id);
    });

    it('explicit id parameter overwrites any id already in the body', async () => {
      const correctId = randomUUID();
      const bodyId = randomUUID();
      await api.setCompany(correctId, {
        id: bodyId,
        slug: 'acme',
        name: 'Acme',
      });
      const [called] = db.setCompany.mock.calls[0];
      expect(called.id).toBe(correctId);
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
      const fakeCompany = { id, slug: 'acme', name: 'Acme' };
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
