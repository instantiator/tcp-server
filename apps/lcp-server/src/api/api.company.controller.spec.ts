import { randomUUID } from 'crypto';
import { LcpCompany } from '@lcp/shared';
import { CompanyController } from './api.company.controller';
import { ApiService } from './api.service';

const makeApiService = (): jest.Mocked<
  Pick<ApiService, 'createCompany' | 'setCompany' | 'getCompany'>
> => ({
  createCompany: jest.fn().mockResolvedValue(undefined),
  setCompany: jest.fn().mockResolvedValue(undefined),
  getCompany: jest.fn().mockResolvedValue(null),
});

describe('CompanyController', () => {
  let api: ReturnType<typeof makeApiService>;
  let controller: CompanyController;

  beforeEach(() => {
    api = makeApiService();
    controller = new CompanyController(api as unknown as ApiService);
  });

  describe('postCompany', () => {
    it('calls apiService.createCompany with the template and slug', async () => {
      await controller.postCompany({ name: 'Acme Corp', slug: 'acme' });
      expect(api.createCompany).toHaveBeenCalledWith(
        { name: 'Acme Corp' },
        'acme',
      );
    });

    it('resolves without throwing', async () => {
      await expect(
        controller.postCompany({ name: 'Acme', slug: 'acme' }),
      ).resolves.not.toThrow();
    });
  });

  describe('putCompany', () => {
    it('calls apiService.setCompany with the id and company', async () => {
      const id = randomUUID();
      const company = { id, slug: 'acme', name: 'Acme' };
      await controller.putCompany(id, company);
      expect(api.setCompany).toHaveBeenCalledWith(id, company);
    });

    it('throws when the path id does not match the body id', async () => {
      const id = randomUUID();
      const company = { id: randomUUID(), slug: 'acme', name: 'Acme' };
      await expect(
        controller.putCompany(id, company as LcpCompany),
      ).rejects.toThrow();
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
      const fakeCompany = { id, slug: 'acme', name: 'Acme' };
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
});
