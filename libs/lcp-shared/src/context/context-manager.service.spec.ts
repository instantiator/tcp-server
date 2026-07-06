import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, RemoveMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { AuditEventType } from '../models/AuditEvent.model';
import type { LcpAgent } from '../models/LcpAgent.model';
import type { LcpRole } from '../models/LcpRole.model';
import { ContextBudgetService } from './context-budget.service';
import { ContextCompactorService } from './context-compactor.service';
import {
  ContextAuditSink,
  ContextEventSink,
  ContextManagerService,
} from './context-manager.service';
import { IncomingDataGuardService } from './incoming-data-guard.service';

// tiktoken is loaded by ContextBudgetService; mock it so tests are fast
jest.mock('@langchain/core/utils/tiktoken', () => ({
  getEncoding: jest.fn().mockResolvedValue({
    encode: (text: string) => new Uint32Array(Math.ceil(text.length / 4)),
  }),
}));

function makeGraph(messages: unknown[] = []) {
  return {
    getState: jest.fn().mockResolvedValue({ values: { messages } }),
    updateState: jest.fn().mockResolvedValue({} as RunnableConfig),
  };
}

function makeAgent(): LcpAgent {
  return { id: randomUUID(), companyId: randomUUID() } as LcpAgent;
}

function makeRole(): LcpRole {
  return { name: 'analyst' } as LcpRole;
}

// Use a small window so the 10k-char test messages (≈2500 tokens) exceed the 80% threshold
const WINDOW = 2000;

