import { NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { LcpRole } from '@lcp/shared';
import { RoleController } from './api.role.controller';
import { DbService } from '../db/db.service';

function makeRole(overrides: Partial<LcpRole> = {}): LcpRole {
  return {
    id: randomUUID(),
    companyId: randomUUID(),
    name: 'analyst',
    description: 'Analyses.',
    llmConfig: { provider: 'lm-studio', model: 'qwen3-5b' },
    systemPromptTemplate: 'You are {{name}}.',
    knowledgeDomains: [],
    mcpServerList: [],
    company: {} as never,
    ...overrides,
  };
}

describe('RoleController', () => {
  let db: jest.Mocked<Pick<DbService, 'createRole' | 'getRole' | 'updateRole'>>;
  let controller: RoleController;

  beforeEach(() => {
    db = {
      createRole: jest.fn(),
      getRole: jest.fn(),
      updateRole: jest.fn(),
    };
    controller = new RoleController(db as unknown as DbService);
  });

  describe('createRole', () => {
    it('delegates to db.createRole and returns the result', async () => {
      const role = makeRole();
      db.createRole.mockResolvedValue(role);

      const result = await controller.createRole({
        companyId: role.companyId,
        name: role.name,
        description: role.description,
        llmConfig: role.llmConfig,
        systemPromptTemplate: role.systemPromptTemplate,
        knowledgeDomains: [],
        mcpServerList: [],
      });

      expect(db.createRole).toHaveBeenCalledTimes(1);
      expect(result.id).toBe(role.id);
    });
  });

  describe('updateRole', () => {
    it('delegates to db.updateRole and returns the updated role', async () => {
      const role = makeRole();
      db.updateRole.mockResolvedValue(role);

      const result = await controller.updateRole(role.id, { name: 'updated' });
      expect(db.updateRole).toHaveBeenCalledWith(role.id, { name: 'updated' });
      expect(result.id).toBe(role.id);
    });

    it('accepts a partial llmConfig patch without the full object', async () => {
      const role = makeRole();
      db.updateRole.mockResolvedValue(role);

      const partial = { llmConfig: { model: 'gpt-4o-mini' } };
      await controller.updateRole(role.id, partial);
      expect(db.updateRole).toHaveBeenCalledWith(role.id, partial);
    });

    it('throws NotFoundException when the role does not exist', async () => {
      db.updateRole.mockResolvedValue(null);
      await expect(
        controller.updateRole(randomUUID(), { name: 'x' }),
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
});
