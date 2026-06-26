import { NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { DeleteResult, Repository } from 'typeorm';
import { CompanyUser } from '@lcp/shared';
import { CompanyUserController } from './company-user.controller';

const makeRepo = (): jest.Mocked<
  Pick<
    Repository<CompanyUser>,
    'findBy' | 'findOne' | 'create' | 'save' | 'delete'
  >
> => ({
  findBy: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
  create: jest.fn().mockImplementation((d) => d as CompanyUser),
  save: jest.fn().mockImplementation((u) => Promise.resolve(u as CompanyUser)),
  delete: jest.fn().mockResolvedValue({ affected: 1 }),
});

describe('CompanyUserController', () => {
  let repo: ReturnType<typeof makeRepo>;
  let ctrl: CompanyUserController;
  const companyId = randomUUID();

  beforeEach(() => {
    repo = makeRepo();
    ctrl = new CompanyUserController(
      repo as unknown as Repository<CompanyUser>,
    );
  });

  describe('listUsers', () => {
    it('delegates to repository.findBy with the companyId', async () => {
      await ctrl.listUsers(companyId);
      expect(repo.findBy).toHaveBeenCalledWith({ companyId });
    });
  });

  describe('createUser', () => {
    it('creates a user with required fields and defaults', async () => {
      await ctrl.createUser(companyId, {
        identifier: 'alice@example.com',
        memberType: 'member',
      });
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId,
          identifier: 'alice@example.com',
          memberType: 'member',
          name: null,
          roles: [],
          knowledgeDomains: [],
        }),
      );
      expect(repo.save).toHaveBeenCalled();
    });

    it('passes through optional fields when provided', async () => {
      await ctrl.createUser(companyId, {
        identifier: 'bob@example.com',
        name: 'Bob',
        memberType: 'owner',
        roles: ['finance'],
        knowledgeDomains: ['accounting'],
      });
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Bob',
          roles: ['finance'],
          knowledgeDomains: ['accounting'],
        }),
      );
    });
  });

  describe('updateUser', () => {
    it('throws NotFoundException when user not found', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(
        ctrl.updateUser(companyId, randomUUID(), { name: 'Alice' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('patches only the provided fields', async () => {
      const existing = {
        id: randomUUID(),
        companyId,
        identifier: 'alice@example.com',
        name: 'Alice',
        memberType: 'member',
        roles: [],
        knowledgeDomains: [],
        createdAt: new Date(),
      } as CompanyUser;
      repo.findOne.mockResolvedValue(existing);

      await ctrl.updateUser(companyId, existing.id, { roles: ['hr'] });

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ roles: ['hr'], name: 'Alice' }),
      );
    });
  });

  describe('deleteUser', () => {
    it('calls repository.delete with the userId and companyId', async () => {
      const userId = randomUUID();
      await ctrl.deleteUser(companyId, userId);
      expect(repo.delete).toHaveBeenCalledWith({ id: userId, companyId });
    });

    it('throws NotFoundException when nothing was deleted', async () => {
      repo.delete.mockResolvedValue({ affected: 0 } as DeleteResult);
      await expect(ctrl.deleteUser(companyId, randomUUID())).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
