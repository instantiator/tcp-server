import { HumanMessage } from '@langchain/core/messages';
import { ConfigService } from '@nestjs/config';
import {
  KnowledgeRetrievalService,
  McpClientService,
  MEMORY_INTRO,
  TcpAgent,
} from '@tcp/shared';
import { Repository } from 'typeorm';
import { InitialStateService } from './initial-state.service';

type LoadedTools = Awaited<ReturnType<McpClientService['loadTools']>>;

const EMBEDDING = { provider: 'lm-studio', model: 'nomic-embed-text' };

const AGENT = {
  id: 'agent-1',
  role: { id: 'role-1', name: 'analyst', rolePrompt: null },
  company: { id: 'company-1', slug: 'acme', embeddingConfig: EMBEDDING },
  assignment: { mode: 'implement', taskId: null, materials: [], expected: [] },
} as unknown as TcpAgent;

/** A loaded tool from each named server — only the server name matters here. */
function toolsFrom(...serverNames: string[]): LoadedTools {
  return serverNames.map((serverName) => ({
    serverName,
  })) as unknown as LoadedTools;
}

function makeService(memories: { id: string; content: string }[]) {
  const knowledge = {
    retrieve: jest.fn().mockResolvedValue([]),
    retrieveMemories: jest.fn().mockResolvedValue(memories),
  } as unknown as jest.Mocked<KnowledgeRetrievalService>;
  const config = {
    get: jest.fn().mockReturnValue(undefined),
  } as unknown as ConfigService;
  const service = new InitialStateService(
    knowledge,
    config,
    {} as unknown as Repository<never>,
    {} as unknown as Repository<never>,
  );
  return { service, knowledge };
}

/** The text of every message in the built opening state. */
async function texts(
  service: InitialStateService,
  serverNames: string[],
  hasKnowledge: boolean,
): Promise<string[]> {
  const state = await service.build(
    AGENT,
    toolsFrom(...serverNames),
    {},
    'Summarise the market.',
    hasKnowledge,
  );
  return state.messages.map((m) => m.text);
}

describe('InitialStateService memories', () => {
  it('injects recalled memories with their ids when memory is loaded, even with no indexed knowledge', async () => {
    const { service, knowledge } = makeService([
      { id: 'mem-1', content: 'Invoices are due in 14 days' },
    ]);

    const messages = await texts(service, ['memory'], false);

    expect(knowledge.retrieveMemories).toHaveBeenCalledWith(
      'role-1',
      'company-1',
      'Summarise the market.',
      EMBEDDING,
      3,
      expect.any(Number),
    );
    expect(knowledge.retrieve).not.toHaveBeenCalled();
    expect(messages).toContainEqual(
      expect.stringContaining('Invoices are due in 14 days (memory mem-1)'),
    );
    expect(messages).toContainEqual(expect.stringContaining(MEMORY_INTRO));
  });

  it('adds no message when nothing is recalled', async () => {
    const { service } = makeService([]);

    const messages = await texts(service, ['memory'], true);

    expect(messages).not.toContainEqual(expect.stringContaining(MEMORY_INTRO));
  });

  it('does not retrieve memories when the memory server is not loaded', async () => {
    const { service, knowledge } = makeService([{ id: 'm', content: 'x' }]);

    const messages = await texts(service, ['storage'], true);

    expect(knowledge.retrieveMemories).not.toHaveBeenCalled();
    expect(messages).not.toContainEqual(expect.stringContaining(MEMORY_INTRO));
  });

  it('places memories after the assignment and before the final instruction', async () => {
    const { service } = makeService([{ id: 'mem-1', content: 'a fact' }]);

    const messages = await texts(service, ['memory'], false);

    const at = messages.findIndex((m) => m.startsWith(MEMORY_INTRO));
    expect(at).toBe(messages.length - 2);
  });
});

// Keeps the HumanMessage import honest: part 6 is a human message like part 5.
describe('memory message type', () => {
  it('is a HumanMessage', async () => {
    const { service } = makeService([{ id: 'm', content: 'x' }]);
    const state = await service.build(
      AGENT,
      toolsFrom('memory'),
      {},
      'p',
      false,
    );
    const memory = state.messages.find((m) => m.text.startsWith(MEMORY_INTRO));
    expect(memory).toBeInstanceOf(HumanMessage);
  });
});
