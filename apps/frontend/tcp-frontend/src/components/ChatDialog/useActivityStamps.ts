import { useRef } from 'react';

/** What the stamps need to know about an agent. */
interface AgentActivity {
  readonly id: string;
  readonly status: string;
  readonly updatedAt?: string;
}

/**
 * When each agent last did something worth re-sorting the chat list for.
 *
 * Only a status change counts: a message sent (→ running) and a turn finished
 * (→ idle or terminal). Streamed reasoning and tool steps inside a turn don't,
 * so several busy chats don't shuffle under the user (000.06). The first sight
 * of an agent uses its `updatedAt`; live patches don't carry one, so a later
 * status change is stamped with the time it was seen.
 *
 * ponytail: a tool call finishing mid-turn doesn't bump the order; add it if
 * users ask for finer ordering.
 */
export const useActivityStamps = (
  agents: readonly AgentActivity[] | undefined,
): ((agentId: string, fallback: string | undefined) => number) => {
  const seen = useRef(new Map<string, { status: string; at: number }>());

  // Recorded during render: idempotent for an unchanged status, so a second
  // StrictMode render changes nothing.
  for (const agent of agents ?? []) {
    const previous = seen.current.get(agent.id);
    if (previous === undefined) {
      const at =
        agent.updatedAt === undefined ? 0 : Date.parse(agent.updatedAt);
      seen.current.set(agent.id, { status: agent.status, at });
    } else if (previous.status !== agent.status) {
      seen.current.set(agent.id, { status: agent.status, at: Date.now() });
    }
  }

  return (agentId, fallback) =>
    seen.current.get(agentId)?.at ??
    (fallback === undefined ? 0 : Date.parse(fallback));
};
