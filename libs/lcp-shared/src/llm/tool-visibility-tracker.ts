import type { DynamicStructuredTool } from '@langchain/core/tools';
import type { StreamEventLike } from './stream-event-mapper';

/** Extracts the server-name prefix from a `{serverName}__{toolName}` tool name. */
function serverNameOf(toolName: string): string {
  return toolName.split('__')[0] ?? toolName;
}

/**
 * Tracks which MCP servers' full tool sets should be bound to the model,
 * implementing "describe-then-reveal" tool-schema gating: a server's tools
 * beyond its own `describe_server` stay unbound (and out of the token
 * budget LangChain's `bindTools` sends on every turn) until the agent calls
 * `{server}__describe_server`, at which point the server's other tools
 * become visible for a bounded number of agent-node iterations.
 *
 * State is in-memory only, scoped to one run/turn — not persisted in the
 * LangGraph checkpoint. If a process restart drops it, the agent simply
 * re-describes on the retried run; cheap and acceptable given how rarely
 * that happens.
 *
 * `alwaysVisibleServers` (default: `['interactions']`) are exempt from
 * gating — `request_user_input`/`request_agent_consultation`/`complete_task`
 * are essential control-flow tools that must stay reachable at all times
 * (required-tool-call enforcement reminders name them explicitly and expect
 * them bound), and the server has few enough tools that gating it would
 * save little context anyway.
 */
export class ToolVisibilityTracker {
  private readonly remaining = new Map<string, number>();

  constructor(
    private readonly alwaysVisibleServers: ReadonlySet<string> = new Set([
      'interactions',
    ]),
    // ponytail: 1–3 iterations considered; 3 tolerates a wrong call or two
    // before the agent needs to re-describe. Easy to retune later.
    private readonly ttl = 3,
  ) {}

  /** Feed every stream event here, alongside any other `onEvent` side effects. */
  onEvent(event: StreamEventLike): void {
    if (event.event === 'on_chat_model_start') {
      for (const [server, iterations] of this.remaining) {
        if (iterations <= 1) this.remaining.delete(server);
        else this.remaining.set(server, iterations - 1);
      }
    }
    if (
      event.event === 'on_tool_end' &&
      event.name?.endsWith('__describe_server')
    ) {
      this.remaining.set(serverNameOf(event.name), this.ttl);
    }
  }

  /** Computes the currently-visible tool subset for binding to the model. */
  resolveVisibleTools(
    allTools: DynamicStructuredTool[],
  ): DynamicStructuredTool[] {
    return allTools.filter((tool) => {
      const server = serverNameOf(tool.name);
      if (this.alwaysVisibleServers.has(server)) return true;
      if (tool.name.endsWith('__describe_server')) return true;
      return this.remaining.has(server);
    });
  }
}
