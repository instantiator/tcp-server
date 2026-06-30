import { AIMessage } from '@langchain/core/messages';
import { Logger } from '@nestjs/common';
import { ReasoningContentRecovery } from './reasoning-content-recovery';

describe('ReasoningContentRecovery', () => {
  it('leaves the message unchanged when content is already present', () => {
    const message = new AIMessage('Here is my answer.');
    const result = ReasoningContentRecovery.recover(message);
    expect(result.content).toBe('Here is my answer.');
  });

  it('recovers content from reasoning_content when content is blank', () => {
    const message = new AIMessage({
      content: '',
      additional_kwargs: { reasoning_content: 'The actual answer.' },
    });
    const result = ReasoningContentRecovery.recover(message);
    expect(result.content).toBe('The actual answer.');
  });

  it('treats whitespace-only content as blank', () => {
    const message = new AIMessage({
      content: '   \n  ',
      additional_kwargs: { reasoning_content: 'Recovered answer.' },
    });
    const result = ReasoningContentRecovery.recover(message);
    expect(result.content).toBe('Recovered answer.');
  });

  it('leaves the message unchanged when both content and reasoning_content are blank', () => {
    const message = new AIMessage({
      content: '',
      additional_kwargs: { reasoning_content: '   ' },
    });
    const result = ReasoningContentRecovery.recover(message);
    expect(result.content).toBe('');
  });

  it('leaves the message unchanged when reasoning_content is absent', () => {
    const message = new AIMessage('');
    const result = ReasoningContentRecovery.recover(message);
    expect(result.content).toBe('');
  });

  it('logs a warning naming the model when recovery happens', () => {
    const logger = { warn: jest.fn() } as unknown as Logger;
    const message = new AIMessage({
      content: '',
      additional_kwargs: { reasoning_content: 'Recovered.' },
      response_metadata: { model_name: 'qwen/qwen3.5-9b' },
    });

    ReasoningContentRecovery.recover(message, logger);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('qwen/qwen3.5-9b'),
    );
  });

  it('does not throw when no logger is provided', () => {
    const message = new AIMessage({
      content: '',
      additional_kwargs: { reasoning_content: 'Recovered.' },
    });
    expect(() => ReasoningContentRecovery.recover(message)).not.toThrow();
  });
});
