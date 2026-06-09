import { randomUUID } from 'crypto';
import { TcpCompany } from '../models';
import { CompanyController } from './api.company.controller';
import { ApiService } from './api.service';

const makeApiService = (): jest.Mocked<
  Pick<ApiService, 'createCompany' | 'updateCompany' | 'getCompany'>
> => ({
  createCompany: jest.fn().mockResolvedValue(undefined),
  updateCompany: jest.fn().mockResolvedValue(undefined),
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
    it('calls apiService.createCompany with the provided company', async () => {
      const company = { slug: 'acme', name: 'Acme Corp' };
      await controller.postCompany(company as TcpCompany);
      expect(api.createCompany).toHaveBeenCalledWith(company);
    });

    it('resolves without throwing', async () => {
      await expect(
        controller.postCompany({ slug: 'acme', name: 'Acme' } as TcpCompany),
      ).resolves.not.toThrow();
    });
  });

  describe('putCompany', () => {
    it('calls apiService.updateCompany with the id and company', async () => {
      const id = randomUUID();
      const company = { slug: 'acme', name: 'Acme' };
      await controller.putCompany(id, company as TcpCompany);
      expect(api.updateCompany).toHaveBeenCalledWith(id, company);
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
      api.getCompany.mockResolvedValue(fakeCompany as TcpCompany);

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
