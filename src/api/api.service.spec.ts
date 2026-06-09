import { randomUUID } from 'crypto';
import { DbService } from '../db/db.service';
import { LcpCompany } from '../models';
import { ApiService } from './api.service';

const makeDbService = (): jest.Mocked<
  Pick<DbService, 'setCompany' | 'getCompany'>
> => ({
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
    it('calls setCompany with replace=true', async () => {
      const company = { slug: 'acme', name: 'Acme Corp' };
      await api.createCompany(company);
      expect(db.setCompany).toHaveBeenCalledWith(company, true);
    });

    it('passes the company object through unmodified', async () => {
      const company = { slug: 'acme', name: 'Acme' };
      await api.createCompany(company);
      expect(db.setCompany).toHaveBeenCalledWith(company, true);
    });
  });

  describe('updateCompany', () => {
    it('calls setCompany with replace=false', async () => {
      const id = randomUUID();
      const company = { slug: 'acme', name: 'Acme' };
      await api.updateCompany(id, company);
      expect(db.setCompany).toHaveBeenCalledWith({ ...company, id }, false);
    });

    it('merges the id parameter into the company object', async () => {
      const id = randomUUID();
      await api.updateCompany(id, { slug: 'acme', name: 'Acme' });
      const [called] = db.setCompany.mock.calls[0];
      expect(called.id).toBe(id);
    });

    it('explicit id parameter overwrites any id already in the body', async () => {
      const correctId = randomUUID();
      const bodyId = randomUUID();
      await api.updateCompany(correctId, {
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
      db.getCompany.mockResolvedValue(fakeCompany as LcpCompany);

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
