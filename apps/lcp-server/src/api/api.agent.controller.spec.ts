import { BadRequestException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AgentStatus, LcpAgent } from '@lcp/shared';
import { AgentController } from './api.agent.controller';
import { AgentOrchestrationService } from './agent-orchestration.service';
import { DbService } from '../db/db.service';

function makeAgent(overrides: Partial<LcpAgent> = {}): LcpAgent {
  return {
    id: randomUUID(),
    companyId: randomUUID(),
    roleId: randomUUID(),
    status: AgentStatus.Idle,
    threadId: null,
    initialPrompt: 'Do something.',
    createdAt: new Date(),
    updatedAt: new Date(),
    company: {} as never,
    role: {} as never,
    ...overrides,
  };
}

describe('AgentController', () => {
  let db: jest.Mocked<Pick<DbService, 'getAgent'>>;
  let orchestration: jest.Mocked<
    Pick<AgentOrchestrationService, 'startAgent' | 'resumeAgent'>
  >;
  let controller: AgentController;

  beforeEach(() => {
    db = { getAgent: jest.fn() };
    orchestration = {
      startAgent: jest.fn(),
      resumeAgent: jest.fn(),
    };
    controller = new AgentController(
      db as unknown as DbService,
      orchestration as unknown as AgentOrchestrationService,
    );
  });

  describe('startAgent', () => {
    it('delegates to orchestration.startAgent and returns the agent', async () => {
      const agent = makeAgent();
      orchestration.startAgent.mockResolvedValue(agent);

      const result = await controller.startAgent({
        companyId: agent.companyId,
        roleId: agent.roleId,
        initialPrompt: 'Do something.',
      });

      expect(orchestration.startAgent).toHaveBeenCalledTimes(1);
      expect(result.id).toBe(agent.id);
    });

    it('throws BadRequestException when required fields are missing', async () => {
      await expect(
        controller.startAgent({
          companyId: '',
          roleId: randomUUID(),
          initialPrompt: 'Go.',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('resumeAgent', () => {
    it('delegates to orchestration.resumeAgent and returns the agent', async () => {
      const agent = makeAgent();
      orchestration.resumeAgent.mockResolvedValue(agent);

      const result = await controller.resumeAgent(agent.id);
      expect(result.id).toBe(agent.id);
    });

    it('throws NotFoundException when the orchestration service reports agent not found', async () => {
      orchestration.resumeAgent.mockRejectedValue(
        new Error('Agent xyz not found'),
      );
      await expect(controller.resumeAgent('xyz')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws BadRequestException when the agent cannot be resumed', async () => {
      orchestration.resumeAgent.mockRejectedValue(
        new Error("cannot be resumed from status 'running'"),
      );
      await expect(controller.resumeAgent('xyz')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('getAgent', () => {
    it('returns the agent when found', async () => {
      const agent = makeAgent();
      db.getAgent.mockResolvedValue(agent);

      const result = await controller.getAgent(agent.id);
      expect(result.id).toBe(agent.id);
    });

    it('throws NotFoundException when the agent does not exist', async () => {
      db.getAgent.mockResolvedValue(null);
      await expect(controller.getAgent(randomUUID())).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
