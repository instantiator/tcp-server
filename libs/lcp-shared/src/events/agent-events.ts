import { AgentStatus } from '../models/LcpAgent.model';

/**
 * A single observability event describing something happening to one agent
 * during a turn. Streamed to clients over `GET /api/agent/:id/events` (SSE)
 * and, for events originating in the out-of-process lcp-agent worker,
 * carried there over the Redis channel returned by {@link agentEventsChannel}.
 *
 * The union is shared verbatim by lcp-server (producer + relay), lcp-agent
 * (producer), and lcp-cli (consumer) so all three agree on the wire shape.
 */
export type AgentEvent = { timestamp: string } & (
  | {
      /** The agent moved to a new lifecycle state. */
      kind: 'agent_status';
      data: {
        status: AgentStatus;
        /** Why the transition happened, e.g. `'consultation'`, `'resumed'`. */
        reason?: string;
        /** Conversation slug to answer, when the pause awaits user input. */
        conversationSlug?: string;
      };
    }
  | {
      /** The LLM began or finished a request, or ran a tool. */
      kind: 'llm';
      data: {
        activity:
          | 'request_started'
          | 'request_complete'
          | 'tool_started'
          | 'tool_complete';
        /** Tool name, present for `tool_started` / `tool_complete`. */
        tool?: string;
      };
    }
  | {
      /** An incremental fragment of the model's reasoning trace. */
      kind: 'reasoning';
      data: { delta: string };
    }
  | {
      /** An incremental fragment of the model's response content. */
      kind: 'response';
      data: { delta: string };
    }
  | {
      /** The agent paused to consult another agent, which the client may follow. */
      kind: 'consultation_started';
      data: { agentId: string; roleName: string };
    }
  | {
      /** The turn finished; `response` is the final answer text. */
      kind: 'completed';
      data: { response: string };
    }
  | {
      /** The turn failed unrecoverably. */
      kind: 'failed';
      data: { error: string };
    }
  | {
      /** Context compaction lifecycle; payload shape unchanged from before. */
      kind: 'compaction_started' | 'compaction_complete';
      data?: Record<string, unknown>;
    }
);

/** Kinds an {@link AgentEvent} may take. */
export type AgentEventKind = AgentEvent['kind'];

/** Redis pub/sub channel carrying {@link AgentEvent}s for one agent. */
export const agentEventsChannel = (agentId: string): string =>
  `agent:events:${agentId}`;
