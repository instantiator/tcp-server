import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import type {
  BaseCheckpointSaver,
  LangGraphRunnableConfig,
} from '@langchain/langgraph';
import { END, MessagesAnnotation, StateGraph } from '@langchain/langgraph';
import { ToolNode, toolsCondition } from '@langchain/langgraph/prebuilt';
import { Logger } from '@nestjs/common';
import { ReasoningContentRecovery } from './reasoning-content-recovery';

export interface BuildAgentGraphOptions {
  model: BaseChatModel;
  checkpointer: BaseCheckpointSaver;
  tools: DynamicStructuredTool[];
  /** Forwarded to the model's `.invoke()` call so an in-flight request can be cancelled. */
  signal?: AbortSignal;
  logger?: Logger;
  /**
   * When `true` (and tools are present), compiles the graph with
   * `interruptAfter: ['tools']` — LangGraph deterministically halts after
   * every tool-node execution and persists the checkpoint, instead of
   * automatically continuing to the next `agent` invocation. The caller
   * resumes with `graph.streamEvents(null, config)`.
   *
   * This is what {@link runSupervisedGraph} relies on to check context
   * budget, tool visibility, and terminal agent status between every
   * tool-loop iteration — without it, once `streamEvents` starts consuming,
   * LangGraph's own `tools → agent` edge continues the run on its own
   * regardless of whether the external consumer keeps reading events.
   */
  interruptAfterTools?: boolean;
  /**
   * OpenAI-style `tool_choice` forwarded to `bindTools`. Pass `'required'` to
   * force the model to call a tool every turn (used for work modes that must
   * end in a tool call — the model cannot get away with narrating instead of
   * invoking). Omit (or `'auto'`) to let the model choose, as chat needs so it
   * can reply in prose.
   */
  toolChoice?: 'auto' | 'required' | 'none';
}

/**
 * Builds and compiles the LangGraph {@link StateGraph} shared by the chat
 * (tcp-server) and agent-loop (tcp-agent) services.
 *
 * Wires a single `agent` node (LLM invoke) and, when tools are present, a
 * `tools` node ({@link ToolNode}) with a conditional edge from agent → tools
 * or END. When no tools are provided the graph terminates after the first LLM
 * invocation. The compiled graph is bound to the given `checkpointer` so
 * state persists between turns.
 *
 * The `agent` node is also the intervention point for model-specific output
 * quirks — see {@link ReasoningContentRecovery} — so a fix applied here
 * covers both services and is reflected in checkpointed conversation history.
 */
export function buildAgentGraph(options: BuildAgentGraphOptions) {
  const {
    model,
    checkpointer,
    tools,
    signal,
    logger,
    interruptAfterTools,
    toolChoice,
  } = options;
  const boundModel =
    tools.length > 0 && model.bindTools
      ? model.bindTools(tools, toolChoice ? { tool_choice: toolChoice } : {})
      : model;

  const agentNode = async (
    state: typeof MessagesAnnotation.State,
    config: LangGraphRunnableConfig,
  ) => {
    // Forward LangGraph's own config (callbacks, tags, etc.) into the model
    // invoke — without this, the model call happens outside the graph's
    // callback chain and on_chat_model_start/end never fire for it, which
    // breaks anything (audit events, streamEvents-based completion
    // detection) that depends on observing those events.
    const invokeOptions = { ...config, ...(signal ? { signal } : {}) };
    const response = await boundModel.invoke(state.messages, invokeOptions);
    const recovered = await ReasoningContentRecovery.recover(
      state.messages,
      response,
      (messages) => boundModel.invoke(messages, invokeOptions),
      logger,
    );
    return { messages: [recovered] };
  };

  const graphBuilder = new StateGraph(MessagesAnnotation)
    .addNode('agent', agentNode)
    .addEdge('__start__', 'agent');

  if (tools.length > 0) {
    const withTools = graphBuilder
      .addNode('tools', new ToolNode(tools))
      .addConditionalEdges('agent', toolsCondition)
      .addEdge('tools', 'agent');

    return withTools.compile({
      checkpointer,
      ...(interruptAfterTools ? { interruptAfter: ['tools'] } : {}),
    });
  }

  return graphBuilder.addEdge('agent', END).compile({ checkpointer });
}
