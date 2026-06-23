import { HumanMessage, SystemMessage } from '@langchain/core/messages';

// Mock tiktoken before importing the service
jest.mock('@langchain/core/utils/tiktoken', () => ({
  getEncoding: jest.fn().mockResolvedValue({
    encode: (text: string) => new Uint32Array(Math.ceil(text.length / 4)),
  }),
}));

import { ContextBudgetService } from './context-budget.service';

describe('ContextBudgetService', () => {
  let service: ContextBudgetService;

  beforeEach(() => {
    service = new ContextBudgetService();
  });

  describe('countText', () => {
    it('returns a positive token count for non-empty text', async () => {
      const count = await service.countText('Hello, world!');
      expect(count).toBeGreaterThan(0);
    });

    it('returns 0 for empty text', async () => {
      const count = await service.countText('');
      expect(count).toBe(0);
    });
  });

  describe('countMessages', () => {
    it('sums tokens across all messages', async () => {
      const msgs = [
        new SystemMessage('You are an analyst.'),
        new HumanMessage('Tell me about Q3 results.'),
      ];
      const total = await service.countMessages(msgs);
      expect(total).toBeGreaterThan(0);
    });

    it('returns 0 for an empty array', async () => {
      expect(await service.countMessages([])).toBe(0);
    });
  });

  describe('isOverBudget', () => {
    it('returns false below the trigger threshold (79%)', () => {
      expect(service.isOverBudget(790, 1000)).toBe(false);
    });

    it('returns false at exactly the trigger threshold (80%)', () => {
      expect(service.isOverBudget(800, 1000)).toBe(false);
    });

    it('returns true above the trigger threshold (81%)', () => {
      expect(service.isOverBudget(810, 1000)).toBe(true);
    });
  });

  describe('isAtTarget', () => {
    it('returns true at exactly the target threshold (60%)', () => {
      expect(service.isAtTarget(600, 1000)).toBe(true);
    });

    it('returns true below the target threshold (59%)', () => {
      expect(service.isAtTarget(590, 1000)).toBe(true);
    });

    it('returns false above the target threshold (61%)', () => {
      expect(service.isAtTarget(610, 1000)).toBe(false);
    });
  });

  describe('pct', () => {
    it('calculates percentage to one decimal place', () => {
      expect(service.pct(500, 1000)).toBe(50);
      expect(service.pct(333, 1000)).toBe(33.3);
    });
  });
});
