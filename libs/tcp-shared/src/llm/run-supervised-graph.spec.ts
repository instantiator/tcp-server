import type { BaseMessage } from '@langchain/core/messages';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ChatResult } from '@langchain/core/outputs';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { buildAgentGraph } from './build-agent-graph';
import {
  runSupervisedGraph,
  SupervisedGraphHooks,
} from './run-supervised-graph';
import { AgentStatus } from '../models/TcpAgent.model';
import type { TcpAgent } from '../models/TcpAgent.model';
import type { TcpRole } from '../models/TcpRole.model';
import type { ContextManagerService } from '../context/context-manager.service';

const RUN_CONFIG = { configurable: { thread_id: randomUUID() } };

function makeTool(name = 'some_tool'): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name,
    description: 'A test tool.',
    schema: z.object({}),
    func: () => Promise.resolve('tool result'),
  });
}

/**
 * A genuine `BaseChatModel` Runnable (unlike a plain mock object) that
 * advances through a queue of responses, throwing when given an `Error`.
 * Being a real Runnable is essential here — LangChain's `on_chat_model_*`
 * tracing (which `runSupervisedGraph` relies on to capture the final
 * message) only fires for real Runnable invocations, not plain function calls.
 */
class QueuedChatModel extends BaseChatModel {
  invokeCount = 0;
  private i = 0;
  private readonly queue: (AIMessage | Error)[];

  constructor(queue: (AIMessage | Error)[]) {
    super({});
    this.queue = queue;
  }

  _llmType(): string {
    return 'queued-fake';
  }

  bindTools(): BaseChatModel {
    return this;
  }

  _generate(messages: BaseMessage[]): Promise<ChatResult> {
    void messages;
    this.invokeCount++;
    const next = this.queue[this.i];
    this.i++;
    if (next instanceof Error) return Promise.reject(next);
    const message = next ?? new AIMessage('(queue exhausted)');
    return Promise.resolve({
      generations: [
        {
          message,
          text: typeof message.content === 'string' ? message.content : '',
        },
      ],
    });
  }
}

function makeContextManager(
  checkBudgetImpl?: () => Promise<{ report: null; stillOverBudget: boolean }>,
): jest.Mocked<ContextManagerService> {
  return {
    checkBudget: jest
      .fn()
      .mockImplementation(
        checkBudgetImpl ??
          (() => Promise.resolve({ report: null, stillOverBudget: false })),
      ),
  } as unknown as jest.Mocked<ContextManagerService>;
}

function makeAgent(): TcpAgent {
  return { id: randomUUID(), companyId: randomUUID() } as TcpAgent;
}

function makeRole(): TcpRole {
  return { name: 'analyst' } as TcpRole;
}

function toolCall(name: string): AIMessage {
  return new AIMessage({
    content: '',
    tool_calls: [{ name, args: {}, id: randomUUID() }],
  });
}

