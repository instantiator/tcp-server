import type { DynamicStructuredTool } from '@langchain/core/tools';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import {
  buildAgentGraph,
  buildChatModel,
  DEFAULT_AGENT_ITERATIONS,
  DEFAULT_AGENT_LOOP_TIMEOUT_MS,
  filterToolsForMode,
  LlmConfig,
  McpClientService,
  resolveEnvLlmConfig,
  resolveLlmConfig,
  resolveMcpServerList,
  resolveMcpServerUrls,
  resolveRunConfig,
  serverNamesForMode,
  TcpAgent,
  TcpAssignment,
} from '@tcp/shared';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentRagService } from '../rag/agent-rag.service';

/** The model and resource ceiling one run must stay inside. */
export interface RunLimits {
  llmConfig: LlmConfig;
  maxIterations: number;
  /** Wall-clock budget for the whole run, after which the abort signal fires. */
  timeoutMs: number;
}

/**
 * Resolves a run's model and resource ceiling in precedence order — role
 * `runConfig` → company `runConfig` → env vars → code defaults. Null when no
 * LLM is configured at any level, which makes the run unstartable.
 */
export function resolveRunLimits(
  agent: TcpAgent,
  config: ConfigService,
): RunLimits | null {
  const llmConfig = resolveLlmConfig(
    agent.role,
    agent.company,
    resolveEnvLlmConfig(config),
  );
  if (!llmConfig) return null;
  return {
    llmConfig,
    maxIterations: resolveRunConfig(
      'maxIterations',
      agent.role,
      agent.company,
      config.get<number>('AGENT_ITERATIONS'),
      DEFAULT_AGENT_ITERATIONS,
    ),
    timeoutMs: resolveRunConfig(
      'timeoutMs',
      agent.role,
      agent.company,
      config.get<number>('AGENT_LOOP_TIMEOUT_MS'),
      DEFAULT_AGENT_LOOP_TIMEOUT_MS,
    ),
  };
}

/** The model, tools and graph one agent run works with. */
export interface RunEnvironment {
  /** The assignment mode driving tool gating (`implement` for orphan agents). */
  mode: TcpAssignment['mode'];
  /** Every MCP server URL configured for this deployment, by server name. */
  mcpServerUrls: Record<string, string>;
  /** The loaded MCP tools, with their originating server names. */
  mcpTools: Awaited<ReturnType<McpClientService['loadTools']>>;
  /** The same tools as LangChain expects them, ready to bind to the model. */
  langchainTools: DynamicStructuredTool[];
  /** Whether the role has indexed knowledge — gates both RAG and the memory server. */
  hasKnowledge: boolean;
  model: ReturnType<typeof buildChatModel>;
  /** The graph bound to the full toolset, built once and reused across turns. */
  graph: ReturnType<typeof buildAgentGraph>;
  /** Rebuilds the graph over a narrower toolset (used by the supervised runner). */
  buildGraph: (
    tools: DynamicStructuredTool[],
  ) => ReturnType<typeof buildAgentGraph>;
}

/**
 * Assembles the tool and model envelope for one agent run: which MCP servers
 * the agent's company, role and assignment mode entitle it to, which of their
 * tools survive the mode filter, and the LangGraph graph bound to them.
 *
 * Kept apart from the loop itself because "what may this agent reach for" is a
 * permissions question answered once per run, before any turn is taken.
 */
@Injectable()
export class AgentRunEnvironmentService {
  private readonly logger = new Logger(AgentRunEnvironmentService.name);

  constructor(
    private readonly rag: AgentRagService,
    private readonly mcp: McpClientService,
    private readonly config: ConfigService,
  ) {}

  /** Resolves the servers, tools, model and graph for a single run. */
  async assemble(
    agent: TcpAgent,
    llmConfig: LlmConfig,
    checkpointer: PostgresSaver,
    abortController: AbortController,
  ): Promise<RunEnvironment> {
    const mode = agent.assignment?.mode ?? 'implement';
    const mcpServerUrls = resolveMcpServerUrls(this.config);
    const hasKnowledge = await this.rag.hasKnowledge(
      agent.role.id,
      agent.company.id,
    );
    const mcpTools = filterToolsForMode(
      await this.mcp.loadTools(
        this.serverNames(agent, mode, mcpServerUrls, hasKnowledge),
        mcpServerUrls,
        { agentId: agent.id, companyId: agent.companyId },
        // A run without a server it needs can't finish its step, so it fails
        // naming the service rather than carrying on without those tools.
        { required: true },
      ),
      mode,
    );
    const langchainTools = mcpTools.map((t) => t.tool);

    const model = buildChatModel(llmConfig);
    // Work modes (plan/implement/qa) MUST end in a tool call, so force one every
    // turn — the weak local model can't then narrate a tool call instead of
    // invoking it. Chat needs to reply in prose, so it stays on `auto`.
    const toolChoice = mode === 'chat' ? undefined : 'required';
    const buildGraph = (tools: DynamicStructuredTool[]) =>
      buildAgentGraph({
        model,
        checkpointer,
        tools,
        logger: this.logger,
        interruptAfterTools: true,
        signal: abortController.signal,
        toolChoice,
      });

    return {
      mode,
      mcpServerUrls,
      mcpTools,
      langchainTools,
      hasKnowledge,
      model,
      // All mode-filtered tools are bound from turn 1 (their schemas are compact,
      // ~1k tokens per mode) — no describe-then-reveal gating, which cost the slow
      // model extra round-trips and let it "forget" a tool after a few iterations.
      graph: buildGraph(langchainTools),
      buildGraph,
    };
  }

  /**
   * The MCP servers this run may contact: an additive union of the default
   * registry, the company's extras and the role's (not a precedence chain —
   * every source contributes), narrowed to what the mode allows and to what
   * there is any point offering.
   */
  private serverNames(
    agent: TcpAgent,
    mode: TcpAssignment['mode'],
    mcpServerUrls: Record<string, string>,
    hasKnowledge: boolean,
  ): string[] {
    // A `plan` agent drops `interactions` entirely (no consultation, no user
    // queries), so it is never even contacted.
    const names = serverNamesForMode(
      resolveMcpServerList(
        Object.keys(mcpServerUrls),
        agent.company,
        agent.role,
      ),
      mode,
    );
    // Don't offer the knowledge (memory) service to a role whose knowledge base
    // is empty — there is nothing for it to search, so it only wastes turns.
    return hasKnowledge ? names : names.filter((n) => n !== 'memory');
  }
}
