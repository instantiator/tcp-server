import { NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Response } from 'express';
import { TcpRole } from '@lcp/shared';
import { RoleController } from './api.role.controller';
import { DbService } from '../db/db.service';

const fakeRes = (): Response =>
  ({ setHeader: jest.fn() }) as unknown as Response;

function makeRole(overrides: Partial<TcpRole> = {}): TcpRole {
  return {
    id: randomUUID(),
    companyId: randomUUID(),
    slug: 'analyst',
    name: 'analyst',
    description: 'Analyses.',
    llmConfig: { provider: 'lm-studio', model: 'qwen3-5b' },
    systemPromptTemplate: 'You are {{name}}.',
    knowledgeDomains: [],
    mcpServerList: [],
    queryIndex: 0,
    company: {} as never,
    ...overrides,
  };
}

describe('RoleController', () => {
  let db: jest.Mocked<Pick<DbService, 'setRole' | 'getRole' | 'deleteRole'>>;
  let controller: RoleController;

  beforeEach(() => {
    db = {
      setRole: jest.fn(),
      getRole: jest.fn(),
      deleteRole: jest.fn().mockResolvedValue(true),
    };
    controller = new RoleController(db as unknown as DbService);
  });

  describe('createRole', () => {
    it('delegates to db.setRole and returns the result', async () => {
      const role = makeRole();
      db.setRole.mockResolvedValue(role);

      const result = await controller.createRole(
        {
          companyId: role.companyId,
          slug: role.slug,
          name: role.name,
          description: role.description,
          llmConfig: role.llmConfig ?? undefined,
          systemPromptTemplate: role.systemPromptTemplate ?? undefined,
          knowledgeDomains: [],
          mcpServerList: [],
        },
        fakeRes(),
      );

      expect(db.setRole).toHaveBeenCalledTimes(1);
      expect(result.id).toBe(role.id);
    });

    it('propagates NotFoundException when the company does not exist', async () => {
      db.setRole.mockRejectedValue(new NotFoundException('Company not found'));
      await expect(
        controller.createRole(
          {
            companyId: randomUUID(),
            slug: 'orphan',
            name: 'orphan',
            description: 'No company.',
            systemPromptTemplate: 'You are {{name}}.',
            knowledgeDomains: [],
            mcpServerList: [],
          },
          fakeRes(),
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateRole', () => {
    it('delegates to db.setRole with the path id', async () => {
      const role = makeRole();
      db.setRole.mockResolvedValue(role);

      const result = await controller.updateRole(
        role.id,
        { name: 'updated' },
        fakeRes(),
      );
      expect(db.setRole).toHaveBeenCalledWith(
        { name: 'updated' },
        { id: role.id },
      );
      expect(result.id).toBe(role.id);
    });

    it('accepts a partial llmConfig patch without the full object', async () => {
      const role = makeRole();
      db.setRole.mockResolvedValue(role);

      const partial = {
        llmConfig: { provider: 'lm-studio', model: 'gpt-4o-mini' },
      };
      await controller.updateRole(role.id, partial, fakeRes());
      expect(db.setRole).toHaveBeenCalledWith(partial, { id: role.id });
    });

    it('propagates NotFoundException when the role does not exist', async () => {
      db.setRole.mockRejectedValue(new NotFoundException('Role not found'));
      await expect(
        controller.updateRole(randomUUID(), { name: 'x' }, fakeRes()),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('getRole', () => {
    it('returns the role when found', async () => {
      const role = makeRole();
      db.getRole.mockResolvedValue(role);

      const result = await controller.getRole(role.id);
      expect(result.id).toBe(role.id);
    });

    it('throws NotFoundException when the role does not exist', async () => {
      db.getRole.mockResolvedValue(null);

      await expect(controller.getRole(randomUUID())).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('deleteRole', () => {
    it('delegates to db.deleteRole and resolves when deleted', async () => {
      const id = randomUUID();
      db.deleteRole.mockResolvedValue(true);

      await expect(controller.deleteRole(id)).resolves.toBeUndefined();
      expect(db.deleteRole).toHaveBeenCalledWith(id);
    });

    it('throws NotFoundException when nothing was deleted', async () => {
      db.deleteRole.mockResolvedValue(false);
      await expect(controller.deleteRole(randomUUID())).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
