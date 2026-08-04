import { AuditEventType, Conversation, ConversationMessage } from '@tcp/shared';
import { randomUUID } from 'crypto';
import type { AuditService } from '../audit/audit.service';
import type { AgentOrchestrationService } from './agent-orchestration.service';
import type { ConversationService } from './conversation.service';
import { ConversationController } from './conversation.controller';

/** A closed conversation as `ConversationService.reply` returns one. */
const closedConv = (overrides: Partial<Conversation> = {}): Conversation =>
  ({
    id: randomUUID(),
    slug: 'cto-1',
    companyId: randomUUID(),
    roleName: 'cto',
    question: 'Which vendor?',
    status: 'closed',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    agentId: null,
    ...overrides,
  }) as Conversation;

const makeService = (): jest.Mocked<
  Pick<ConversationService, 'list' | 'get' | 'reply'>
> => ({
  list: jest.fn().mockResolvedValue([]),
  get: jest.fn().mockResolvedValue({ conversation: {}, messages: [] }),
  reply: jest.fn().mockResolvedValue(closedConv()),
});

const makeOrchestration = (): jest.Mocked<
  Pick<AgentOrchestrationService, 'resumeAgent'>
> => ({
  resumeAgent: jest.fn().mockResolvedValue(undefined),
});

const makeAudit = (): jest.Mocked<Pick<AuditService, 'record'>> => ({
  record: jest.fn().mockResolvedValue(undefined),
});

describe('ConversationController', () => {
  let service: ReturnType<typeof makeService>;
  let orchestration: ReturnType<typeof makeOrchestration>;
  let audit: ReturnType<typeof makeAudit>;
  let ctrl: ConversationController;

  beforeEach(() => {
    service = makeService();
    orchestration = makeOrchestration();
    audit = makeAudit();
    ctrl = new ConversationController(
      service as unknown as ConversationService,
      orchestration as unknown as AgentOrchestrationService,
      audit as unknown as AuditService,
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
        companyTimezone: null,
      };
      service.get.mockResolvedValue(expected);

      const result = await ctrl.get('cto-1');
      expect(service.get).toHaveBeenCalledWith('cto-1');
      expect(result).toBe(expected);
    });
  });

  describe('reply', () => {
    it('passes content and authorIdentifier to service.reply', async () => {
      service.reply.mockResolvedValue(closedConv());

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

    it('records the enquiry close on the company stream', async () => {
      const conv = closedConv();
      service.reply.mockResolvedValue(conv);

      await ctrl.reply('cto-1', { content: 'answer' });

      // agentId must be null, or the publisher routes the row to the agent
      // channel instead of the company stream.
      expect(audit.record).toHaveBeenCalledWith(
        conv.companyId,
        'cto',
        null,
        AuditEventType.StateChange,
        {
          entity: 'enquiry',
          newStatus: 'closed',
          reason: 'replied',
          summary: {
            id: conv.id,
            slug: 'cto-1',
            status: 'closed',
            roleName: 'cto',
            question: 'Which vendor?',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        },
      );
    });

    it('resumes the agent when conversation has an agentId', async () => {
      const agentId = randomUUID();
      service.reply.mockResolvedValue(closedConv({ agentId }));

      await ctrl.reply('cto-1', { content: 'The answer.' });

      // No reply content passed — the orchestrator aggregates responses
      // itself from the DB, scoped by the agent's pausedAt.
      expect(orchestration.resumeAgent).toHaveBeenCalledWith(agentId);
    });

    it('does not call resumeAgent when agentId is null', async () => {
      await ctrl.reply('cto-1', { content: 'answer' });

      expect(orchestration.resumeAgent).not.toHaveBeenCalled();
    });

    it('does not throw when resumeAgent fails (logs warning only)', async () => {
      const agentId = randomUUID();
      service.reply.mockResolvedValue(closedConv({ agentId }));
      orchestration.resumeAgent.mockRejectedValue(new Error('Queue down'));

      await expect(
        ctrl.reply('cto-1', { content: 'answer' }),
      ).resolves.not.toThrow();
    });
  });
});
