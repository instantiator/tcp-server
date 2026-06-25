import { Conversation, ConversationMessage } from '@lcp/shared';
import { randomUUID } from 'crypto';
import type { ConversationService } from './conversation.service';
import { ConversationController } from './conversation.controller';

const makeService = (): jest.Mocked<
  Pick<ConversationService, 'list' | 'get' | 'reply'>
> => ({
  list: jest.fn().mockResolvedValue([]),
  get: jest.fn().mockResolvedValue({ conversation: {}, messages: [] }),
  reply: jest.fn().mockResolvedValue({}),
});

describe('ConversationController', () => {
  let service: ReturnType<typeof makeService>;
  let ctrl: ConversationController;

  beforeEach(() => {
    service = makeService();
    ctrl = new ConversationController(
      service as unknown as ConversationService,
    );
  });

  describe('list', () => {
    it('delegates to service.list with optional filters', async () => {
      const companyId = randomUUID();
      await ctrl.list(companyId, 'awaiting_user');
      expect(service.list).toHaveBeenCalledWith(companyId, 'awaiting_user');
    });

    it('delegates without filters when none provided', async () => {
      await ctrl.list();
      expect(service.list).toHaveBeenCalledWith(undefined, undefined);
    });
  });

  describe('get', () => {
    it('delegates to service.get with the slug', async () => {
      const expected = {
        conversation: { slug: 'cto-1' } as Conversation,
        messages: [] as ConversationMessage[],
      };
      service.get.mockResolvedValue(expected);

      const result = await ctrl.get('cto-1');
      expect(service.get).toHaveBeenCalledWith('cto-1');
      expect(result).toBe(expected);
    });
  });

  describe('reply', () => {
    it('passes content and authorIdentifier to service.reply', async () => {
      await ctrl.reply('cto-1', {
        content: 'Here is my answer.',
        authorIdentifier: 'alice@example.com',
      });
      expect(service.reply).toHaveBeenCalledWith(
        'cto-1',
        'Here is my answer.',
        'alice@example.com',
      );
    });

    it('omits authorIdentifier when not provided', async () => {
      await ctrl.reply('cto-1', { content: 'answer' });
      expect(service.reply).toHaveBeenCalledWith('cto-1', 'answer', undefined);
    });
  });
});
