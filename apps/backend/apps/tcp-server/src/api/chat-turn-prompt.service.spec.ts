import { ConfigService } from '@nestjs/config';
import {
  ContextManagerService,
  KnowledgeRetrievalService,
  MEMORY_INTRO,
} from '@tcp/shared';
import { PromptInputs, TurnContext } from './chat-turn-prompt.service';
import { ChatTurnPromptService } from './chat-turn-prompt.service';

const EMBEDDING = { provider: 'lm-studio', model: 'nomic-embed-text' };

function makeCtx(isFirstMessage: boolean): TurnContext {
  const role = { id: 'role-1', companyId: 'company-1', rolePrompt: null };
  const company = { id: 'company-1', slug: 'acme', embeddingConfig: EMBEDDING };
  return {
    agent: {
      id: 'agent-1',
      assignment: { mode: 'chat', materials: [], expected: [] },
    },
    role,
    company,
    llmConfig: { provider: 'lm-studio', model: 'm' },
    windowSize: 32000,
    isFirstMessage,
    message: 'hello',
  } as unknown as TurnContext;
}

function makeInputs(...serverNames: string[]): PromptInputs {
  return {
    preparedMessage: 'We now invoice monthly',
    model: {},
    mcpTools: serverNames.map((serverName) => ({ serverName })),
    mcpServerUrls: {},
  } as unknown as PromptInputs;
}

function makeService() {
  const retrieval = {
    retrieve: jest.fn().mockResolvedValue([]),
    retrieveMemories: jest
      .fn()
      .mockResolvedValue([{ id: 'mem-1', content: 'Invoices go out weekly' }]),
  } as unknown as jest.Mocked<KnowledgeRetrievalService>;
  const config = {
    get: jest.fn().mockReturnValue(undefined),
  } as unknown as ConfigService;
  const service = new ChatTurnPromptService(
    config,
    {} as unknown as ContextManagerService,
    retrieval,
  );
  return { service, retrieval };
}

const contents = (messages: { content: unknown }[]) =>
  messages.map((m) => String(m.content));

describe('ChatTurnPromptService memories', () => {
  it('recalls memories for the user message on the first turn, after the RAG slot', async () => {
    const { service, retrieval } = makeService();

    const messages = await service.build(makeCtx(true), makeInputs('memory'));

    expect(retrieval.retrieveMemories).toHaveBeenCalledWith(
      'role-1',
      'company-1',
      'We now invoice monthly',
      EMBEDDING,
      3,
      expect.any(Number),
    );
    const text = contents(messages);
    expect(text).toContainEqual(
      expect.stringContaining('Invoices go out weekly (memory mem-1)'),
    );
    expect(text.findIndex((t) => t.startsWith(MEMORY_INTRO))).toBe(
      text.length - 2,
    );
  });

  it('recalls memories again on a later turn, ahead of the user message', async () => {
    const { service, retrieval } = makeService();

    const messages = await service.build(makeCtx(false), makeInputs('memory'));

    expect(retrieval.retrieveMemories).toHaveBeenCalledTimes(1);
    expect(contents(messages)).toEqual([
      expect.stringContaining(MEMORY_INTRO),
      'We now invoice monthly',
    ]);
  });

  it.each([true, false])(
    'recalls nothing when the memory server is not loaded (first turn: %s)',
    async (isFirstMessage) => {
      const { service, retrieval } = makeService();

      const messages = await service.build(
        makeCtx(isFirstMessage),
        makeInputs('storage'),
      );

      expect(retrieval.retrieveMemories).not.toHaveBeenCalled();
      expect(contents(messages)).not.toContainEqual(
        expect.stringContaining(MEMORY_INTRO),
      );
    },
  );
});
