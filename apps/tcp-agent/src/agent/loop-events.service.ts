import {
  AuditClientService,
  StreamEventLike,
  TcpAgent,
  enrichedAuditForEvent,
  mapStreamDeltas,
} from '@tcp/shared';
import { Injectable } from '@nestjs/common';
import { StorageTrackingClientService } from '../storage-tracking/storage-tracking-client.service';
import { AgentEventPublisherService } from './agent-event-publisher.service';
import {
  AgentLoopTracker,
  applyStorageResult,
  baseToolName,
  extractChatModelText,
  generateActionString,
} from './loop-tracker';

/**
 * Turns the LangGraph event stream into everything the rest of the system sees
 * of a run in flight: audit rows, live SSE token deltas, the action/storage
 * tracker, and the storage-change snapshot pushed back to tcp-server.
 *
 * The loop itself only decides *what* to run; this decides what gets observed.
 */
@Injectable()
export class AgentLoopEventRecorder {
  constructor(
    private readonly auditClient: AuditClientService,
    private readonly storageTracking: StorageTrackingClientService,
    private readonly events: AgentEventPublisherService,
  ) {}

  /**
   * Builds a per-turn `onEvent` handler. `pendingToolInputs` correlates
   * `on_tool_start` inputs to `on_tool_end` outputs by `run_id` — scoped to one
   * supervised turn, so a stale run_id from an earlier turn can never be
   * matched against a later tool result.
   */
  forTurn(
    agent: TcpAgent,
    tracker: AgentLoopTracker,
  ): (event: StreamEventLike) => void {
    // ponytail: actions include failed tool calls; on_tool_start used for simplicity
    const pendingToolInputs = new Map<string, Record<string, unknown>>();

    return (event: StreamEventLike) => {
      // Persist each lifecycle event with an enriched payload (tool name/input/
      // output, response/reasoning text) — the server streams it live. Token
      // deltas are published directly to the agent's Redis channel.
      const audit = enrichedAuditForEvent(event);
      if (audit) {
        this.auditClient.record(
          agent.companyId,
          agent.role.name,
          agent.id,
          audit.eventType,
          audit.payload,
        );
      }
      for (const delta of mapStreamDeltas(event, agent.id)) {
        this.events.publish(delta);
      }

      if (event.event === 'on_chat_model_end') {
        tracker.lastResponseText = extractChatModelText(event.data?.output);
      }

      if (event.event === 'on_tool_start') {
        const input_ = event.data?.input ?? {};
        const runId = event.run_id ?? '';
        pendingToolInputs.set(runId, input_);
        tracker.actions.push(generateActionString(event.name ?? '', input_));
        tracker.firedTools.add(baseToolName(event.name ?? ''));
      }

      if (event.event === 'on_tool_end') {
        const runId = event.run_id ?? '';
        const toolInput = pendingToolInputs.get(runId) ?? {};
        const output = event.data?.output;
        applyStorageResult(event.name ?? '', toolInput, output, tracker);
        pendingToolInputs.delete(runId);
        this.storageTracking.patch(agent.id, tracker.storage);
      }
    };
  }
}