describe('runSupervisedGraph', () => {
  it('runs a tool call then a final answer to completion, returning the last AI message', async () => {
    const model = new QueuedChatModel([
      toolCall('some_tool'),
      new AIMessage('Final answer.'),
    ]);
    const tools = [makeTool()];
    const checkTerminalStatus = jest.fn().mockResolvedValue(null);
    const onEvent = jest.fn();
    const checkpointer = new MemorySaver();

    const hooks: SupervisedGraphHooks = {
      buildGraph: (t) =>
        buildAgentGraph({
          model,
          checkpointer,
          tools: t,
          interruptAfterTools: true,
        }),
      onEvent,
      checkTerminalStatus,
    };

    const result = await runSupervisedGraph({
      agentId: 'agent-1',
      agent: makeAgent(),
      role: makeRole(),
      model,
      allTools: tools,
      initialGraph: hooks.buildGraph(tools),
      input: { messages: [new HumanMessage('Hi')] },
      config: RUN_CONFIG,
      contextManager: makeContextManager(),
      windowSize: 8192,
      abortController: new AbortController(),
      hooks,
    });

    expect(model.invokeCount).toBe(2);
    expect(result.lastAiMessage?.content).toBe('Final answer.');
    expect(result.terminalStatus).toBeNull();
    expect(result.aborted).toBe(false);
    // Once between the two iterations (after the tool-call interrupt), and
    // once more at natural end — matching the pre-refactor behaviour of
    // checking after every tool result plus once, unconditionally, at the
    // very end of the turn.
    expect(checkTerminalStatus).toHaveBeenCalledTimes(2);
    // Every stream event (on_chat_model_start/end, on_tool_start/end) forwarded
    const forwardedKinds = (onEvent.mock.calls as [{ event: string }][]).map(
      ([e]) => e.event,
    );
    expect(forwardedKinds).toContain('on_chat_model_start');
    expect(forwardedKinds).toContain('on_chat_model_end');
    expect(forwardedKinds).toContain('on_tool_start');
    expect(forwardedKinds).toContain('on_tool_end');
  });

  it('stops immediately when a tool call moves the agent to a terminal status — no further model call', async () => {
    const model = new QueuedChatModel([
      toolCall('some_tool'),
      new AIMessage('This must never be reached.'),
    ]);
    const tools = [makeTool()];
    const checkTerminalStatus = jest.fn().mockResolvedValue(AgentStatus.Paused);
    const checkpointer = new MemorySaver();

    const hooks: SupervisedGraphHooks = {
      buildGraph: (t) =>
        buildAgentGraph({
          model,
          checkpointer,
          tools: t,
          interruptAfterTools: true,
        }),
      onEvent: jest.fn(),
      checkTerminalStatus,
    };

    const result = await runSupervisedGraph({
      agentId: 'agent-1',
      agent: makeAgent(),
      role: makeRole(),
      model,
      allTools: tools,
      initialGraph: hooks.buildGraph(tools),
      input: { messages: [new HumanMessage('Hi')] },
      config: RUN_CONFIG,
      contextManager: makeContextManager(),
      windowSize: 8192,
      abortController: new AbortController(),
      hooks,
    });

    // This is the regression test for the original bug: once Paused/Completed
    // is detected after a tool call, the model must never be invoked again.
    expect(model.invokeCount).toBe(1);
    expect(result.terminalStatus).toBe(AgentStatus.Paused);
    expect(result.aborted).toBe(false);
  });

  describe('when a spend cap holds spending back', () => {
    /** Runs a two-call conversation (a tool call, then an answer) under `holdSpending`. */
    async function runHeldBack(holdSpending: jest.Mock<Promise<boolean>, []>) {
      const model = new QueuedChatModel([
        toolCall('some_tool'),
        new AIMessage('Final answer.'),
      ]);
      const tools = [makeTool()];
      const checkpointer = new MemorySaver();
      const contextManager = makeContextManager();
      const hooks: SupervisedGraphHooks = {
        buildGraph: (t) =>
          buildAgentGraph({
            model,
            checkpointer,
            tools: t,
            interruptAfterTools: true,
          }),
        onEvent: jest.fn(),
        checkTerminalStatus: jest.fn().mockResolvedValue(null),
        holdSpending,
      };
      const result = await runSupervisedGraph({
        agentId: 'agent-1',
        agent: makeAgent(),
        role: makeRole(),
        model,
        allTools: tools,
        initialGraph: hooks.buildGraph(tools),
        input: { messages: [new HumanMessage('Hi')] },
        config: RUN_CONFIG,
        contextManager,
        windowSize: 8192,
        abortController: new AbortController(),
        hooks,
      });
      return { model, contextManager, result };
    }

    it('stops as paused before the first model call — spending nothing, not even on compaction', async () => {
      const { model, contextManager, result } = await runHeldBack(
        jest.fn<Promise<boolean>, []>().mockResolvedValue(true),
      );

      expect(model.invokeCount).toBe(0);
      expect(contextManager.checkBudget).not.toHaveBeenCalled();
      expect(result.terminalStatus).toBe(AgentStatus.Paused);
      expect(result.aborted).toBe(false);
    });

    it('stops at the next iteration boundary when the cap is reached mid-run', async () => {
      const { model, result } = await runHeldBack(
        jest
          .fn<Promise<boolean>, []>()
          .mockResolvedValueOnce(false)
          .mockResolvedValue(true),
      );

      expect(model.invokeCount).toBe(1);
      expect(result.terminalStatus).toBe(AgentStatus.Paused);
    });
  });

  it('stops when complete_task completes the agent mid-run, without a wasted final call', async () => {
    const model = new QueuedChatModel([
      toolCall('complete_task'),
      new AIMessage('Wasted cycle — must not happen.'),
    ]);
    const tools = [makeTool('complete_task')];
    const checkTerminalStatus = jest
      .fn()
      .mockResolvedValue(AgentStatus.Completed);
    const checkpointer = new MemorySaver();

    const hooks: SupervisedGraphHooks = {
      buildGraph: (t) =>
        buildAgentGraph({
          model,
          checkpointer,
          tools: t,
          interruptAfterTools: true,
        }),
      onEvent: jest.fn(),
      checkTerminalStatus,
    };

    const result = await runSupervisedGraph({
      agentId: 'agent-1',
      agent: makeAgent(),
      role: makeRole(),
      model,
      allTools: tools,
      initialGraph: hooks.buildGraph(tools),
      input: { messages: [new HumanMessage('Hi')] },
      config: RUN_CONFIG,
      contextManager: makeContextManager(),
      windowSize: 8192,
      abortController: new AbortController(),
      hooks,
    });

    expect(model.invokeCount).toBe(1);
    expect(result.terminalStatus).toBe(AgentStatus.Completed);
  });

  it('aborts and fails when max iterations is exceeded', async () => {
    const model = new QueuedChatModel([
      toolCall('some_tool'),
      toolCall('some_tool'),
      toolCall('some_tool'),
    ]);
    const tools = [makeTool()];
    const checkpointer = new MemorySaver();
    const abortController = new AbortController();

    const hooks: SupervisedGraphHooks = {
      buildGraph: (t) =>
        buildAgentGraph({
          model,
          checkpointer,
          tools: t,
          interruptAfterTools: true,
          signal: abortController.signal,
        }),
      onEvent: jest.fn(),
      checkTerminalStatus: jest.fn().mockResolvedValue(null),
      maxIterations: 2,
    };

    const result = await runSupervisedGraph({
      agentId: 'agent-1',
      agent: makeAgent(),
      role: makeRole(),
      model,
      allTools: tools,
      initialGraph: hooks.buildGraph(tools),
      input: { messages: [new HumanMessage('Hi')] },
      config: RUN_CONFIG,
      contextManager: makeContextManager(),
      windowSize: 8192,
      abortController,
      hooks,
    });

    expect(result.aborted).toBe(true);
    expect(result.failureReason).toBe('exceeded 2 iterations');
    expect(abortController.signal.aborted).toBe(true);
  });

  it('fails cleanly when context budget is still exceeded before the first model call', async () => {
    const model = new QueuedChatModel([new AIMessage('Unused.')]);
    const contextManager = makeContextManager(() =>
      Promise.resolve({ report: null, stillOverBudget: true }),
    );
    const abortController = new AbortController();

    const hooks: SupervisedGraphHooks = {
      buildGraph: (t) =>
        buildAgentGraph({
          model,
          checkpointer: new MemorySaver(),
          tools: t,
        }),
      onEvent: jest.fn(),
      checkTerminalStatus: jest.fn().mockResolvedValue(null),
    };

    const result = await runSupervisedGraph({
      agentId: 'agent-1',
      agent: makeAgent(),
      role: makeRole(),
      model,
      allTools: [],
      initialGraph: hooks.buildGraph([]),
      input: { messages: [new HumanMessage('Hi')] },
      config: RUN_CONFIG,
      contextManager,
      windowSize: 8192,
      abortController,
      hooks,
    });

    expect(result.aborted).toBe(true);
    expect(result.failureReason).toBe(
      'Context window exceeded even after compaction',
    );
    expect(model.invokeCount).toBe(0);
    expect(abortController.signal.aborted).toBe(true);
  });

  it('recovers from a reactive context-length error by compacting once and retrying', async () => {
    const model = new QueuedChatModel([
      new Error('Context size has been exceeded'),
      new AIMessage('Answer after recompaction.'),
    ]);
    const contextManager = makeContextManager(() =>
      Promise.resolve({ report: null, stillOverBudget: false }),
    );

    const hooks: SupervisedGraphHooks = {
      buildGraph: (t) =>
        buildAgentGraph({
          model,
          checkpointer: new MemorySaver(),
          tools: t,
        }),
      onEvent: jest.fn(),
      checkTerminalStatus: jest.fn().mockResolvedValue(null),
    };

    const result = await runSupervisedGraph({
      agentId: 'agent-1',
      agent: makeAgent(),
      role: makeRole(),
      model,
      allTools: [],
      initialGraph: hooks.buildGraph([]),
      input: { messages: [new HumanMessage('Hi')] },
      config: RUN_CONFIG,
      contextManager,
      windowSize: 8192,
      abortController: new AbortController(),
      hooks,
    });

    expect(model.invokeCount).toBe(2);
    expect(result.lastAiMessage?.content).toBe('Answer after recompaction.');
    expect(result.aborted).toBe(false);
  });

  it('fails cleanly when a context-length error recurs and compaction cannot help', async () => {
    const model = new QueuedChatModel([
      new Error('Context size has been exceeded'),
    ]);
    const contextManager = makeContextManager();
    // First checkBudget call (proactive, pre-stream) reports OK so we
    // actually reach the model call and hit the thrown error; only the
    // reactive retry-check reports still-over-budget.
    contextManager.checkBudget
      .mockResolvedValueOnce({ report: null, stillOverBudget: false })
      .mockResolvedValueOnce({ report: null, stillOverBudget: true });
    const abortController = new AbortController();

    const hooks: SupervisedGraphHooks = {
      buildGraph: (t) =>
        buildAgentGraph({ model, checkpointer: new MemorySaver(), tools: t }),
      onEvent: jest.fn(),
      checkTerminalStatus: jest.fn().mockResolvedValue(null),
    };

    const result = await runSupervisedGraph({
      agentId: 'agent-1',
      agent: makeAgent(),
      role: makeRole(),
      model,
      allTools: [],
      initialGraph: hooks.buildGraph([]),
      input: { messages: [new HumanMessage('Hi')] },
      config: RUN_CONFIG,
      contextManager,
      windowSize: 8192,
      abortController,
      hooks,
    });

    expect(result.aborted).toBe(true);
    expect(result.failureReason).toBe(
      'Context window exceeded even after compaction',
    );
  });

  it('propagates non-context-length errors instead of swallowing them', async () => {
    const model = new QueuedChatModel([new Error('ECONNREFUSED')]);
    const hooks: SupervisedGraphHooks = {
      buildGraph: (t) =>
        buildAgentGraph({ model, checkpointer: new MemorySaver(), tools: t }),
      onEvent: jest.fn(),
      checkTerminalStatus: jest.fn().mockResolvedValue(null),
    };

    await expect(
      runSupervisedGraph({
        agentId: 'agent-1',
        agent: makeAgent(),
        role: makeRole(),
        model,
        allTools: [],
        initialGraph: hooks.buildGraph([]),
        input: { messages: [new HumanMessage('Hi')] },
        config: RUN_CONFIG,
        contextManager: makeContextManager(),
        windowSize: 8192,
        abortController: new AbortController(),
        hooks,
      }),
    ).rejects.toThrow('ECONNREFUSED');
  });

  it('rebuilds the graph when resolveVisibleTools returns a different tool subset between iterations', async () => {
    const model = new QueuedChatModel([
      toolCall('some_tool'),
      new AIMessage('Done.'),
    ]);
    const toolA = makeTool('describe_server');
    const toolB = makeTool('some_tool');
    const checkpointer = new MemorySaver();
    const buildGraph = jest.fn((t: DynamicStructuredTool[]) =>
      buildAgentGraph({
        model,
        checkpointer,
        tools: t,
        interruptAfterTools: true,
      }),
    );
    let resolveCalls = 0;

    const hooks: SupervisedGraphHooks = {
      buildGraph,
      onEvent: jest.fn(),
      checkTerminalStatus: jest.fn().mockResolvedValue(null),
      resolveVisibleTools: () => {
        resolveCalls++;
        // First iteration: only describe_server visible. After the tool
        // call, the full set becomes visible (simulating Phase 6 gating).
        return resolveCalls === 1 ? [toolA] : [toolA, toolB];
      },
    };

    await runSupervisedGraph({
      agentId: 'agent-1',
      agent: makeAgent(),
      role: makeRole(),
      model,
      allTools: [toolA, toolB],
      // Matches what hooks.resolveVisibleTools returns on its first call
      // (resolveCalls === 1, below) — the caller is responsible for building
      // the initial graph with the same tool set the hook will report.
      initialGraph: buildGraph([toolA]),
      input: { messages: [new HumanMessage('Hi')] },
      config: RUN_CONFIG,
      contextManager: makeContextManager(),
      windowSize: 8192,
      abortController: new AbortController(),
      hooks,
    });

    expect(model.invokeCount).toBe(2);
    // Built once up front (by the test, for initialGraph) with [toolA], then
    // rebuilt by the runner with [toolA, toolB] once the visible set changed
    // after the first iteration.
    expect(buildGraph).toHaveBeenCalledTimes(2);
    expect(buildGraph.mock.calls[0][0]).toEqual([toolA]);
    expect(buildGraph.mock.calls[1][0]).toEqual([toolA, toolB]);
  });
});
