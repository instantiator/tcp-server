import type { DynamicStructuredTool } from '@langchain/core/tools';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import {
  ContextManagerService,
  McpClientService,
  buildAgentGraph,
  buildChatModel,
  resolveMcpServerList,
  resolveMcpServerUrls,
} from '@tcp/shared';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PromptInputs, TurnContext } from './chat-turn-prompt.service';

/** The model, tools and graph one chat turn runs against. */
export interface TurnEnvironment extends PromptInputs {
  graph: ReturnType<typeof buildAgentGraph>;
  buildGraph: (
    tools: DynamicStructuredTool[],
  ) => ReturnType<typeof buildAgentGraph>;
  langchainTools: DynamicStructuredTool[];
  abortController: AbortController;
  runConfig: { configurable: { thread_id: string } };
}

/**
 * Assembles what a chat turn needs before it can take its first step: the MCP
 * tools the agent's company and role entitle it to, the chat model and graph,
 * and the user's message after a context-budget check.
 *
 * The tcp-agent worker has the same job in `AgentRunEnvironmentService`; the
 * difference here is that chat leaves `tool_choice` on auto, so a turn may end
 * with a prose reply rather than a forced tool call.
 */
@Injectable()
export class ChatTurnEnvironmentService {
  private readonly logger = new Logger(ChatTurnEnvironmentService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly contextManager: ContextManagerService,
    private readonly mcp: McpClientService,
  ) {}

  /** Resolves the tools, model, graph and prepared message for a single turn. */
  async assemble(
    ctx: TurnContext,
    checkpointer: PostgresSaver,
  ): Promise<TurnEnvironment> {
    const { agent, role, company, llmConfig, windowSize, isFirstMessage } = ctx;
    const mcpServerUrls = resolveMcpServerUrls(this.config);
    // Additive union: default registry servers, plus any extras from the
    // company and the role (not a precedence chain — every source contributes).
    const mcpServerNames = resolveMcpServerList(
      Object.keys(mcpServerUrls),
      company,
      role,
    );
    const mcpTools = await this.mcp.loadTools(mcpServerNames, mcpServerUrls, {
      agentId: agent.id,
      companyId: agent.companyId,
    });
    const langchainTools = mcpTools.map((t) => t.tool);

    const model = buildChatModel(llmConfig);
    const abortController = new AbortController();
    const buildGraph = (tools: DynamicStructuredTool[]) =>
      buildAgentGraph({
        model,
        checkpointer,
        tools,
        logger: this.logger,
        interruptAfterTools: true,
        signal: abortController.signal,
      });
    // All tools are bound from turn 1 (compact schemas) — no describe-then-
    // reveal gating.
    const graph = buildGraph(langchainTools);
    const runConfig = { configurable: { thread_id: agent.id } };

    // Check context budget and compact if needed before invoking. Compaction
    // writes its own `compaction` audit rows (streamed live); the running
    // transition was already recorded by sendMessage.
    const { message: preparedMessage } = await this.contextManager.prepare(
      agent.id,
      ctx.message,
      model,
      windowSize,
      graph,
      runConfig,
      isFirstMessage,
      agent,
      role,
      langchainTools,
    );

    return {
      preparedMessage,
      model,
      mcpTools,
      mcpServerUrls,
      graph,
      buildGraph,
      langchainTools,
      abortController,
      runConfig,
    };
  }
}