describe('ContextManagerService', () => {
  let budget: ContextBudgetService;
  let compactor: jest.Mocked<ContextCompactorService>;
  let guard: jest.Mocked<IncomingDataGuardService>;
  let events: jest.Mocked<ContextEventSink>;
  let auditSink: jest.Mocked<ContextAuditSink>;
  let service: ContextManagerService;

  beforeEach(() => {
    budget = new ContextBudgetService();
    compactor = {
      trimHistory: jest
        .fn()
        .mockResolvedValue({ removedIds: [], activity: '' }),
      buildRemoveMessages: jest.fn().mockReturnValue([]),
      summariseMessage: jest
        .fn()
        .mockResolvedValue(new HumanMessage('summary')),
    } as unknown as jest.Mocked<ContextCompactorService>;
    guard = {
      check: jest
        .fn()
        .mockImplementation((text: string) =>
          Promise.resolve({ text, compacted: false, activity: null }),
        ),
    } as unknown as jest.Mocked<IncomingDataGuardService>;
    events = { emit: jest.fn() };
    auditSink = { record: jest.fn().mockResolvedValue(undefined) };
    service = new ContextManagerService(
      budget,
      compactor,
      guard,
      events,
      auditSink,
    );
  });

  describe('prepare — first message', () => {
    it('returns the guarded message text without loading checkpoint', async () => {
      const graph = makeGraph();
      const result = await service.prepare(
        'agent-1',
        'Hello',
        {} as BaseChatModel,
        WINDOW,
        graph,
        {},
        true,
        makeAgent(),
        makeRole(),
      );
      expect(result.message).toBe('Hello');
      expect(graph.getState).not.toHaveBeenCalled();
    });

    it('returns null report when no compaction was needed', async () => {
      const result = await service.prepare(
        'agent-1',
        'Hello',
        {} as BaseChatModel,
        WINDOW,
        makeGraph(),
        {},
        true,
        makeAgent(),
        makeRole(),
      );
      expect(result.report).toBeNull();
    });

    it('returns a report when the incoming-data guard compacts the message', async () => {
      guard.check.mockResolvedValue({
        text: 'compacted',
        compacted: true,
        activity: 'Compacted 100 chars',
      });
      const result = await service.prepare(
        'agent-1',
        'very long message',
        {} as BaseChatModel,
        WINDOW,
        makeGraph(),
        {},
        true,
        makeAgent(),
        makeRole(),
      );
      expect(result.message).toBe('compacted');
      expect(result.report).not.toBeNull();
      expect(result.report?.strategies).toContain('compact_incoming');
    });
  });

  describe('prepare — subsequent messages, within budget', () => {
    it('returns message without triggering compaction when under budget', async () => {
      // Empty checkpoint — 0 tokens used, well within WINDOW=4000
      const graph = makeGraph([]);
      const result = await service.prepare(
        'agent-1',
        'Short message',
        {} as BaseChatModel,
        WINDOW,
        graph,
        {},
        false,
        makeAgent(),
        makeRole(),
      );
      expect(result.message).toBe('Short message');
      expect(compactor.trimHistory).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('counts bound-tools schema overhead toward the budget, triggering compaction a bound-tools-unaware check would miss', async () => {
      // A handful of tools with sizeable descriptions/schemas push the total
      // over budget even though the checkpoint alone would not.
      const makeTool = (n: number) =>
        new DynamicStructuredTool({
          name: `server__tool_${n}`,
          description: 'x'.repeat(400),
          schema: z.object({ path: z.string(), content: z.string() }),
          func: () => Promise.resolve(''),
        });
      const tools = Array.from({ length: 20 }, (_, i) => makeTool(i));
      const graph = makeGraph([]);
      compactor.trimHistory.mockResolvedValue({
        trimmed: [],
        removedIds: [],
        activity: 'Trimmed',
      });

      await service.prepare(
        'agent-1',
        'Short message',
        {} as BaseChatModel,
        WINDOW,
        graph,
        {},
        false,
        makeAgent(),
        makeRole(),
        tools,
      );

      expect(events.emit).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({ kind: 'compaction_started' }),
      );
    });
  });

  describe('prepare — over budget, triggers Tier-1 compaction', () => {
    it('emits compaction_started and compaction_complete SSE events', async () => {
      // Checkpoint with enough messages to push tokens over 80% of WINDOW
      const bigMsg = new HumanMessage('x'.repeat(10000));
      const graph = makeGraph([bigMsg]);
      compactor.trimHistory.mockResolvedValue({
        trimmed: [],
        removedIds: ['msg-1'],
        activity: 'Trimmed 1 message',
      });
      compactor.buildRemoveMessages.mockReturnValue([]);

      await service.prepare(
        'agent-1',
        'new message',
        {} as BaseChatModel,
        WINDOW,
        graph,
        {},
        false,
        makeAgent(),
        makeRole(),
      );

      expect(events.emit).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({ kind: 'compaction_started' }),
      );
      expect(events.emit).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({ kind: 'compaction_complete' }),
      );
    });

    it('records a Decision audit event before compaction', async () => {
      const bigMsg = new HumanMessage('x'.repeat(10000));
      const agent = makeAgent();
      const role = makeRole();
      const graph = makeGraph([bigMsg]);
      compactor.trimHistory.mockResolvedValue({
        trimmed: [],
        removedIds: ['msg-1'],
        activity: 'Trimmed',
      });
      compactor.buildRemoveMessages.mockReturnValue([]);

      await service.prepare(
        agent.id,
        'next',
        {} as BaseChatModel,
        WINDOW,
        graph,
        {},
        false,
        agent,
        role,
      );

      expect(auditSink.record).toHaveBeenCalledWith(
        agent.companyId,
        role.name,
        agent.id,
        AuditEventType.Decision,
        expect.objectContaining({ event: 'compaction_triggered' }),
      );
    });

    it('calls graph.updateState with remove markers when trimHistory returns removedIds', async () => {
      const bigMsg = new HumanMessage({
        content: 'x'.repeat(10000),
        id: 'msg-1',
      });
      const graph = makeGraph([bigMsg]);
      compactor.trimHistory.mockResolvedValue({
        trimmed: [],
        removedIds: ['msg-1'],
        activity: 'Trimmed',
      });
      const removeMarker = new RemoveMessage({ id: 'msg-1' });
      compactor.buildRemoveMessages.mockReturnValue([removeMarker]);

      await service.prepare(
        'a1',
        'hi',
        {} as BaseChatModel,
        WINDOW,
        graph,
        {},
        false,
        makeAgent(),
        makeRole(),
      );

      expect(graph.updateState).toHaveBeenCalledWith(
        {},
        { messages: [removeMarker] },
      );
    });

    it('returns a report with strategies listing trim_messages', async () => {
      const bigMsg = new HumanMessage('x'.repeat(10000));
      const graph = makeGraph([bigMsg]);
      compactor.trimHistory.mockResolvedValue({
        trimmed: [],
        removedIds: ['msg-1'],
        activity: 'Trimmed',
      });
      compactor.buildRemoveMessages.mockReturnValue([]);

      const result = await service.prepare(
        'a1',
        'hi',
        {} as BaseChatModel,
        WINDOW,
        graph,
        {},
        false,
        makeAgent(),
        makeRole(),
      );

      expect(result.report?.strategies).toContain('trim_messages');
    });
  });

  describe('checkBudget', () => {
    it('reports not over budget and no report when the checkpoint fits', async () => {
      const graph = makeGraph([]);
      const result = await service.checkBudget(
        'agent-1',
        {} as BaseChatModel,
        WINDOW,
        graph,
        {},
        makeAgent(),
        makeRole(),
      );
      expect(result.stillOverBudget).toBe(false);
      expect(result.report).toBeNull();
    });

    it('compacts and reports not-still-over-budget when Tier-1 trim succeeds', async () => {
      const bigMsg = new HumanMessage('x'.repeat(10000));
      const graph = makeGraph([bigMsg]);
      compactor.trimHistory.mockResolvedValue({
        trimmed: [],
        removedIds: ['msg-1'],
        activity: 'Trimmed',
      });
      compactor.buildRemoveMessages.mockReturnValue([]);

      const result = await service.checkBudget(
        'agent-1',
        {} as BaseChatModel,
        WINDOW,
        graph,
        {},
        makeAgent(),
        makeRole(),
      );

      expect(result.report).not.toBeNull();
      // Trimming didn't actually shrink the mocked checkpoint (trimHistory's
      // effect on the underlying messages is itself mocked out), so this
      // fixture's tokensAfter remains over budget — proving the signal
      // reflects the real post-compaction state, not just "compaction ran".
      expect(result.stillOverBudget).toBe(true);
    });

    it('reports stillOverBudget=false once the compacted checkpoint fits', async () => {
      // Stateful checkpoint: updateState (Tier-1 trim applied) empties the
      // messages array, and getState always reflects the current value —
      // simulating a real checkpoint shrinking after a trim.
      let currentMessages: unknown[] = [new HumanMessage('x'.repeat(10000))];
      const graph = {
        getState: jest
          .fn()
          .mockImplementation(() =>
            Promise.resolve({ values: { messages: currentMessages } }),
          ),
        updateState: jest.fn().mockImplementation(() => {
          currentMessages = [];
          return Promise.resolve({});
        }),
      };
      compactor.trimHistory.mockResolvedValue({
        trimmed: [],
        removedIds: ['msg-1'],
        activity: 'Trimmed',
      });
      compactor.buildRemoveMessages.mockReturnValue([]);

      const result = await service.checkBudget(
        'agent-1',
        {} as BaseChatModel,
        WINDOW,
        graph,
        {},
        makeAgent(),
        makeRole(),
      );

      expect(result.stillOverBudget).toBe(false);
    });
  });

  describe('guardSection', () => {
    it('delegates to the incoming-data guard and returns the (possibly compacted) text', async () => {
      guard.check.mockResolvedValue({
        text: 'guarded',
        compacted: false,
        activity: undefined,
      });
      const out = await service.guardSection(
        'input',
        {} as BaseChatModel,
        WINDOW,
      );
      expect(out).toBe('guarded');
      expect(guard.check).toHaveBeenCalledWith(
        'input',
        0,
        WINDOW,
        {},
        undefined,
      );
    });

    it('passes the overflowPath through to the guard', async () => {
      guard.check.mockResolvedValue({
        text: 'x',
        compacted: false,
        activity: undefined,
      });
      await service.guardSection(
        'big text',
        {} as BaseChatModel,
        WINDOW,
        'acme/overflow',
      );
      expect(guard.check).toHaveBeenCalledWith(
        'big text',
        0,
        WINDOW,
        {},
        'acme/overflow',
      );
    });
  });
});
