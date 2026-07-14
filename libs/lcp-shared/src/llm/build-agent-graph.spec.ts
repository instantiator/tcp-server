import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { z } from 'zod';
import { buildAgentGraph } from './build-agent-graph';

function makeModel(invoke: jest.Mock, bindTools?: jest.Mock): BaseChatModel {
  return { invoke, bindTools } as unknown as BaseChatModel;
}

const RUN_CONFIG = { configurable: { thread_id: 'test-thread' } };

describe('buildAgentGraph', () => {
  it('invokes the model and returns its response when no tools are configured', async () => {
    const invoke = jest.fn().mockResolvedValue(new AIMessage('Hello there.'));
    const graph = buildAgentGraph({
      model: makeModel(invoke),
      checkpointer: new MemorySaver(),
      tools: [],
    });

    const result = await graph.invoke(
      { messages: [new HumanMessage('Hi')] },
      RUN_CONFIG,
    );

    expect(result.messages.at(-1)?.content).toBe('Hello there.');
  });

  it('recovers content from reasoning_content when the model leaves content blank', async () => {
    const invoke = jest.fn().mockResolvedValue(
      new AIMessage({
        content: '',
        additional_kwargs: { reasoning_content: 'The recovered answer.' },
      }),
    );
    const graph = buildAgentGraph({
      model: makeModel(invoke),
      checkpointer: new MemorySaver(),
      tools: [],
    });

    const result = await graph.invoke(
      { messages: [new HumanMessage('Hi')] },
      RUN_CONFIG,
    );

    expect(result.messages.at(-1)?.content).toBe('The recovered answer.');
  });

  it('nudges and re-invokes the model when the first response has no usable content or tool_calls', async () => {
    const invoke = jest
      .fn()
      .mockResolvedValueOnce(
        new AIMessage({
          content: '',
          additional_kwargs: { reasoning_content: 'Still working on it...' },
        }),
      )
      .mockResolvedValueOnce(new AIMessage('The real final answer.'));
    const graph = buildAgentGraph({
      model: makeModel(invoke),
      checkpointer: new MemorySaver(),
      tools: [],
    });

    const result = await graph.invoke(
      { messages: [new HumanMessage('Hi')] },
      RUN_CONFIG,
    );

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(result.messages.at(-1)?.content).toBe('The real final answer.');
  });

  it('binds tools to the model when tools are provided', async () => {
    const boundInvoke = jest
      .fn()
      .mockResolvedValue(new AIMessage('Used a tool.'));
    const bindTools = jest.fn().mockReturnValue(makeModel(boundInvoke));
    const unboundInvoke = jest.fn();

    const graph = buildAgentGraph({
      model: makeModel(unboundInvoke, bindTools),
      checkpointer: new MemorySaver(),
      tools: [{ name: 'some_tool' } as unknown as DynamicStructuredTool],
    });

    await graph.invoke({ messages: [new HumanMessage('Hi')] }, RUN_CONFIG);

    expect(bindTools).toHaveBeenCalledWith([{ name: 'some_tool' }], {});
    expect(boundInvoke).toHaveBeenCalled();
    expect(unboundInvoke).not.toHaveBeenCalled();
  });

  it('forwards tool_choice to bindTools when provided', async () => {
    const bindTools = jest
      .fn()
      .mockReturnValue(
        makeModel(jest.fn().mockResolvedValue(new AIMessage(''))),
      );

    const graph = buildAgentGraph({
      model: makeModel(jest.fn(), bindTools),
      checkpointer: new MemorySaver(),
      tools: [{ name: 'some_tool' } as unknown as DynamicStructuredTool],
      toolChoice: 'required',
    });

    await graph.invoke({ messages: [new HumanMessage('Hi')] }, RUN_CONFIG);

    expect(bindTools).toHaveBeenCalledWith([{ name: 'some_tool' }], {
      tool_choice: 'required',
    });
  });

  it('does not call bindTools when no tools are provided', async () => {
    const invoke = jest.fn().mockResolvedValue(new AIMessage('No tools.'));
    const bindTools = jest.fn();

    const graph = buildAgentGraph({
      model: makeModel(invoke, bindTools),
      checkpointer: new MemorySaver(),
      tools: [],
    });

    await graph.invoke({ messages: [new HumanMessage('Hi')] }, RUN_CONFIG);

    expect(bindTools).not.toHaveBeenCalled();
  });

  it('forwards the abort signal to the model invoke call when provided', async () => {
    const invoke = jest.fn().mockResolvedValue(new AIMessage('Done.'));
    const controller = new AbortController();

    const graph = buildAgentGraph({
      model: makeModel(invoke),
      checkpointer: new MemorySaver(),
      tools: [],
      signal: controller.signal,
    });

    await graph.invoke({ messages: [new HumanMessage('Hi')] }, RUN_CONFIG);

    expect(invoke).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("forwards LangGraph's own run config (e.g. thread_id) into the model invoke call", async () => {
    // Regression: the model invoke must happen inside LangGraph's callback
    // chain (via its config), or on_chat_model_start/end never fire for it —
    // which breaks streamEvents-based audit/completion-detection consumers.
    const invoke = jest.fn().mockResolvedValue(new AIMessage('Done.'));

    const graph = buildAgentGraph({
      model: makeModel(invoke),
      checkpointer: new MemorySaver(),
      tools: [],
    });

    await graph.invoke({ messages: [new HumanMessage('Hi')] }, RUN_CONFIG);

    const [, invokeOptions] = invoke.mock.calls[0] as [
      unknown,
      { configurable?: { thread_id?: string } },
    ];
    expect(invokeOptions.configurable?.thread_id).toBe('test-thread');
  });

  describe('interruptAfterTools', () => {
    function makeTool(): DynamicStructuredTool {
      return new DynamicStructuredTool({
        name: 'some_tool',
        description: 'A tool.',
        schema: z.object({}),
        func: () => Promise.resolve('tool result'),
      });
    }

    it('halts after the tool node instead of automatically re-invoking the model', async () => {
      const boundInvoke = jest.fn().mockResolvedValue(
        new AIMessage({
          content: '',
          tool_calls: [{ name: 'some_tool', args: {}, id: 'call-1' }],
        }),
      );
      const bindTools = jest.fn().mockReturnValue(makeModel(boundInvoke));

      const graph = buildAgentGraph({
        model: makeModel(jest.fn(), bindTools),
        checkpointer: new MemorySaver(),
        tools: [makeTool()],
        interruptAfterTools: true,
      });

      await graph.invoke({ messages: [new HumanMessage('Hi')] }, RUN_CONFIG);

      // The model was invoked exactly once (for the tool call) — LangGraph
      // did not automatically continue tools -> agent on its own.
      expect(boundInvoke).toHaveBeenCalledTimes(1);

      const state = await graph.getState(RUN_CONFIG);
      expect(state.next).toContain('agent');
    });

    it('resumes with a null input and continues to the final answer', async () => {
      const boundInvoke = jest
        .fn()
        .mockResolvedValueOnce(
          new AIMessage({
            content: '',
            tool_calls: [{ name: 'some_tool', args: {}, id: 'call-1' }],
          }),
        )
        .mockResolvedValueOnce(new AIMessage('Final answer after the tool.'));
      const bindTools = jest.fn().mockReturnValue(makeModel(boundInvoke));

      const graph = buildAgentGraph({
        model: makeModel(jest.fn(), bindTools),
        checkpointer: new MemorySaver(),
        tools: [makeTool()],
        interruptAfterTools: true,
      });

      await graph.invoke({ messages: [new HumanMessage('Hi')] }, RUN_CONFIG);
      const result = await graph.invoke(null, RUN_CONFIG);

      expect(boundInvoke).toHaveBeenCalledTimes(2);
      expect(result.messages.at(-1)?.content).toBe(
        'Final answer after the tool.',
      );
      const state = await graph.getState(RUN_CONFIG);
      expect(state.next).toHaveLength(0);
    });

    it('does not interrupt when interruptAfterTools is not set (existing behaviour unchanged)', async () => {
      const boundInvoke = jest
        .fn()
        .mockResolvedValueOnce(
          new AIMessage({
            content: '',
            tool_calls: [{ name: 'some_tool', args: {}, id: 'call-1' }],
          }),
        )
        .mockResolvedValueOnce(new AIMessage('Final answer after the tool.'));
      const bindTools = jest.fn().mockReturnValue(makeModel(boundInvoke));

      const graph = buildAgentGraph({
        model: makeModel(jest.fn(), bindTools),
        checkpointer: new MemorySaver(),
        tools: [makeTool()],
      });

      const result = await graph.invoke(
        { messages: [new HumanMessage('Hi')] },
        RUN_CONFIG,
      );

      expect(boundInvoke).toHaveBeenCalledTimes(2);
      expect(result.messages.at(-1)?.content).toBe(
        'Final answer after the tool.',
      );
    });
  });
});
