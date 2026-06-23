import { randomUUID } from 'crypto';
import { DbService } from '../db/db.service';
import { CompanyController } from './api.company.controller';
import { ApiService } from './api.service';

const makeApiService = (): jest.Mocked<
  Pick<ApiService, 'createCompany' | 'setCompany' | 'getCompany'>
> => ({
  createCompany: jest.fn().mockResolvedValue(undefined),
  setCompany: jest.fn().mockResolvedValue(undefined),
  getCompany: jest.fn().mockResolvedValue(null),
});

const makeDbService = (): jest.Mocked<
  Pick<DbService, 'listRoles' | 'listCompanies'>
> => ({
  listRoles: jest.fn().mockResolvedValue([]),
  listCompanies: jest.fn().mockResolvedValue([]),
});

describe('CompanyController', () => {
  let api: ReturnType<typeof makeApiService>;
  let db: ReturnType<typeof makeDbService>;
  let controller: CompanyController;

  beforeEach(() => {
    api = makeApiService();
    db = makeDbService();
    controller = new CompanyController(
      api as unknown as ApiService,
      db as unknown as DbService,
    );
  });

  describe('postCompany', () => {
    it('calls apiService.createCompany with the template and slug', async () => {
      await controller.postCompany({
        name: 'Acme Corp',
        slug: 'acme',
        description: 'A Company That Makes Everything',
      });
      expect(api.createCompany).toHaveBeenCalledWith(
        { name: 'Acme Corp', description: 'A Company That Makes Everything' },
        'acme',
      );
    });

    it('resolves without throwing', async () => {
      await expect(
        controller.postCompany({
          name: 'Acme',
          slug: 'acme',
          description: 'A Company That Makes Everything',
        }),
      ).resolves.not.toThrow();
    });
  });

  describe('putCompany', () => {
    it('calls apiService.setCompany with the path id and partial body', async () => {
      const id = randomUUID();
      const partial = { slug: 'acme', name: 'Acme' };
      await controller.putCompany(id, partial);
      expect(api.setCompany).toHaveBeenCalledWith(id, partial);
    });

    it('allows a partial body with only some fields', async () => {
      const id = randomUUID();
      await controller.putCompany(id, { name: 'Updated Name' });
      expect(api.setCompany).toHaveBeenCalledWith(id, { name: 'Updated Name' });
    });

    it('allows patching a nested llmDefault field', async () => {
      const id = randomUUID();
      const partial = { llmDefault: { model: 'gpt-4o-mini' } };
      await controller.putCompany(id, partial);
      expect(api.setCompany).toHaveBeenCalledWith(id, partial);
    });
  });

  describe('getCompany', () => {
    it('calls apiService.getCompany with the provided id', async () => {
      const id = randomUUID();
      await controller.getCompany(id);
      expect(api.getCompany).toHaveBeenCalledWith(id);
    });

    it('returns the result from apiService.getCompany', async () => {
      const id = randomUUID();
      const fakeCompany = {
        id,
        slug: 'acme',
        name: 'Acme',
        description: 'A Company That Makes Everything',
      };
      api.getCompany.mockResolvedValue(fakeCompany);

      const result = await controller.getCompany(id);
      expect(result).toBe(fakeCompany);
    });

    it('returns null when apiService.getCompany returns null', async () => {
      api.getCompany.mockResolvedValue(null);
      const result = await controller.getCompany(randomUUID());
      expect(result).toBeNull();
    });
  });

  describe('listCompanies', () => {
    it('delegates to dbService.listCompanies and returns the result', async () => {
      const companies = [
        {
          id: randomUUID(),
          slug: 'acme',
          name: 'Acme',
          description: 'A Company That Makes Everything',
        },
      ];
      db.listCompanies.mockResolvedValue(companies);

      const result = await controller.listCompanies();
      expect(db.listCompanies).toHaveBeenCalledTimes(1);
      expect(result).toBe(companies);
    });
  });

  describe('listRoles', () => {
    it('delegates to dbService.listRoles with the company id', async () => {
      const id = randomUUID();
      await controller.listRoles(id);
      expect(db.listRoles).toHaveBeenCalledWith(id);
    });
  });
});
