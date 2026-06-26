import { randomUUID } from 'crypto';
import { InternalController } from './internal.controller';
import { PauseAndResumeService } from './pause-and-resume.service';

describe('InternalController', () => {
  let pauseResume: {
    pauseForUserInput: jest.Mock;
    pauseForConsultation: jest.Mock;
    completeAgent: jest.Mock;
  };
  let controller: InternalController;

  beforeEach(() => {
    pauseResume = {
      pauseForUserInput: jest.fn(),
      pauseForConsultation: jest.fn(),
      completeAgent: jest.fn().mockResolvedValue(undefined),
    };
    controller = new InternalController(
      pauseResume as unknown as PauseAndResumeService,
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
});
