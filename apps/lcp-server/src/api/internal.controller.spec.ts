import { NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { LcpAgent } from '@lcp/shared';
import { InternalController } from './internal.controller';
import { PauseAndResumeService } from './pause-and-resume.service';

describe('InternalController', () => {
  let pauseResume: {
    pauseForUserInput: jest.Mock;
    pauseForConsultation: jest.Mock;
    completeAgent: jest.Mock;
    updateStorageChanges: jest.Mock;
  };
  let agentRepo: { findOneBy: jest.Mock };
  let controller: InternalController;

  beforeEach(() => {
    pauseResume = {
      pauseForUserInput: jest.fn(),
      pauseForConsultation: jest.fn(),
      completeAgent: jest.fn().mockResolvedValue(undefined),
      updateStorageChanges: jest.fn().mockResolvedValue(undefined),
    };
    agentRepo = { findOneBy: jest.fn() };
    controller = new InternalController(
      pauseResume as unknown as PauseAndResumeService,
      agentRepo as unknown as Repository<LcpAgent>,
    );
  });

  describe('pause — user_input', () => {
    it('delegates to pauseForUserInput and returns slug', async () => {
      const agentId = randomUUID();
      pauseResume.pauseForUserInput.mockResolvedValue({ slug: 'analyst-3' });

      const result = await controller.pause({
        type: 'user_input',
        agentId,
        question: 'What should we do?',
        context: 'Background info.',
      });

      expect(pauseResume.pauseForUserInput).toHaveBeenCalledWith(
        agentId,
        'What should we do?',
        'Background info.',
      );
      expect(result).toEqual({ slug: 'analyst-3' });
    });
  });

  describe('pause — agent_consultation', () => {
    it('delegates to pauseForConsultation and returns consultationId', async () => {
      const agentId = randomUUID();
      const companyId = randomUUID();
      const consultationId = randomUUID();
      pauseResume.pauseForConsultation.mockResolvedValue({ consultationId });

      const result = await controller.pause({
        type: 'agent_consultation',
        agentId,
        companyId,
        roleName: 'legal-advisor',
        question: 'Is this compliant?',
      });

      expect(pauseResume.pauseForConsultation).toHaveBeenCalledWith(
        agentId,
        companyId,
        'legal-advisor',
        'Is this compliant?',
        undefined,
      );
      expect(result).toEqual({ consultationId });
    });
  });

  describe('complete', () => {
    it('delegates to completeAgent and returns void', async () => {
      const agentId = randomUUID();

      await controller.complete(agentId, { output: 'My final answer.' });

      expect(pauseResume.completeAgent).toHaveBeenCalledWith(
        agentId,
        'My final answer.',
      );
    });
  });

  describe('getAgent', () => {
    it('returns id and storageChanges when agent exists', async () => {
      const agentId = randomUUID();
      agentRepo.findOneBy.mockResolvedValue({
        id: agentId,
        storageChanges: {
          created: ['docs/report.md'],
          modified: [],
          deleted: [],
          moved: [],
        },
      });

      const result = await controller.getAgent(agentId);

      expect(result).toEqual({
        id: agentId,
        storageChanges: {
          created: ['docs/report.md'],
          modified: [],
          deleted: [],
          moved: [],
        },
      });
    });

    it('throws NotFoundException when agent does not exist', async () => {
      agentRepo.findOneBy.mockResolvedValue(null);
      await expect(controller.getAgent(randomUUID())).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updateStorage', () => {
    it('delegates to updateStorageChanges and returns void', async () => {
      const agentId = randomUUID();

      await controller.updateStorage(agentId, { created: ['docs/out.md'] });

      expect(pauseResume.updateStorageChanges).toHaveBeenCalledWith(agentId, {
        created: ['docs/out.md'],
      });
    });
  });
});
