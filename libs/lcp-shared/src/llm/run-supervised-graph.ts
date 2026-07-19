import { AIMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import type { MessagesAnnotation } from '@langchain/langgraph';
import type { ContextManagerService } from '../context/context-manager.service';
import { AgentStatus } from '../models/LcpAgent.model';
import type { LcpAgent } from '../models/LcpAgent.model';
import type { LcpRole } from '../models/LcpRole.model';
import type { buildAgentGraph } from './build-agent-graph';
import { isContextLengthError } from './context-length-error';
import type { StreamEventLike } from './stream-event-mapper';

/** The graph type returned by {@link buildAgentGraph}. */
export type SupervisedGraph = ReturnType<typeof buildAgentGraph>;

/**
 * App-specific behaviour {@link runSupervisedGraph} delegates to its caller.
 * The runner owns all control flow (abort timing, compaction/tool-visibility
 * retries); hooks only observe events and answer questions the runner can't
 * answer itself (DB status, iteration ceiling, which tools should be bound).
 */
export interface SupervisedGraphHooks {
  /** (Re)builds the compiled graph for the given tool subset. Called once up
   * front and again whenever {@link resolveVisibleTools} returns a different
   * set — must reuse the same checkpointer/thread so state carries over. */
  buildGraph: (tools: DynamicStructuredTool[]) => SupervisedGraph;
  /** Per-event side effects: audit recording, tracker updates, SSE/Redis emit. */
  onEvent: (event: StreamEventLike) => void;
  /** Re-reads the agent's status from the DB. A terminal result (Paused or
   * Completed) stops the run — the caller's pause/resume flow (or a fallback
   * completion path) owns whatever happens next. */
  checkTerminalStatus: () => Promise<AgentStatus | null>;
  /** Agent-loop only: aborts the run once exceeded. Absent (chat turns) means
   * no ceiling is enforced here. */
  maxIterations?: number;
  /** Phase 6 (tool-schema gating): recomputes which tools should be bound for
   * the next iteration. Omit to keep the full tool set bound for the whole run. */
  resolveVisibleTools?: (
    allTools: DynamicStructuredTool[],
  ) => DynamicStructuredTool[];
}

export interface RunSupervisedGraphOptions {
  agentId: string;
  agent: LcpAgent;
  role: LcpRole;
  model: BaseChatModel;
  /** The full tool set loaded for this run (before any visibility gating). */
  allTools: DynamicStructuredTool[];
  /**
   * The already-compiled graph for the first iteration — callers already
   * build one (via the same `buildGraph` passed in `hooks`) to run the
   * pre-turn {@link ContextManagerService.prepare} check, so this reuses it
   * rather than compiling a second, redundant graph. Must be built with
   * `interruptAfterTools: true`. Only rebuilt (via `hooks.buildGraph`) later
   * if `hooks.resolveVisibleTools` reports a changed tool set.
   */
  initialGraph: SupervisedGraph;
  /** Initial graph input — the full initial-state build, or one HumanMessage
   * for a resumed/subsequent turn. */
  input: typeof MessagesAnnotation.State;
  /** Must include `configurable: { thread_id }`. The runner adds `signal`. */
  config: RunnableConfig;
  contextManager: ContextManagerService;
  windowSize: number;
  abortController: AbortController;
  hooks: SupervisedGraphHooks;
}

export interface SupervisedGraphResult {
  lastAiMessage?: AIMessage;
  /** Set when a tool call (e.g. `request_user_input`, `complete_task`) moved
   * the agent to a terminal status mid-run. */
  terminalStatus: AgentStatus | null;
  /** True if the run was aborted (max iterations, or a fatal context-budget failure). */
  aborted: boolean;
  /** Reason string, set only when the run failed (context budget exceeded
   * even after compaction, or max iterations reached). */
  failureReason?: string;
}

/**
 * Runs a LangGraph agent graph to completion (or to a terminal DB status),
 * supervising every tool-loop iteration rather than letting LangGraph's
 * `tools → agent` edge run unattended to the end.
 *
 * The graphs `hooks.buildGraph` returns **must** be compiled with
 * `interruptAfterTools: true` (see {@link buildAgentGraph}) — LangGraph then
 * deterministically halts after every tool-node execution instead of
 * automatically continuing, which is what lets this function check things
 * between iterations at all. Without it, breaking the event-consumption loop
 * does not reliably stop the graph's own internal execution (see ADR-013's
 * amendment notes for the incident this was built to fix).
 *
 * Each iteration:
 * 1. Re-reads agent status (skipped on the very first iteration) — a
 *    terminal result stops the run immediately, before any further model call.
 *    Checked once more, unconditionally, when the graph reaches its natural
 *    end too — a tool call may have moved the agent to a terminal status
 *    without leaving any further pending step for the graph itself to report.
 * 2. Recomputes tool visibility (if `hooks.resolveVisibleTools` is set) and
 *    rebuilds the graph when the bound set changed.
 * 3. Checks context budget; compacts once if over, then fails the run
 *    cleanly if still over budget afterwards.
 * 4. Streams one agent (+ tool, if called) cycle, forwarding every event to
 *    `hooks.onEvent`. A caught context-length-exceeded error triggers the
 *    same compact-once-or-fail path as step 3.
 * 5. If the graph reached its natural end (no more pending steps), returns
 *    with the last AI message. Otherwise loops with a `null` input, resuming
 *    from the interrupt point.
 */
export async function runSupervisedGraph(
  options: RunSupervisedGraphOptions,
): Promise<SupervisedGraphResult> {
  const {
    agentId,
    agent,
    role,
    model,
    allTools,
    config: baseConfig,
    contextManager,
    windowSize,
    abortController,
    hooks,
  } = options;

  const config: RunnableConfig = {
    ...baseConfig,
    signal: abortController.signal,
  };

  let currentTools = hooks.resolveVisibleTools
    ? hooks.resolveVisibleTools(allTools)
    : allTools;
  let graph = options.initialGraph;

  let input: typeof MessagesAnnotation.State | null = options.input;
  let lastAiMessage: AIMessage | undefined;
  let iterations = 0;
  let firstIteration = true;

  while (true) {
    if (!firstIteration) {
      const terminal = await hooks.checkTerminalStatus();
      if (terminal) {
        return { lastAiMessage, terminalStatus: terminal, aborted: false };
      }

      if (hooks.resolveVisibleTools) {
        const nextTools = hooks.resolveVisibleTools(allTools);
        if (!sameTools(nextTools, currentTools)) {
          currentTools = nextTools;
          graph = hooks.buildGraph(currentTools);
        }
      }
    }
    firstIteration = false;

    const budgetCheck = await contextManager.checkBudget(
      agentId,
      model,
      windowSize,
      graph,
      config,
      agent,
      role,
      currentTools,
    );
    if (budgetCheck.stillOverBudget) {
      abortController.abort('context_window_exceeded');
      return {
        lastAiMessage,
        terminalStatus: null,
        aborted: true,
        failureReason: 'Context window exceeded even after compaction',
      };
    }

    try {
      const stream = graph.streamEvents(input, { ...config, version: 'v2' });
      for await (const rawEvent of stream) {
        const event = rawEvent as StreamEventLike;
        hooks.onEvent(event);

        if (event.event === 'on_chat_model_start') {
          iterations++;
          if (hooks.maxIterations && iterations > hooks.maxIterations) {
            abortController.abort('max_iterations');
            return {
              lastAiMessage,
              terminalStatus: null,
              aborted: true,
              failureReason: `exceeded ${hooks.maxIterations} iterations`,
            };
          }
        }

        if (event.event === 'on_chat_model_end') {
          const output = event.data?.output;
          // A streamed run reports its output as an AIMessageChunk, not a
          // plain AIMessage — instanceof AIMessage misses it, but
          // AIMessage.isInstance() recognizes both.
          if (AIMessage.isInstance(output)) {
            lastAiMessage = output;
          }
        }
      }
    } catch (err) {
      if (isContextLengthError(err)) {
        const retry = await contextManager.checkBudget(
          agentId,
          model,
          windowSize,
          graph,
          config,
          agent,
          role,
          currentTools,
        );
        if (retry.stillOverBudget) {
          abortController.abort('context_window_exceeded');
          return {
            lastAiMessage,
            terminalStatus: null,
            aborted: true,
            failureReason: 'Context window exceeded even after compaction',
          };
        }
        // Retry the same input against the now-compacted checkpoint.
        continue;
      }
      throw err;
    }

    const state = await graph.getState(config);
    if (state.next.length === 0) {
      // Graph reached its natural end. Still re-check terminal status once —
      // a tool call earlier in this same pass (or a concurrent resolution,
      // e.g. a racing consultation) may have already moved the agent to a
      // terminal state even though the graph itself has nothing left pending.
      const terminal = await hooks.checkTerminalStatus();
      return { lastAiMessage, terminalStatus: terminal, aborted: false };
    }

    // Interrupted after a tool call — resume from the checkpoint next time
    // round the loop (no new message to inject).
    input = null;
  }
}

/** Shallow comparison of two tool sets by name — order-insensitive. */
function sameTools(
  a: DynamicStructuredTool[],
  b: DynamicStructuredTool[],
): boolean {
  if (a.length !== b.length) return false;
  const names = new Set(a.map((t) => t.name));
  return b.every((t) => names.has(t.name));
}
