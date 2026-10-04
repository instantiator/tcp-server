import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';

jest.mock('@langchain/core/utils/tiktoken', () => ({
  getEncoding: jest.fn().mockResolvedValue({
    encode: (text: string) => new Uint32Array(Math.ceil(text.length / 4)),
  }),
}));

// trimMessages returns messages up to the token budget from the end
jest.mock('@langchain/core/messages', () => {
  const actual = jest.requireActual<typeof import('@langchain/core/messages')>(
    '@langchain/core/messages',
  );
  return {
    ...actual,
    trimMessages: jest.fn(),
  };
});

import { trimMessages } from '@langchain/core/messages';
import { ContextBudgetService } from './context-budget.service';
import { ContextCompactorService } from './context-compactor.service';

function makeBudget(): ContextBudgetService {
  return new ContextBudgetService();
}

describe('ContextCompactorService', () => {
  let budget: ContextBudgetService;
  let service: ContextCompactorService;

  beforeEach(() => {
    budget = makeBudget();
    service = new ContextCompactorService(budget);
    jest.clearAllMocks();
  });

  describe('trimHistory', () => {
    it('returns trimmed messages and IDs of removed ones', async () => {
      const system = new SystemMessage({
        content: 'You are an analyst.',
        id: 'sys-1',
      });
      const human1 = new HumanMessage({ content: 'First message', id: 'h-1' });
      const human2 = new HumanMessage({ content: 'Second message', id: 'h-2' });
      const all = [system, human1, human2];

      // Simulate trimMessages dropping human1 (keeping system + human2)
      (trimMessages as jest.Mock).mockResolvedValue([system, human2]);

      const result = await service.trimHistory(all, 500);

      expect(result.trimmed).toEqual([system, human2]);
      expect(result.removedIds).toEqual(['h-1']);
      expect(result.activity).toMatch(/Trimmed history from 3 to 2 messages/);
    });

    it('returns all messages unchanged when nothing needs trimming', async () => {
      const msgs = [new HumanMessage({ content: 'Short', id: 'h-1' })];
      (trimMessages as jest.Mock).mockResolvedValue(msgs);

      const result = await service.trimHistory(msgs, 5000);

      expect(result.removedIds).toHaveLength(0);
      expect(result.trimmed).toHaveLength(1);
    });
  });

  describe('buildRemoveMessages', () => {
    it('creates a RemoveMessage for each ID', () => {
      const removes = service.buildRemoveMessages(['id-1', 'id-2']);
      expect(removes).toHaveLength(2);
      expect(removes[0].id).toBe('id-1');
      expect(removes[1].id).toBe('id-2');
    });

    it('returns empty array for empty input', () => {
      expect(service.buildRemoveMessages([])).toHaveLength(0);
    });
  });

  describe('summariseMessage', () => {
    it('returns a message with summarised content', async () => {
      const model = {
        invoke: jest
          .fn()
          .mockResolvedValue(new AIMessage('Summary bullet points.')),
      };
      const original = new HumanMessage({
        content: 'A very long message.',
        id: 'h-1',
      });

      const result = await service.summariseMessage(original, model as never);

      expect(model.invoke).toHaveBeenCalledTimes(1);
      expect(result.content).toContain('Summary bullet points.');
    });

    it('returns the original message when the LLM call fails', async () => {
      const model = {
        invoke: jest.fn().mockRejectedValue(new Error('LLM error')),
      };
      const original = new HumanMessage({ content: 'Original.', id: 'h-1' });

      const result = await service.summariseMessage(original, model as never);

      expect(result).toBe(original);
    });

    it('reports usage when both an llm identity and onUsage are given and the provider reported usage', async () => {
      const reply = new AIMessage('Summary.');
      Object.assign(reply, {
        usage_metadata: { input_tokens: 20, output_tokens: 6 },
      });
      const model = { invoke: jest.fn().mockResolvedValue(reply) };
      const original = new HumanMessage({ content: 'Long.', id: 'h-1' });
      const onUsage = jest.fn();

      await service.summariseMessage(
        original,
        model as never,
        { provider: 'lm-studio', model: 'qwen3-5b' },
        onUsage,
      );

      expect(onUsage).toHaveBeenCalledWith({
        provider: 'lm-studio',
        model: 'qwen3-5b',
        inputTokens: 20,
        outputTokens: 6,
      });
    });

    it('does not report usage when no llm identity is given', async () => {
      const reply = new AIMessage('Summary.');
      Object.assign(reply, {
        usage_metadata: { input_tokens: 20, output_tokens: 6 },
      });
      const model = { invoke: jest.fn().mockResolvedValue(reply) };
      const original = new HumanMessage({ content: 'Long.', id: 'h-1' });
      const onUsage = jest.fn();

      await service.summariseMessage(
        original,
        model as never,
        undefined,
        onUsage,
      );

      expect(onUsage).not.toHaveBeenCalled();
    });
  });

  describe('compactSection', () => {
    it('returns compacted text from the LLM', async () => {
      const model = {
        invoke: jest
          .fn()
          .mockResolvedValue(new AIMessage('• Key point A\n• Key point B')),
      };

      const result = await service.compactSection(
        'Long section text',
        'role',
        model as never,
      );
      expect(result).toBe('• Key point A\n• Key point B');
    });

    it('falls back to original content on LLM error', async () => {
      const model = {
        invoke: jest.fn().mockRejectedValue(new Error('fail')),
      };

      const result = await service.compactSection(
        'Original content',
        'role',
        model as never,
      );
      expect(result).toBe('Original content');
    });
  });
});
